import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import {
	assertPrivateDirectory,
	ensurePrivateDirectory,
	readBoundedRegularFile,
	removeRegularFileIfContentsMatch,
	writeExclusiveRegularFile,
} from '../artifacts/secure-io.js'
import { HarnessError } from '../lib/errors.js'
import { isRecord } from '../lib/json.js'

const maxLockBytes = 1_024
const staleRemoteLockMs = 24 * 60 * 60 * 1_000
const maxClaimsPerWorkflow = 128
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const claimFilePattern = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.lock$/i

type WorkflowLockRecord = {
	token: string
	pid: number
	hostname: string
	createdAt: string
}

export type WorkflowLease = {
	release(): Promise<void>
}

export async function acquireWorkflowLease(
	artifactRoot: string,
	workflowId: string,
): Promise<WorkflowLease> {
	if (!uuidPattern.test(workflowId)) {
		throw new HarnessError('INVALID_WORKFLOW_ID', 'Workflow ID must be a UUID')
	}
	const locksRoot = path.join(artifactRoot, 'workflow-locks')
	const lockDirectory = path.join(locksRoot, workflowId)
	await ensurePrivateDirectory(artifactRoot, artifactRoot, { recursive: true })
	await ensurePrivateDirectory(artifactRoot, locksRoot, { recursive: true })
	await ensurePrivateDirectory(artifactRoot, lockDirectory, { recursive: true })
	const record: WorkflowLockRecord = {
		token: randomUUID(),
		pid: process.pid,
		hostname: hostname(),
		createdAt: new Date().toISOString(),
	}
	const contents = Buffer.from(`${JSON.stringify(record)}\n`)
	const lockPath = path.join(lockDirectory, `${record.token}.lock`)
	await writeExclusiveRegularFile(artifactRoot, lockPath, contents)

	try {
		await assertPrivateDirectory(artifactRoot, lockDirectory)
		const names = await readdir(lockDirectory)
		if (names.length > maxClaimsPerWorkflow) {
			throw invalidLease('Workflow lease claim limit exceeded')
		}
		if (!names.includes(path.basename(lockPath))) {
			throw invalidLease('Workflow lease claim disappeared during acquisition')
		}
		const staleClaims: Array<{ path: string, contents: Buffer }> = []
		for (const name of names) {
			const match = claimFilePattern.exec(name)
			if (match === null) {
				throw invalidLease('Workflow lease directory contains an invalid entry')
			}
			const existingPath = path.join(lockDirectory, name)
			const existing = await readLock(artifactRoot, existingPath)
			if (existing === null) {
				continue
			}
			if (existing.record === null || existing.record.token !== match[1]) {
				throw invalidLease('Workflow lease claim is invalid')
			}
			if (existing.record.token === record.token) {
				continue
			}
			if (isLive(existing.record)) {
				throw new HarnessError(
					'WORKFLOW_BUSY',
					'Another process is running this workflow',
					{
						pid: existing.record.pid,
						hostname: existing.record.hostname,
						createdAt: existing.record.createdAt,
					},
				)
			}
			staleClaims.push({ path: existingPath, contents: existing.contents })
		}
		for (const stale of staleClaims) {
			await removeMatchingLock(artifactRoot, stale.path, stale.contents)
		}
		return {
			release: async () => {
				await removeMatchingLock(artifactRoot, lockPath, contents)
			},
		}
	} catch (error) {
		await removeMatchingLock(artifactRoot, lockPath, contents)
		throw error
	}
}

function invalidLease(message: string): HarnessError {
	return new HarnessError('WORKFLOW_BUSY', message, { state: 'invalid_lock' })
}

async function readLock(
	artifactRoot: string,
	lockPath: string,
): Promise<{ contents: Buffer, record: WorkflowLockRecord | null } | null> {
	let contents: Buffer
	try {
		contents = await readBoundedRegularFile(
			artifactRoot,
			lockPath,
			maxLockBytes,
		)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return null
		}
		throw error
	}
	try {
		const value: unknown = JSON.parse(
			new TextDecoder('utf-8', { fatal: true }).decode(contents),
		)
		if (
			!isRecord(value) ||
			Object.keys(value).sort().join(',') !== 'createdAt,hostname,pid,token' ||
			!uuidPattern.test(String(value['token'])) ||
			!Number.isSafeInteger(value['pid']) ||
			(value['pid'] as number) < 1 ||
			typeof value['hostname'] !== 'string' ||
			value['hostname'].length === 0 ||
			value['hostname'].length > 255 ||
			typeof value['createdAt'] !== 'string' ||
			!Number.isFinite(Date.parse(value['createdAt']))
		) {
			return { contents, record: null }
		}
		return { contents, record: value as WorkflowLockRecord }
	} catch {
		return { contents, record: null }
	}
}

async function removeMatchingLock(
	artifactRoot: string,
	lockPath: string,
	contents: Buffer,
): Promise<void> {
	try {
		await removeRegularFileIfContentsMatch(
			artifactRoot,
			lockPath,
			contents,
			maxLockBytes,
		)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error
		}
	}
}

function isLive(record: WorkflowLockRecord): boolean {
	if (record.hostname === hostname()) {
		try {
			process.kill(record.pid, 0)
			return true
		} catch (error) {
			return !hasErrorCode(error, 'ESRCH')
		}
	}
	const createdAt = Date.parse(record.createdAt)
	return Number.isFinite(createdAt) &&
		Date.now() - createdAt <= staleRemoteLockMs
}

function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === code
}
