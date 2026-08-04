import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
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
