import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import {
	assertPrivateDirectory,
	ensurePrivateDirectory,
	readBoundedRegularFile,
	readBoundedPublicationFile,
	removePublicationStagingIfContentsMatch,
	removeRegularFileIfContentsMatch,
	writeExclusiveRegularFile,
} from '../artifacts/secure-io.js'
import { HarnessError } from '../lib/errors.js'
import { isRecord } from '../lib/json.js'
import { reconcileWorkflowEventPublications } from './journal.js'

const maxLockBytes = 1_024
const staleRemoteLockMs = 24 * 60 * 60 * 1_000
const maxClaimsPerWorkflow = 128
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const claimFilePattern = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.lock$/i
const pendingFilePattern = /^\.publish-[0-9a-f-]{36}-([0-9a-f-]{36}\.lock)$/i

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
		const pendingByFinalName = collectPendingClaims(names)
		const staleClaims: Array<{
			path: string
			temporaryPath: string | null
			contents: Buffer
		}> = []
		for (const [finalName, pendingName] of pendingByFinalName) {
			if (names.includes(finalName)) {
				continue
			}
			const pendingPath = path.join(lockDirectory, pendingName)
			const pending = await readLock(artifactRoot, pendingPath)
			const match = claimFilePattern.exec(finalName)
			if (
				pending === null ||
				pending.record === null ||
				match === null ||
				pending.record.token !== match[1]
			) {
				throw invalidLease('Workflow lease staging claim is invalid')
			}
			if (isLive(pending.record)) {
				throw new HarnessError(
					'WORKFLOW_BUSY',
					'Another process is publishing a workflow lease claim',
				)
			}
			await reconcileWorkflowEventPublications(artifactRoot, workflowId)
			await removeMatchingLock(artifactRoot, pendingPath, pending.contents)
		}
		for (const name of names) {
			if (pendingFilePattern.test(name)) {
				continue
			}
			const match = claimFilePattern.exec(name)
			if (match === null) {
				throw invalidLease('Workflow lease directory contains an invalid entry')
			}
			const existingPath = path.join(lockDirectory, name)
			const pendingName = pendingByFinalName.get(name)
			const existing = await readLock(
				artifactRoot,
				existingPath,
				pendingName === undefined
					? undefined
					: path.join(lockDirectory, pendingName),
			)
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
			staleClaims.push({
				path: existingPath,
				temporaryPath: pendingName === undefined
					? null
					: path.join(lockDirectory, pendingName),
				contents: existing.contents,
			})
		}
		if (staleClaims.length > 0) {
			await reconcileWorkflowEventPublications(artifactRoot, workflowId)
		}
		for (const stale of staleClaims) {
			if (stale.temporaryPath !== null) {
				const removed = await removePublicationStagingIfContentsMatch(
					artifactRoot,
					stale.path,
					stale.temporaryPath,
					stale.contents,
					maxLockBytes,
				)
				if (!removed) {
					throw invalidLease('Workflow lease changed during stale recovery')
				}
			}
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
	temporaryPath?: string,
): Promise<{ contents: Buffer, record: WorkflowLockRecord | null } | null> {
	let contents: Buffer
	try {
		contents = temporaryPath === undefined
			? await readBoundedRegularFile(artifactRoot, lockPath, maxLockBytes)
			: await readBoundedPublicationFile(
				artifactRoot,
				lockPath,
				temporaryPath,
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

function collectPendingClaims(names: Array<string>): Map<string, string> {
	const pending = new Map<string, string>()
	for (const name of names) {
		const match = pendingFilePattern.exec(name)
		if (match === null) {
			continue
		}
		const finalName = match[1]
		if (finalName === undefined || pending.has(finalName)) {
			throw invalidLease('Workflow lease staging state is invalid')
		}
		pending.set(finalName, name)
	}
	return pending
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
