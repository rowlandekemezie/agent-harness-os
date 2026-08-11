import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import os, { hostname } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { acquireWorkflowLease } from '../../src/workflow/lease.js'

test('serializes workflow execution and releases only its own lease', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'workflow-lease-'))
	const workflowId = randomUUID()
	const lockDirectory = path.join(
		artifactRoot,
		'workflow-locks',
		workflowId,
	)
	const first = await acquireWorkflowLease(artifactRoot, workflowId)

	await assert.rejects(
		acquireWorkflowLease(artifactRoot, workflowId),
		hasCode('WORKFLOW_BUSY'),
	)
	await first.release()
	assert.deepEqual(await readdir(lockDirectory), [])

	const second = await acquireWorkflowLease(artifactRoot, workflowId)
	await first.release()
	assert.equal((await readdir(lockDirectory)).length, 1)
	await second.release()
	assert.deepEqual(await readdir(lockDirectory), [])
})

test('fails closed on an invalid workflow lease', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'workflow-lease-invalid-'))
	const workflowId = randomUUID()
	const first = await acquireWorkflowLease(artifactRoot, workflowId)
	const lockDirectory = path.join(
		artifactRoot,
		'workflow-locks',
		workflowId,
	)
	await first.release()

	const token = randomUUID()
	const lockPath = path.join(lockDirectory, `${token}.lock`)
	await writeFile(lockPath, '{}\n', { mode: 0o600 })
	await assert.rejects(
		acquireWorkflowLease(artifactRoot, workflowId),
		hasCode('WORKFLOW_BUSY'),
	)
})

test('reclaims a well-formed lease owned by a dead local process', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'workflow-lease-stale-'))
	const workflowId = randomUUID()
	const first = await acquireWorkflowLease(artifactRoot, workflowId)
	await first.release()
	const lockDirectory = path.join(
		artifactRoot,
		'workflow-locks',
		workflowId,
	)
	const token = randomUUID()
	const lockPath = path.join(lockDirectory, `${token}.lock`)
	await writeFile(lockPath, `${JSON.stringify({
		token,
		pid: 2_147_483_647,
		hostname: hostname(),
		createdAt: new Date().toISOString(),
	})}\n`, { mode: 0o600 })

	const reclaimed = await acquireWorkflowLease(artifactRoot, workflowId)
	await reclaimed.release()
	assert.deepEqual(await readdir(lockDirectory), [])
})

test('never grants more than one concurrent workflow claim', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'workflow-lease-race-'))
	const workflowId = randomUUID()
	const results = await Promise.allSettled(
		Array.from({ length: 20 }, async () =>
			await acquireWorkflowLease(artifactRoot, workflowId)
		),
	)
	const acquired = results.flatMap(result =>
		result.status === 'fulfilled' ? [result.value] : []
	)
	assert.ok(acquired.length <= 1)
	if (acquired.length === 0) {
		const retry = await acquireWorkflowLease(artifactRoot, workflowId)
		await retry.release()
	} else {
		await acquired[0]?.release()
	}
})

function hasCode(code: string): (error: unknown) => boolean {
	return error => typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === code
}
