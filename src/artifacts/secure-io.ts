import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { HarnessError } from '../lib/errors.js'

const noFollowFlag = constants.O_NOFOLLOW ?? 0
const directoryFlag = constants.O_DIRECTORY ?? 0
const helperPath = fileURLToPath(new URL('./secure-fs-helper.js', import.meta.url))
const maxHelperErrorBytes = 16_384

type DirectoryIdentity = {
	device: string
	inode: string
}

export async function ensurePrivateDirectory(
	rootPath: string,
	directoryPath: string,
	options: { recursive?: boolean } = {},
): Promise<void> {
	assertPathInside(rootPath, directoryPath)

	try {
		await assertPrivateDirectory(rootPath, directoryPath)
		return
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error
		}
	}

	const missingDirectories = await findMissingDirectories(directoryPath)
	if (missingDirectories.length > 1 && options.recursive !== true) {
		throw Object.assign(new Error('Parent directory does not exist'), {
			code: 'ENOENT',
		})
	}

	for (const missingDirectory of missingDirectories) {
		const parentPath = path.dirname(missingDirectory)
		const identity = await getDirectoryIdentity(parentPath, parentPath)
		await runHelper(parentPath, parentPath, identity, [
			'mkdir',
			path.basename(missingDirectory),
		])
	}

	await assertPrivateDirectory(rootPath, directoryPath)
}

export async function createPrivateDirectory(
	rootPath: string,
	directoryPath: string,
): Promise<void> {
	assertPathInside(rootPath, directoryPath)
	const parentPath = path.dirname(directoryPath)
	const identity = await getDirectoryIdentity(rootPath, parentPath)
	await runHelper(rootPath, parentPath, identity, [
		'mkdir',
		path.basename(directoryPath),
	])
	await assertPrivateDirectory(rootPath, directoryPath)
}

export async function assertPrivateDirectory(
	rootPath: string,
	directoryPath: string,
): Promise<void> {
	assertPathInside(rootPath, directoryPath)
	const handle = await openDirectoryNoFollow(directoryPath)

	try {
		const stats = await assertHandleMatchesPath(
			rootPath,
			directoryPath,
			handle,
			'directory',
		)
		const mode = typeof stats.mode === 'bigint' ? Number(stats.mode) : stats.mode
		if ((mode & 0o077) !== 0) {
			throw new HarnessError(
				'ARTIFACT_PERMISSIONS_INVALID',
				'Artifact directories must not grant group or other permissions',
			)
		}
	} finally {
		await handle.close()
	}
}

export async function readBoundedRegularFile(
	rootPath: string,
	filePath: string,
	maxBytes: number,
): Promise<Buffer> {
	assertPathInside(rootPath, filePath)
	const handle = await open(filePath, constants.O_RDONLY | noFollowFlag)

	try {
		const stats = await assertHandleMatchesPath(
			rootPath,
			filePath,
			handle,
			'file',
		)

		return await readBoundedHandle(handle, stats.size, maxBytes)
	} finally {
		await handle.close()
	}
}

export async function readBoundedPublicationFile(
	rootPath: string,
	filePath: string,
	temporaryPath: string,
	maxBytes: number,
): Promise<Buffer> {
	assertPathInside(rootPath, filePath)
	assertPathInside(rootPath, temporaryPath)
	if (path.dirname(filePath) !== path.dirname(temporaryPath)) {
		throw new HarnessError(
			'ARTIFACT_PATH_INVALID',
			'Publication links must share a directory',
		)
	}

	const finalHandle = await open(filePath, constants.O_RDONLY | noFollowFlag)
	let temporaryHandle: FileHandle | null = null
	try {
		try {
			temporaryHandle = await open(
				temporaryPath,
				constants.O_RDONLY | noFollowFlag,
			)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return await readBoundedRegularFile(rootPath, filePath, maxBytes)
			}
			throw error
		}

		let finalStats: Awaited<ReturnType<FileHandle['stat']>>
		let temporaryStats: Awaited<ReturnType<FileHandle['stat']>>
		try {
			[finalStats, temporaryStats] = await Promise.all([
				assertHandleMatchesPath(rootPath, filePath, finalHandle, 'file', 2),
				assertHandleMatchesPath(
					rootPath,
					temporaryPath,
					temporaryHandle,
					'file',
					2,
				),
			])
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException).code === 'ENOENT' ||
				(error instanceof HarnessError &&
					error.code === 'ARTIFACT_HARD_LINK_DENIED')
			) {
				const [currentFinalStats, currentTemporaryStats] = await Promise.all([
					finalHandle.stat(),
					temporaryHandle.stat(),
				])
				if (
					currentFinalStats.dev === currentTemporaryStats.dev &&
					currentFinalStats.ino === currentTemporaryStats.ino &&
					currentFinalStats.nlink === 1 &&
					currentTemporaryStats.nlink === 1
				) {
					return await readBoundedRegularFile(rootPath, filePath, maxBytes)
				}
			}
			throw error
		}

		if (
			finalStats.dev !== temporaryStats.dev ||
			finalStats.ino !== temporaryStats.ino
		) {
			throw new HarnessError(
				'ARTIFACT_HARD_LINK_DENIED',
				'Publication links must reference the same file',
			)
		}

		return await readBoundedHandle(finalHandle, finalStats.size, maxBytes)
	} finally {
		await Promise.all([
			finalHandle.close(),
			temporaryHandle?.close() ?? Promise.resolve(),
		])
	}
}

export async function writeExclusiveRegularFile(
	rootPath: string,
	filePath: string,
	contents: string | Buffer,
	mode = 0o600,
): Promise<void> {
	assertPathInside(rootPath, filePath)
	const parentPath = path.dirname(filePath)
	const identity = await getDirectoryIdentity(rootPath, parentPath)
	const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents)
	const finalName = path.basename(filePath)
	const temporaryName = `.publish-${randomUUID()}-${finalName}`

	await runHelper(
		rootPath,
		parentPath,
		identity,
		[
			'publish-file',
			finalName,
			temporaryName,
			mode.toString(8),
			buffer.length.toString(),
		],
		buffer,
	)
	const handle = await open(filePath, constants.O_RDONLY | noFollowFlag)
	try {
		await assertHandleMatchesPath(rootPath, filePath, handle, 'file')
	} finally {
		await handle.close()
	}
}

export function assertPathInside(rootPath: string, candidatePath: string): void {
	const relative = path.relative(
		path.resolve(rootPath),
		path.resolve(candidatePath),
	)

	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new HarnessError(
			'ARTIFACT_PATH_INVALID',
			'Artifact path escapes the configured artifact root',
		)
	}
}

async function findMissingDirectories(directoryPath: string): Promise<Array<string>> {
	const missing: Array<string> = []
	let candidate = path.resolve(directoryPath)

	while (true) {
		try {
			await lstat(candidate)
			return missing.reverse()
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error
			}
		}

		missing.push(candidate)
		const parent = path.dirname(candidate)
		if (parent === candidate) {
			throw new HarnessError(
				'ARTIFACT_PATH_INVALID',
				'Artifact directory has no existing ancestor',
			)
		}
		candidate = parent
	}
}

async function getDirectoryIdentity(
	rootPath: string,
	directoryPath: string,
): Promise<DirectoryIdentity> {
	const handle = await openDirectoryNoFollow(directoryPath)

	try {
		const stats = await assertHandleMatchesPath(
			rootPath,
			directoryPath,
			handle,
			'directory',
		)
		return {
			device: stats.dev.toString(),
			inode: stats.ino.toString(),
		}
	} finally {
		await handle.close()
	}
}

async function openDirectoryNoFollow(directoryPath: string): Promise<FileHandle> {
	try {
		return await open(
			directoryPath,
			constants.O_RDONLY | directoryFlag | noFollowFlag,
		)
	} catch (error) {
		if (
			(error as NodeJS.ErrnoException).code !== 'ELOOP' &&
			(error as NodeJS.ErrnoException).code !== 'ENOTDIR'
		) {
			throw error
		}

		const stats = await lstat(directoryPath)
		if (stats.isSymbolicLink()) {
			throw new HarnessError(
				'ARTIFACT_PATH_INVALID',
				'Artifact directory may not be a symbolic link',
			)
		}
		throw new HarnessError(
			'ARTIFACT_FILE_INVALID',
			'Artifact directory path is not a directory',
		)
	}
}

async function assertHandleMatchesPath(
	rootPath: string,
	filePath: string,
	handle: FileHandle,
	expectedKind: 'file' | 'directory',
	expectedLinkCount = 1,
): Promise<Awaited<ReturnType<FileHandle['stat']>>> {
	const [handleStats, pathStats, resolvedRoot, resolvedPath] = await Promise.all([
		handle.stat(),
		lstat(filePath),
		realpath(rootPath),
		realpath(filePath),
	])

	assertPathInside(resolvedRoot, resolvedPath)

	if (
		pathStats.isSymbolicLink() ||
		pathStats.dev !== handleStats.dev ||
		pathStats.ino !== handleStats.ino
	) {
		throw new HarnessError(
			'ARTIFACT_PATH_CHANGED',
			'Artifact path changed while it was being opened',
		)
	}

	const correctKind = expectedKind === 'file'
		? handleStats.isFile()
		: handleStats.isDirectory()

	if (!correctKind) {
		throw new HarnessError(
			'ARTIFACT_FILE_INVALID',
			`Artifact must be a regular ${expectedKind}`,
		)
	}

	if (expectedKind === 'file') {
		if (handleStats.nlink !== expectedLinkCount) {
			throw new HarnessError(
				'ARTIFACT_HARD_LINK_DENIED',
				'Artifact files must have exactly one hard link',
			)
		}
		if ((handleStats.mode & 0o077) !== 0) {
			throw new HarnessError(
				'ARTIFACT_PERMISSIONS_INVALID',
				'Artifact files must not grant group or other permissions',
			)
		}
	}

	return handleStats
}

async function readBoundedHandle(
	handle: FileHandle,
	fileSize: number | bigint,
	maxBytes: number,
): Promise<Buffer> {
	if (
		typeof fileSize === 'bigint'
			? fileSize > BigInt(maxBytes)
			: fileSize > maxBytes
	) {
		throw tooLarge(maxBytes)
	}

	const contents = Buffer.allocUnsafe(maxBytes + 1)
	let offset = 0
	while (offset < contents.length) {
		const result = await handle.read(
			contents,
			offset,
			contents.length - offset,
			offset,
		)
		if (result.bytesRead === 0) {
			break
		}
		offset += result.bytesRead
	}
	if (offset > maxBytes) {
		throw tooLarge(maxBytes)
	}
	return contents.subarray(0, offset)
}

async function runHelper(
	rootPath: string,
	workingDirectory: string,
	identity: DirectoryIdentity,
	argumentsList: Array<string>,
	input?: Buffer,
): Promise<void> {
	const child = spawn(
		process.execPath,
		[helperPath, argumentsList[0] ?? '', identity.device, identity.inode,
			path.resolve(rootPath), path.resolve(workingDirectory),
			...argumentsList.slice(1)],
		{
			cwd: workingDirectory,
			env: {},
			stdio: ['pipe', 'ignore', 'pipe'],
		},
	)
	const errorChunks: Array<Buffer> = []
	let errorBytes = 0
	const inputState: { error: Error | null } = { error: null }

	child.stderr.on('data', (chunk: Buffer) => {
		if (errorBytes >= maxHelperErrorBytes) {
			return
		}
		const remaining = maxHelperErrorBytes - errorBytes
		const bounded = chunk.subarray(0, remaining)
		errorChunks.push(bounded)
		errorBytes += bounded.length
	})
	child.stdin.on('error', (error: Error) => {
		inputState.error = error
	})

	const exitPromise = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>(
		(resolve, reject) => {
			child.once('error', reject)
			child.once('exit', (code, signal) => resolve({ code, signal }))
		},
	)
	child.stdin.end(input)
	const result = await exitPromise

	if (result.code !== 0 || inputState.error !== null) {
		throw new HarnessError(
			'ARTIFACT_WRITE_FAILED',
			'Secure artifact filesystem operation failed',
			{
				cause: Buffer.concat(errorChunks).toString('utf8').trim(),
				inputError: inputState.error?.message ?? null,
				exitCode: result.code,
				signal: result.signal,
			},
		)
	}
}

function tooLarge(maxBytes: number): HarnessError {
	return new HarnessError(
		'ARTIFACT_FILE_TOO_LARGE',
		`Artifact exceeds the ${maxBytes}-byte read limit`,
	)
}
