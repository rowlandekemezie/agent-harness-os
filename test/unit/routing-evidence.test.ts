import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { TaskJournal } from '../../src/artifacts/task-journal.js'
import type { ResolvedPolicy, RunStatus } from '../../src/domain/types.js'
import { RoutingEvidenceStore } from '../../src/provider/routing-evidence.js'

test('projects bounded per-mode routing evidence from validated task events', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'routing-evidence-'))
	const journal = new TaskJournal()
	const first = await appendTask(
		journal,
		artifactRoot,
		'worker-one',
		'completed',
		true,
	)
	const second = await appendTask(
		journal,
		artifactRoot,
		'worker-two',
		'failed',
		false,
	)
	const store = new RoutingEvidenceStore(journal)

	const snapshot = await store.collect({
		artifactRoot,
		repositoryPath: '/tmp/evidence-repository',
		mode: 'implementation',
		workerIds: ['worker-one', 'worker-two'],
		taskLimit: 100,
	})

	assert.equal(snapshot.sampledTaskCount, 2)
	assert.equal(snapshot.sampledAttemptCount, 2)
	assert.match(snapshot.sha256, /^[a-f0-9]{64}$/)
	assert.deepEqual(
		new Map(snapshot.sources.map(source => [source.taskId, source])),
		new Map([first, second].map(source => [source.taskId, source])),
	)
	assert.deepEqual(snapshot.workers, [
		{
			workerId: 'worker-one',
			mode: 'implementation',
			sampleSize: 1,
			successCount: 1,
			evaluationCount: 1,
			evaluationPassCount: 1,
			patchProducedCount: 1,
			patchAppliedCount: 1,
			medianDurationMs: 2_000,
			averageProviderLatencyMs: 1_500,
			averageTotalTokens: 500,
			averageEstimatedCostMicroUsd: 1_234,
		},
		{
			workerId: 'worker-two',
			mode: 'implementation',
			sampleSize: 1,
			successCount: 0,
			evaluationCount: 1,
			evaluationPassCount: 0,
			patchProducedCount: 0,
			patchAppliedCount: 0,
			medianDurationMs: 2_000,
			averageProviderLatencyMs: 1_500,
			averageTotalTokens: 500,
			averageEstimatedCostMicroUsd: 1_234,
		},
	])
})

test('disables evidence reads at a zero task limit and observes cancellation', async function () {
	const journal = new TaskJournal()
	const store = new RoutingEvidenceStore(journal)
	const empty = await store.collect({
		artifactRoot: '/path/that/does/not/exist',
		repositoryPath: '/tmp/evidence-repository',
		mode: 'testing',
		workerIds: [],
		taskLimit: 0,
	})
	assert.equal(empty.sampledAttemptCount, 0)
	assert.deepEqual(empty.sources, [])
	assert.deepEqual(empty.workers, [])

	await assert.rejects(
		store.collect({
			artifactRoot: '/path/that/does/not/exist',
			repositoryPath: '/tmp/evidence-repository',
			mode: 'testing',
			workerIds: [],
			taskLimit: 1,
			signal: AbortSignal.abort(),
		}),
		(error: unknown) =>
			error instanceof DOMException && error.name === 'AbortError',
	)
})

async function appendTask(
	journal: TaskJournal,
	artifactRoot: string,
	workerId: string,
	status: RunStatus,
	producePatch: boolean,
): Promise<{ taskId: string; latestEventSha256: string }> {
	const task = await journal.create({
		artifactRoot,
		objective: `Run ${workerId}.`,
		mode: 'implementation',
		repositoryPath: '/tmp/evidence-repository',
		baseCommit: 'a'.repeat(40),
		policy: createPolicy(),
	})
	const runId = randomUUID()
	await journal.append(artifactRoot, task.taskId, {
		type: 'RouteSelected',
		data: {
			strategy: 'balanced',
			candidateWorkerIds: [workerId],
			maxAttempts: 1,
			evidenceSha256: 'b'.repeat(64),
			evidenceTaskCount: 0,
			evidenceAttemptCount: 0,
			decisionSha256: 'd'.repeat(64),
		},
	})
	await journal.append(artifactRoot, task.taskId, {
		type: 'WorkerStarted',
		data: { runId, workerId, attemptNumber: 1 },
	})
	await journal.append(artifactRoot, task.taskId, {
		type: 'WorkerCompleted',
		data: {
			runId,
			outcome: status === 'completed' ? 'succeeded' : 'failed',
			failureCode: status === 'completed' ? null : 'PROVIDER_FAILED',
			requestCount: 1,
		},
	})
	if (producePatch) {
		await journal.append(artifactRoot, task.taskId, {
			type: 'PatchProduced',
			data: {
				runId,
				patchSha256: 'c'.repeat(64),
				patchBytes: 10,
				changedFileCount: 1,
			},
		})
	}
	await journal.append(artifactRoot, task.taskId, {
		type: 'ValidationCompleted',
		data: { runId, outcome: 'skipped', commandCount: 0 },
	})
	await journal.append(artifactRoot, task.taskId, {
		type: 'EvaluationCompleted',
		data: {
			runId,
			evaluatorIds: ['deterministic-v1'],
			outcome: status === 'completed' ? 'passed' : 'failed',
			evaluationPolicy: 'default',
			failedDimensions: status === 'completed' ? [] : ['worker_execution'],
			unknownDimensions: [],
		},
	})
	await journal.append(artifactRoot, task.taskId, {
		type: 'AttemptCompleted',
		data: {
			runId,
			status,
			failureCode: status === 'completed' ? null : 'PROVIDER_FAILED',
			durationMs: 2_000,
			providerLatencyMs: 1_500,
			totalTokens: 500,
			estimatedCostMicroUsd: 1_234,
		},
	})
	await journal.append(artifactRoot, task.taskId, {
		type: 'TaskCompleted',
		data: { runId, status },
	})
	if (producePatch) {
		await journal.append(artifactRoot, task.taskId, {
			type: 'PatchApplicationRequested',
			data: { runId },
		})
		await journal.append(artifactRoot, task.taskId, {
			type: 'PatchApproved',
			data: { runId, source: 'mcp_call' },
		})
		await journal.append(artifactRoot, task.taskId, {
			type: 'PatchApplied',
			data: { runId, changedFileCount: 1 },
		})
	}
	const timeline = await journal.timeline(artifactRoot, task.taskId)
	return {
		taskId: task.taskId,
		latestEventSha256: timeline.task.latestEventSha256,
	}
}

function createPolicy(): ResolvedPolicy {
	const contents = {
		schemaVersion: 1 as const,
		sources: [],
		maxChangedFiles: 10,
		maxIterations: 4,
		maxTaskSeconds: 60,
		allowNetwork: false,
		prohibitedPaths: [],
		routing: {
			requiredCapabilities: [],
			maxCostTier: null,
			maxLatencyTier: null,
			allowFallback: false,
			maxAttempts: 1,
		},
	}
	return {
		...contents,
		digest: createHash('sha256')
			.update(JSON.stringify(contents))
			.digest('hex'),
	}
}
