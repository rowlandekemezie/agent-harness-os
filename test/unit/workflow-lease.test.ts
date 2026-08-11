import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { link, mkdtemp, readdir, stat, writeFile } from 'node:fs/promises'
import os, { hostname } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import type { WorkflowDefinition, WorkflowWorkerStage } from '../../src/domain/types.js'
import {
	createWorkflowEvent,
	serializeWorkflowEvent,
	workflowEventSha256,
} from '../../src/workflow/event-model.js'
import { WorkflowJournal } from '../../src/workflow/journal.js'
import { acquireWorkflowLease } from '../../src/workflow/lease.js'

const helperPath = fileURLToPath(
	new URL('../../src/artifacts/secure-fs-helper.js', import.meta.url),
)

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

test('reclaims a committed lease with a crash-left publication link', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'workflow-lease-pair-'))
	const workflowId = randomUUID()
	const first = await acquireWorkflowLease(artifactRoot, workflowId)
	await first.release()
	const lockDirectory = path.join(artifactRoot, 'workflow-locks', workflowId)
	const token = randomUUID()
	const finalName = `${token}.lock`
	const lockPath = path.join(lockDirectory, finalName)
	const pendingPath = path.join(
		lockDirectory,
		`.publish-${randomUUID()}-${finalName}`,
	)
	const contents = staleLockContents(token)
	await writeFile(lockPath, contents, { mode: 0o600 })
	await link(lockPath, pendingPath)

	const reclaimed = await acquireWorkflowLease(artifactRoot, workflowId)
	await reclaimed.release()
	assert.deepEqual(await readdir(lockDirectory), [])
})

test('reclaims a crash-left staging-only lease claim', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'workflow-lease-stage-'))
	const workflowId = randomUUID()
	const first = await acquireWorkflowLease(artifactRoot, workflowId)
	await first.release()
	const lockDirectory = path.join(artifactRoot, 'workflow-locks', workflowId)
	const token = randomUUID()
	const finalName = `${token}.lock`
	const pendingPath = path.join(
		lockDirectory,
		`.publish-${randomUUID()}-${finalName}`,
	)
	await writeFile(pendingPath, staleLockContents(token), { mode: 0o600 })

	const reclaimed = await acquireWorkflowLease(artifactRoot, workflowId)
	await reclaimed.release()
	assert.deepEqual(await readdir(lockDirectory), [])
})

test('fences a paused event helper before reclaiming its stale lease', {
	skip: process.platform === 'win32',
}, async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'workflow-lease-fence-'))
	const journal = new WorkflowJournal()
	const created = await journal.create(artifactRoot, workflowDefinition())
	const workflowId = created.summary.workflowId
	const first = await acquireWorkflowLease(artifactRoot, workflowId)
	await first.release()
	const lockDirectory = path.join(artifactRoot, 'workflow-locks', workflowId)
	const token = randomUUID()
	await writeFile(
		path.join(lockDirectory, `${token}.lock`),
		staleLockContents(token),
		{ mode: 0o600 },
	)
	const eventsDirectory = path.join(
		artifactRoot,
		'workflows',
		workflowId,
		'events',
	)
	const identity = await stat(eventsDirectory, { bigint: true })
	const event = createWorkflowEvent(
		workflowId,
		2,
		created.summary.latestEventSha256,
		{
			type: 'WorkflowStageStarted',
			data: {
				stage: 'implement',
				executionId: randomUUID(),
				attemptNumber: 1,
				sourceRunId: null,
			},
		},
	)
	const serializedEvent = serializeWorkflowEvent(event)
	const finalName = `000000000002-${workflowEventSha256(serializedEvent)}.json`
	const temporaryName = `.publish-${randomUUID()}-${finalName}`
	const child = spawn(
		process.execPath,
		[
			helperPath,
			'publish-file',
			identity.dev.toString(),
			identity.ino.toString(),
			artifactRoot,
			eventsDirectory,
			finalName,
			temporaryName,
			'600',
			Buffer.byteLength(serializedEvent).toString(),
		],
		{
			cwd: eventsDirectory,
			env: {},
			stdio: ['pipe', 'pipe', 'ignore', 'ipc'],
		},
	)
	const childStdin = child.stdin
	const childStdout = child.stdout
	assert.ok(childStdin)
	assert.ok(childStdout)
	const prepared = new Promise<void>((resolve, reject) => {
		let output = ''
		child.once('error', reject)
		childStdout.on('data', (chunk: Buffer) => {
			output += chunk.toString('utf8')
			if (output.split('\n').includes('prepared')) {
				resolve()
			}
		})
	})
	childStdin.end(serializedEvent)
	await prepared
	child.kill('SIGSTOP')
	await new Promise<void>((resolve, reject) => {
		child.send('commit', error => error === null ? resolve() : reject(error))
	})
	child.disconnect()

	const reclaimed = await acquireWorkflowLease(artifactRoot, workflowId)
	await journal.append(artifactRoot, workflowId, {
		type: 'WorkflowStageStarted',
		data: {
			stage: 'implement',
			executionId: randomUUID(),
			attemptNumber: 1,
			sourceRunId: null,
		},
	})
	await reclaimed.release()
	child.kill('SIGCONT')
	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.once('error', reject)
		child.once('exit', resolve)
	})
	assert.notEqual(exitCode, 0)
	assert.equal((await journal.timeline(artifactRoot, workflowId)).events.length, 2)
})

test('retains a linked event while reconciling its crash-left staging link', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'workflow-event-pair-'))
	const journal = new WorkflowJournal()
	const created = await journal.create(artifactRoot, workflowDefinition())
	const workflowId = created.summary.workflowId
	const first = await acquireWorkflowLease(artifactRoot, workflowId)
	await first.release()
	const lockDirectory = path.join(artifactRoot, 'workflow-locks', workflowId)
	const token = randomUUID()
	await writeFile(
		path.join(lockDirectory, `${token}.lock`),
		staleLockContents(token),
		{ mode: 0o600 },
	)
	const event = createWorkflowEvent(
		workflowId,
		2,
		created.summary.latestEventSha256,
		{
			type: 'WorkflowStageStarted',
			data: {
				stage: 'implement',
				executionId: randomUUID(),
				attemptNumber: 1,
				sourceRunId: null,
			},
		},
	)
	const serializedEvent = serializeWorkflowEvent(event)
	const finalName = `000000000002-${workflowEventSha256(serializedEvent)}.json`
	const eventsDirectory = path.join(
		artifactRoot,
		'workflows',
		workflowId,
		'events',
	)
	const finalPath = path.join(eventsDirectory, finalName)
	const pendingPath = path.join(
		eventsDirectory,
		`.publish-${randomUUID()}-${finalName}`,
	)
	await writeFile(finalPath, serializedEvent, { mode: 0o600 })
	await link(finalPath, pendingPath)

	const reclaimed = await acquireWorkflowLease(artifactRoot, workflowId)
	await reclaimed.release()
	const names = await readdir(eventsDirectory)
	assert.equal(names.length, 2)
	assert.equal(names.includes(finalName), true)
	assert.equal(names.includes(path.basename(pendingPath)), false)
	assert.equal((await journal.timeline(artifactRoot, workflowId)).events.length, 2)
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

function staleLockContents(token: string): string {
	return `${JSON.stringify({
		token,
		pid: 2_147_483_647,
		hostname: hostname(),
		createdAt: new Date().toISOString(),
	})}\n`
}

function workflowDefinition(): WorkflowDefinition {
	return {
		schemaVersion: 1,
		objective: 'Fence event publication during lease recovery.',
		repositoryPath: '/tmp/workflow-repository',
		baseCommit: 'a'.repeat(40),
		deadlineAt: new Date(Date.now() + 60_000).toISOString(),
		maxTransitions: 8,
		maxRepairAttempts: 0,
		dependencyWorkflowIds: [],
		stages: {
			plan: null,
			implement: workflowStage(),
			test: null,
			review: null,
			repair: null,
		},
	}
}

function workflowStage(): WorkflowWorkerStage {
	return {
		objective: 'Implement the change.',
		allowedPaths: ['src/**'],
		prohibitedPaths: [],
		acceptanceCriteria: [],
		requiredCommands: [],
		maxIterations: 8,
		timeoutSeconds: 60,
		allowNetwork: false,
		routing: {
			preferredWorkerId: null,
			requiredCapabilities: [],
			strategy: 'balanced',
			maxCostTier: null,
			maxLatencyTier: null,
			allowFallback: true,
			maxAttempts: 2,
		},
		retryLimit: 0,
	}
}
