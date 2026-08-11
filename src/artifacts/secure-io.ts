import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { HarnessError } from '../lib/errors.js'

const noFollowFlag = constants.O_NOFOLLOW ?? 0
const directoryFlag = constants.O_DIRECTORY ?? 0
const helperPath = fileURLToPath(new URL('./secure-fs-helper.js', import.meta.url))
const maxHelperErrorBytes = 16_384
const maxPublicationDirectoryEntries = 512
const publicationStagingPattern = /^\.publish-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-(.+)$/i

type DirectoryIdentity = {
	device: string
	inode: string
}

type HelperResult = {
	publicationUncertain: boolean
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

export async function readBoundedPublishedFile(
	rootPath: string,
	filePath: string,
	maxBytes: number,
): Promise<Buffer> {
	const temporaryPath = await findPublicationStagingPath(rootPath, filePath)
	return temporaryPath === null
		? await readBoundedRegularFile(rootPath, filePath, maxBytes)
		: await readBoundedPublicationFile(
			rootPath,
			filePath,
			temporaryPath,
			maxBytes,
		)
}

export async function writeExclusiveRegularFile(
	rootPath: string,
	filePath: string,
	contents: string | Buffer,
	mode = 0o600,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted()
	assertPathInside(rootPath, filePath)
	const parentPath = path.dirname(filePath)
	const identity = await getDirectoryIdentity(rootPath, parentPath)
	const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents)
	const finalName = path.basename(filePath)
	const temporaryName = `.publish-${randomUUID()}-${finalName}`

	const helperResult = await runHelper(
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
		signal,
	)
	if (helperResult.publicationUncertain) {
		await runHelper(rootPath, parentPath, identity, ['sync-directory'])
	}
	let published: Buffer
	try {
		published = await readBoundedPublicationFile(
			rootPath,
			filePath,
			path.join(parentPath, temporaryName),
			buffer.length,
		)
	} catch (error) {
		if (
			helperResult.publicationUncertain &&
			signal?.aborted === true &&
			(error as NodeJS.ErrnoException).code === 'ENOENT'
		) {
			signal.throwIfAborted()
		}
		throw error
	}
	if (!published.equals(buffer)) {
		throw new HarnessError(
			'ARTIFACT_WRITE_FAILED',
			'Published artifact contents do not match the requested write',
		)
	}
}

export async function removeRegularFileIfContentsMatch(
	rootPath: string,
	filePath: string,
	expectedContents: Buffer,
	maxBytes: number,
): Promise<boolean> {
	assertPathInside(rootPath, filePath)
	const handle = await open(filePath, constants.O_RDONLY | noFollowFlag)
	let device: string
	let inode: string
	try {
		const stats = await assertHandleMatchesPath(
			rootPath,
			filePath,
			handle,
			'file',
		)
		const contents = await readBoundedHandle(handle, stats.size, maxBytes)
		if (!contents.equals(expectedContents)) {
			return false
		}
		device = stats.dev.toString()
		inode = stats.ino.toString()
	} finally {
		await handle.close()
	}

	const parentPath = path.dirname(filePath)
	const identity = await getDirectoryIdentity(rootPath, parentPath)
	await runHelper(rootPath, parentPath, identity, [
		'unlink-file',
		path.basename(filePath),
		device,
		inode,
	])
	return true
}

export async function removePublishedFileIfContentsMatch(
	rootPath: string,
	filePath: string,
	expectedContents: Buffer,
	maxBytes: number,
): Promise<boolean> {
	const temporaryPath = await findPublicationStagingPath(rootPath, filePath)
	if (temporaryPath !== null) {
		const removed = await removePublicationStagingIfContentsMatch(
			rootPath,
			filePath,
			temporaryPath,
			expectedContents,
			maxBytes,
		)
		if (!removed) {
			return false
		}
	}

	return await removeRegularFileIfContentsMatch(
		rootPath,
		filePath,
		expectedContents,
		maxBytes,
	)
}

export async function removePublicationStagingIfContentsMatch(
	rootPath: string,
	filePath: string,
	temporaryPath: string,
	expectedContents: Buffer,
	maxBytes: number,
): Promise<boolean> {
	assertPathInside(rootPath, filePath)
	assertPathInside(rootPath, temporaryPath)
	if (path.dirname(filePath) !== path.dirname(temporaryPath)) {
		throw new HarnessError(
			'ARTIFACT_PATH_INVALID',
			'Publication links must share a directory',
		)
	}

	const finalHandle = await open(filePath, constants.O_RDONLY | noFollowFlag)
	const temporaryHandle = await open(
		temporaryPath,
		constants.O_RDONLY | noFollowFlag,
	)
	let device: string
	let inode: string
	try {
		const [finalStats, temporaryStats] = await Promise.all([
			assertHandleMatchesPath(rootPath, filePath, finalHandle, 'file', 2),
			assertHandleMatchesPath(
				rootPath,
				temporaryPath,
				temporaryHandle,
				'file',
				2,
			),
		])
		if (
			finalStats.dev !== temporaryStats.dev ||
			finalStats.ino !== temporaryStats.ino
		) {
			throw new HarnessError(
				'ARTIFACT_HARD_LINK_DENIED',
				'Publication links must reference the same file',
			)
		}
		const contents = await readBoundedHandle(
			finalHandle,
			finalStats.size,
			maxBytes,
		)
		if (!contents.equals(expectedContents)) {
			return false
		}
		device = finalStats.dev.toString()
		inode = finalStats.ino.toString()
	} finally {
		await Promise.all([finalHandle.close(), temporaryHandle.close()])
	}

	const parentPath = path.dirname(filePath)
	const identity = await getDirectoryIdentity(rootPath, parentPath)
	await runHelper(rootPath, parentPath, identity, [
		'unlink-file',
		path.basename(temporaryPath),
		device,
		inode,
		'2',
	])
	return true
}

async function findPublicationStagingPath(
	rootPath: string,
	filePath: string,
): Promise<string | null> {
	assertPathInside(rootPath, filePath)
	const parentPath = path.dirname(filePath)
	await assertPrivateDirectory(rootPath, parentPath)
	const entries = await readdir(parentPath, { withFileTypes: true })
	if (entries.length > maxPublicationDirectoryEntries) {
		throw new HarnessError(
			'ARTIFACT_TRAVERSAL_LIMIT',
			'Artifact directory contains too many entries',
		)
	}
	const fileName = path.basename(filePath)
	const matching = entries.filter(entry => {
		const match = publicationStagingPattern.exec(entry.name)
		return match !== null && match[1] === fileName
	})
	if (matching.length > 1) {
		throw new HarnessError(
			'ARTIFACT_HARD_LINK_DENIED',
			'Artifact has multiple publication staging links',
		)
	}
	if (matching.length === 0) {
		return null
	}
	if (matching[0]?.isFile() !== true) {
		throw new HarnessError(
			'ARTIFACT_FILE_INVALID',
			'Artifact publication staging entry is not a regular file',
		)
	}
	return path.join(parentPath, matching[0].name)
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
	signal?: AbortSignal,
): Promise<HelperResult> {
	signal?.throwIfAborted()
	const operation = argumentsList[0]
	const child = spawn(
		process.execPath,
		[helperPath, argumentsList[0] ?? '', identity.device, identity.inode,
			path.resolve(rootPath), path.resolve(workingDirectory),
			...argumentsList.slice(1)],
		{
			cwd: workingDirectory,
			env: {},
			stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
		},
	)
	const errorChunks: Array<Buffer> = []
	let errorBytes = 0
	const inputState: { error: Error | null } = { error: null }
	const controlState: { error: Error | null } = { error: null }
	const helperStdin = child.stdin
	const helperStdout = child.stdout
	const helperStderr = child.stderr
	if (helperStdin === null || helperStdout === null || helperStderr === null) {
		child.kill('SIGTERM')
		throw new HarnessError(
			'ARTIFACT_WRITE_FAILED',
			'Secure artifact helper pipes were not created',
		)
	}
	let helperOutput = ''
	let publicationCommitGranted = false
	let publicationAcknowledged = false

	function handleAbort(): void {
		if (!publicationAcknowledged) {
			child.kill('SIGTERM')
		}
	}

	function commitPublication(): void {
		if (operation !== 'publish-file' || publicationCommitGranted) {
			controlState.error = new Error('Secure artifact helper sent an invalid preparation signal')
			child.kill('SIGTERM')
			return
		}
		if (signal?.aborted === true) {
			handleAbort()
			return
		}

		try {
			child.send('commit', error => {
				if (error !== null) {
					controlState.error = error
					child.kill('SIGTERM')
				}
			})
			publicationCommitGranted = true
		} catch (error) {
			controlState.error = error instanceof Error ? error : new Error(String(error))
			child.kill('SIGTERM')
		}
	}

	helperStdout.on('data', (chunk: Buffer) => {
		helperOutput += chunk.toString('utf8')
		while (true) {
			const lineEnd = helperOutput.indexOf('\n')
			if (lineEnd === -1) {
				break
			}
			const line = helperOutput.slice(0, lineEnd)
			helperOutput = helperOutput.slice(lineEnd + 1)
			if (line === 'prepared') {
				commitPublication()
			} else if (line === 'committed') {
				if (!publicationCommitGranted || publicationAcknowledged) {
					controlState.error = new Error(
						'Secure artifact helper sent an invalid commit acknowledgment',
					)
					child.kill('SIGTERM')
					continue
				}
				publicationAcknowledged = true
				signal?.removeEventListener('abort', handleAbort)
			}
		}
	})

	helperStderr.on('data', (chunk: Buffer) => {
		if (errorBytes >= maxHelperErrorBytes) {
			return
		}
		const remaining = maxHelperErrorBytes - errorBytes
		const bounded = chunk.subarray(0, remaining)
		errorChunks.push(bounded)
		errorBytes += bounded.length
	})
	helperStdin.on('error', (error: Error) => {
		inputState.error = error
	})
	signal?.addEventListener('abort', handleAbort, { once: true })
	if (signal?.aborted === true) {
		handleAbort()
	}

	const exitPromise = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>(
		(resolve, reject) => {
			child.once('error', reject)
			child.once('close', (code, signal) => resolve({ code, signal }))
		},
	)
	helperStdin.end(input)
	const result = await exitPromise
	signal?.removeEventListener('abort', handleAbort)
	if (
		operation === 'publish-file' &&
		publicationAcknowledged &&
		inputState.error === null &&
		controlState.error === null
	) {
		return { publicationUncertain: false }
	}
	if (signal?.aborted === true && !publicationAcknowledged) {
		if (operation === 'publish-file' && publicationCommitGranted) {
			return { publicationUncertain: true }
		}
		signal.throwIfAborted()
	}

	if (
		result.code !== 0 ||
		inputState.error !== null ||
		controlState.error !== null ||
		(operation === 'publish-file' && !publicationAcknowledged)
	) {
		throw new HarnessError(
			'ARTIFACT_WRITE_FAILED',
			'Secure artifact filesystem operation failed',
			{
				cause: Buffer.concat(errorChunks).toString('utf8').trim(),
				inputError: inputState.error?.message ?? null,
				controlError: controlState.error?.message ?? null,
				exitCode: result.code,
				signal: result.signal,
			},
		)
	}
	return { publicationUncertain: false }
}

function tooLarge(maxBytes: number): HarnessError {
	return new HarnessError(
		'ARTIFACT_FILE_TOO_LARGE',
		`Artifact exceeds the ${maxBytes}-byte read limit`,
	)
}
