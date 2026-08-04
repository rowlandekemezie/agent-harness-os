import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import {
	mkdir,
	open,
	readFile,
	rename,
	rm,
	stat,
	unlink,
} from 'node:fs/promises'
import path from 'node:path'
import { HarnessError } from './errors.js'

export type RepositoryLease = {
	release(): Promise<void>
}

type LockRecord = {
	token: string
	pid: number
	hostname: string
	createdAt: string
}

type LockState = {
	record: LockRecord | null
	modifiedAtMs: number
}

const staleLockMs = 24 * 60 * 60 * 1000
const incompleteLockGraceMs = 30_000
const maxAcquireAttempts = 5

export async function acquireRepositoryLease(
	artifactRoot: string,
): Promise<RepositoryLease> {
	await mkdir(artifactRoot, { recursive: true, mode: 0o700 })
	const lockPath = path.join(artifactRoot, '.repository.lock')
	const record: LockRecord = {
		token: randomUUID(),
		pid: process.pid,
		hostname: hostname(),
		createdAt: new Date().toISOString(),
	}

	for (let attempt = 0; attempt < maxAcquireAttempts; attempt += 1) {
		try {
			const handle = await open(lockPath, 'wx', 0o600)

			try {
				await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
				await handle.sync()
			} catch (error) {
				await handle.close().catch(() => undefined)
				await unlink(lockPath).catch(() => undefined)
				throw error
			}

			await handle.close()

			return {
				release: async () => {
					await releaseIfOwned(lockPath, record.token)
				},
			}
		} catch (error) {
			if (!isAlreadyExistsError(error)) {
				throw error
			}

			const existing = await readLockState(lockPath)

			if (isLiveLockState(existing)) {
				throw new HarnessError(
					'REPOSITORY_BUSY',
					'Another agent-harness process is operating on this repository',
					existing.record === null
						? { state: 'initializing' }
						: {
							pid: existing.record.pid,
							hostname: existing.record.hostname,
							createdAt: existing.record.createdAt,
						},
				)
			}

			await reclaimStaleLock(lockPath)
		}
	}

	throw new HarnessError(
		'REPOSITORY_BUSY',
		'Unable to acquire the repository lease after reclaim attempts',
	)
}

async function reclaimStaleLock(lockPath: string): Promise<void> {
	const quarantinePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`

	try {
		await rename(lockPath, quarantinePath)
	} catch (error) {
		if (isMissingFileError(error)) {
			return
		}

		throw error
	}

	await rm(quarantinePath, { force: true })
}

async function releaseIfOwned(lockPath: string, token: string): Promise<void> {
	const existing = await readLockRecord(lockPath)

	if (existing === null || existing.token !== token) {
		return
	}

	await unlink(lockPath).catch(error => {
		if (!isMissingFileError(error)) {
			throw error
		}
	})
}

async function readLockState(lockPath: string): Promise<LockState> {
	try {
		const [record, fileStats] = await Promise.all([
			readLockRecord(lockPath),
			stat(lockPath),
		])
		return { record, modifiedAtMs: fileStats.mtimeMs }
	} catch (error) {
		if (isMissingFileError(error)) {
			return { record: null, modifiedAtMs: 0 }
		}

		throw error
	}
}

async function readLockRecord(lockPath: string): Promise<LockRecord | null> {
	try {
		const value: unknown = JSON.parse(await readFile(lockPath, 'utf8'))

		if (
			typeof value === 'object' &&
			value !== null &&
			'token' in value &&
			'pid' in value &&
			'hostname' in value &&
			'createdAt' in value &&
			typeof value.token === 'string' &&
			typeof value.pid === 'number' &&
			typeof value.hostname === 'string' &&
			typeof value.createdAt === 'string'
		) {
			return value as LockRecord
		}

		return null
	} catch (error) {
		if (isMissingFileError(error) || error instanceof SyntaxError) {
			return null
		}

		throw error
	}
}

function isLiveLockState(state: LockState): boolean {
	if (state.record === null) {
		return Date.now() - state.modifiedAtMs <= incompleteLockGraceMs
	}

	return isLiveLock(state.record)
}

function isLiveLock(record: LockRecord): boolean {
	if (record.hostname === hostname()) {
		try {
			process.kill(record.pid, 0)
			return true
		} catch (error) {
			return !isNoSuchProcessError(error)
		}
	}

	const createdAtMs = Date.parse(record.createdAt)
	return (
		Number.isFinite(createdAtMs) &&
		Date.now() - createdAtMs <= staleLockMs
	)
}

function isAlreadyExistsError(error: unknown): boolean {
	return hasErrorCode(error, 'EEXIST')
}

function isMissingFileError(error: unknown): boolean {
	return hasErrorCode(error, 'ENOENT')
}

function isNoSuchProcessError(error: unknown): boolean {
	return hasErrorCode(error, 'ESRCH')
}

function hasErrorCode(error: unknown, code: string): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === code
	)
}
