import { constants } from 'node:fs'
import {
	link,
	mkdir,
	open,
	realpath,
	rmdir,
	stat,
	unlink,
} from 'node:fs/promises'
import path from 'node:path'

const noFollowFlag = constants.O_NOFOLLOW ?? 0
const directoryFlag = constants.O_DIRECTORY ?? 0

await main()

async function main(): Promise<void> {
	const [
		operation,
		expectedDevice,
		expectedInode,
		expectedRootPath,
		expectedDirectoryPath,
		...argumentsList
	] =
		process.argv.slice(2)

	if (
		operation === undefined ||
		expectedDevice === undefined ||
		expectedInode === undefined ||
		expectedRootPath === undefined ||
		expectedDirectoryPath === undefined
	) {
		throw new Error('Secure filesystem helper received incomplete arguments')
	}

	const destination = {
		expectedDevice,
		expectedInode,
		expectedRootPath,
		expectedDirectoryPath,
	}
	await assertWorkingDirectory(destination)
	process.stdout.write('ready\n')

	switch (operation) {
		case 'mkdir':
			await createDirectory(requireName(argumentsList[0]), destination)
			return
		case 'publish-file':
			await publishFile(
				requireName(argumentsList[0]),
				requireName(argumentsList[1]),
				parseMode(argumentsList[2]),
				parseByteCount(argumentsList[3]),
				destination,
			)
			return
		case 'unlink-file':
			await removeFile(
				requireName(argumentsList[0]),
				requireValue(argumentsList[1]),
				requireValue(argumentsList[2]),
				destination,
			)
			return
		default:
			throw new Error('Secure filesystem helper received an unknown operation')
	}
}

async function removeFile(
	name: string,
	expectedDevice: string,
	expectedInode: string,
	destination: DestinationIdentity,
): Promise<void> {
	await assertWorkingDirectory(destination)
	const handle = await open(name, constants.O_RDONLY | noFollowFlag)
	try {
		const fileStats = await handle.stat({ bigint: true })
		if (
			!fileStats.isFile() ||
			fileStats.nlink !== 1n ||
			fileStats.dev.toString() !== expectedDevice ||
			fileStats.ino.toString() !== expectedInode
		) {
			throw new Error('Artifact file identity changed before removal')
		}
	} finally {
		await handle.close()
	}
	await assertWorkingDirectory(destination)
	await unlink(name)
	await assertWorkingDirectory(destination)
	await syncWorkingDirectory()
}

type DestinationIdentity = {
	expectedDevice: string,
	expectedInode: string,
	expectedRootPath: string
	expectedDirectoryPath: string
}

async function assertWorkingDirectory(
	destination: DestinationIdentity,
): Promise<void> {
	const [current, expected, resolvedRoot, resolvedDirectory] = await Promise.all([
		stat('.', { bigint: true }),
		stat(destination.expectedDirectoryPath, { bigint: true }),
		realpath(destination.expectedRootPath),
		realpath(destination.expectedDirectoryPath),
	])
	const relative = path.relative(resolvedRoot, resolvedDirectory)

	if (
		!current.isDirectory() ||
		!expected.isDirectory() ||
		current.dev.toString() !== destination.expectedDevice ||
		current.ino.toString() !== destination.expectedInode ||
		expected.dev !== current.dev ||
		expected.ino !== current.ino ||
		relative.startsWith('..') ||
		path.isAbsolute(relative)
	) {
		throw new Error('Working directory identity changed before mutation')
	}
}

async function createDirectory(
	name: string,
	destination: DestinationIdentity,
): Promise<void> {
	await assertWorkingDirectory(destination)
	await mkdir(name, { mode: 0o700 })
	const handle = await open(
		name,
		constants.O_RDONLY | directoryFlag | noFollowFlag,
	)

	try {
		const fileStats = await handle.stat()
		if (!fileStats.isDirectory()) {
			throw new Error('Created artifact entry is not a directory')
		}
		await handle.chmod(0o700)
		await handle.sync()
	} finally {
		await handle.close()
	}

	try {
		await assertWorkingDirectory(destination)
		await syncWorkingDirectory()
	} catch (error) {
		await rmdir(name).catch(() => undefined)
		throw error
	}
}

async function publishFile(
	finalName: string,
	temporaryName: string,
	mode: number,
	expectedBytes: number,
	destination: DestinationIdentity,
): Promise<void> {
	const contents = await readStandardInput(expectedBytes)
	await assertWorkingDirectory(destination)
	const handle = await open(
		temporaryName,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_EXCL |
			noFollowFlag,
		mode,
	)
	let temporaryStats: Awaited<ReturnType<typeof handle.stat>> | null = null

	try {
		temporaryStats = await handle.stat()
		if (!temporaryStats.isFile() || temporaryStats.nlink !== 1) {
			throw new Error('Temporary artifact entry is not a single-link file')
		}
		await handle.chmod(mode)
		await handle.writeFile(contents)
		await handle.sync()
	} finally {
		await handle.close()
	}

	let finalLinked = false
	try {
		const commit = waitForPublicationCommit()
		process.stdout.write('prepared\n')
		await commit
		await assertWorkingDirectory(destination)
		await link(temporaryName, finalName)
		finalLinked = true
		await unlink(temporaryName)
		await assertWorkingDirectory(destination)
		const publishedHandle = await open(
			finalName,
			constants.O_RDONLY | noFollowFlag,
		)

		try {
			const publishedStats = await publishedHandle.stat()
			if (
				temporaryStats === null ||
				!publishedStats.isFile() ||
				publishedStats.nlink !== 1 ||
				publishedStats.dev !== temporaryStats.dev ||
				publishedStats.ino !== temporaryStats.ino
			) {
				throw new Error('Published artifact identity does not match its staging file')
			}
		} finally {
			await publishedHandle.close()
		}
		await syncWorkingDirectory()
	} catch (error) {
		await unlink(temporaryName).catch(() => undefined)
		if (finalLinked) {
			await unlink(finalName).catch(() => undefined)
		}
		throw error
	}
}

async function waitForPublicationCommit(): Promise<void> {
	if (typeof process.send !== 'function') {
		throw new Error('Secure filesystem helper requires a commit channel')
	}

	await new Promise<void>((resolve, reject) => {
		function cleanup(): void {
			process.removeListener('message', handleMessage)
			process.removeListener('disconnect', handleDisconnect)
		}

		function handleMessage(message: unknown): void {
			cleanup()
			if (message !== 'commit') {
				reject(new Error('Secure filesystem helper received an invalid commit decision'))
				return
			}
			resolve()
		}

		function handleDisconnect(): void {
			cleanup()
			reject(new Error('Secure filesystem helper commit channel closed'))
		}

		process.once('message', handleMessage)
		process.once('disconnect', handleDisconnect)
	})
}

async function readStandardInput(expectedBytes: number): Promise<Buffer> {
	const chunks: Array<Buffer> = []
	let totalBytes = 0

	for await (const chunk of process.stdin) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
		totalBytes += buffer.length
		if (totalBytes > expectedBytes) {
			throw new Error('Artifact input exceeds its declared byte count')
		}
		chunks.push(buffer)
	}

	if (totalBytes !== expectedBytes) {
		throw new Error('Artifact input does not match its declared byte count')
	}

	return Buffer.concat(chunks, totalBytes)
}

async function syncWorkingDirectory(): Promise<void> {
	const directory = await open('.', constants.O_RDONLY | directoryFlag)
	try {
		await directory.sync()
	} finally {
		await directory.close()
	}
}

function requireName(value: string | undefined): string {
	const name = requireValue(value)
	if (
		name === '.' ||
		name === '..' ||
		name.includes('/') ||
		name.includes('\\') ||
		name.includes('\0') ||
		Buffer.byteLength(name, 'utf8') > 240
	) {
		throw new Error('Artifact entry name is invalid')
	}
	return name
}

function requireValue(value: string | undefined): string {
	if (value === undefined || value === '') {
		throw new Error('Secure filesystem helper argument is missing')
	}
	return value
}

function parseMode(value: string | undefined): number {
	const mode = Number.parseInt(requireValue(value), 8)
	if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
		throw new Error('Artifact file mode is invalid')
	}
	return mode
}

function parseByteCount(value: string | undefined): number {
	const count = Number.parseInt(requireValue(value), 10)
	if (!Number.isSafeInteger(count) || count < 0 || count > 20_000_000) {
		throw new Error('Artifact byte count is invalid')
	}
	return count
}
