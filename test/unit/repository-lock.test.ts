import assert from 'node:assert/strict'
import { access, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { acquireRepositoryLease } from '../../src/lib/repository-lock.js'

function hasHarnessCode(code: string): (error: unknown) => boolean {
	return error => (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === code
	)
}

test('serializes repository operations across service instances', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-lock-'))
	const firstLease = await acquireRepositoryLease(artifactRoot)

	await assert.rejects(
		acquireRepositoryLease(artifactRoot),
		hasHarnessCode('REPOSITORY_BUSY'),
	)

	await firstLease.release()
	const nextLease = await acquireRepositoryLease(artifactRoot)
	await nextLease.release()
})

test('atomically reclaims a stale lock from another host', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-stale-lock-'))
	const lockPath = path.join(artifactRoot, '.repository.lock')
	await writeFile(
		lockPath,
		`${JSON.stringify({
			token: 'stale-token',
			pid: 1,
			hostname: 'stale-remote-host.invalid',
			createdAt: '2000-01-01T00:00:00.000Z',
		})}\n`,
		{ encoding: 'utf8', mode: 0o600 },
	)

	const lease = await acquireRepositoryLease(artifactRoot)
	await lease.release()
	await assert.rejects(access(lockPath))
})

test('does not reclaim a fresh incomplete lock', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-fresh-lock-'))
	await writeFile(
		path.join(artifactRoot, '.repository.lock'),
		'',
		{ encoding: 'utf8', mode: 0o600 },
	)

	await assert.rejects(
		acquireRepositoryLease(artifactRoot),
		hasHarnessCode('REPOSITORY_BUSY'),
	)
})
