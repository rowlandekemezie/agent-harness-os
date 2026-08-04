import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { mkdir, open, readFile, unlink } from 'node:fs/promises'
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

const staleLockMs = 24 * 60 * 60 * 1000

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

	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const handle = await open(lockPath, 'wx', 0o600)
			await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
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

			const existing = await readLockRecord(lockPath)

			if (existing !== null && isLiveLock(existing)) {
				throw new HarnessError(
					'REPOSITORY_BUSY',
					'Another agent-harness process is operating on this repository',
					{
						pid: existing.pid,
						hostname: existing.hostname,
						createdAt: existing.createdAt,
					},
				)
			}

			await unlink(lockPath).catch(unlinkError => {
				if (!isMissingFileError(unlinkError)) {
					throw unlinkError
				}
			})
		}
	}

	throw new HarnessError(
		'REPOSITORY_BUSY',
		'Unable to acquire the repository lease',
	)
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
		if (isMissingFileError(error)) {
			return null
		}

		return null
	}
}

function isLiveLock(record: LockRecord): boolean {
	const createdAtMs = Date.parse(record.createdAt)

	if (!Number.isFinite(createdAtMs) || Date.now() - createdAtMs > staleLockMs) {
		return false
	}

	if (record.hostname !== hostname()) {
		return true
	}

	try {
		process.kill(record.pid, 0)
		return true
	} catch (error) {
		return !isNoSuchProcessError(error)
	}
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
