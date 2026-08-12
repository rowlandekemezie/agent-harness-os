import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { TaskJournal } from '../../src/artifacts/task-journal.js'
import { loadConfig, resolveArtifactRoot } from '../../src/config.js'
import type {
	ResolvedPolicy,
	WorkflowDefinition,
	WorkflowTaskProvenance,
	WorkflowWorkerStage,
} from '../../src/domain/types.js'
import { ObservabilityService } from '../../src/observability/service.js'
import { resolveRepositoryRoot } from '../../src/git/repository.js'
import { WorkflowJournal } from '../../src/workflow/journal.js'
import {
	createWorkflowTaskProvenance,
} from '../../src/workflow/provenance.js'
import { createTestRepository } from '../helpers/git.js'

test('projects paged model, tool, validation, evaluation, and patch spans', async function () {
	const fixture = await createFixture()
	const task = await createObservedTask(fixture, {
		workers: ['worker-one'],
		attempts: [{
			workerId: 'worker-one',
			status: 'completed',
			costMicroUsd: 25,
			withPatch: true,
			withTool: true,
			clockSkew: true,
		}],
		applyPatch: true,
	})

	const firstPage = await fixture.service.trace(
		fixture.repositoryRoot,
		{ kind: 'task', taskId: task.taskId },
		{ limit: 3, cursor: null },
	)
	assert.match(firstPage.traceId, /^[a-f0-9]{32}$/)
	assert.match(firstPage.root.spanId, /^[a-f0-9]{16}$/)
	assert.equal(firstPage.root.kind, 'task')
	assert.equal(firstPage.root.timingSource, 'measured')
	assert.equal(firstPage.clockAnomalyCount, 1)
	assert.equal(firstPage.spans.length, 3)
	assert.ok(firstPage.nextCursor)
	assert.doesNotMatch(JSON.stringify(firstPage), /Observed task\./)

	const allSpans = await readAllTraceSpans(
		fixture.service,
		fixture.repositoryRoot,
		{ kind: 'task', taskId: task.taskId },
	)
	assert.deepEqual(
		new Set(allSpans.map(span => span.kind)),
		new Set([
			'routing',
			'attempt',
			'model',
			'tool',
			'patch',
			'validation',
			'evaluation',
			'task_completion',
			'patch_application',
		]),
	)
	const attempt = allSpans.find(span => span.kind === 'attempt')
	const model = allSpans.find(span => span.kind === 'model')
	const tool = allSpans.find(span => span.kind === 'tool')
	assert.equal(attempt?.durationMs, 100)
	assert.equal(model?.durationMs, 40)
	assert.equal(
		model?.kind === 'model' ? model.toolCallCount : null,
		1,
	)
	assert.equal(tool?.durationMs, 10)
	assert.equal(tool?.parentSpanId, attempt?.spanId)
	assert.equal(new Set(allSpans.map(span => span.spanId)).size, allSpans.length)
})

test('aggregates deterministic metrics with explicit cost and timing coverage', async function () {
	const fixture = await createFixture()
	await createObservedTask(fixture, {
		workers: ['worker-one'],
		attempts: [{
			workerId: 'worker-one',
			status: 'completed',
			costMicroUsd: 25,
			withPatch: true,
			withTool: true,
		}],
		applyPatch: true,
	})
	await createObservedTask(fixture, {
		workers: ['worker-one', 'worker-two'],
		attempts: [
			{
				workerId: 'worker-one',
				status: 'failed',
				costMicroUsd: null,
				withPatch: false,
				withTool: false,
			},
			{
				workerId: 'worker-two',
				status: 'completed',
				costMicroUsd: 50,
				withPatch: true,
				withTool: false,
			},
		],
		applyPatch: false,
	})

	const metrics = await fixture.service.metrics(fixture.repositoryRoot, {
		mode: 'implementation',
		taskLimit: 10,
	})
	assert.equal(metrics.sampledTaskCount, 2)
	assert.equal(metrics.sampledAttemptCount, 3)
	assert.equal(metrics.tasks.successRate.basisPoints, 10_000)
	assert.equal(metrics.tasks.retryAttemptRate.numerator, 1)
	assert.equal(metrics.tasks.retryAttemptRate.denominator, 3)
	assert.equal(metrics.tasks.fallbackTaskRate.basisPoints, 5_000)
	assert.equal(metrics.patches.producedRunCount, 2)
	assert.equal(metrics.patches.appliedRunCount, 1)
	assert.equal(metrics.patches.acceptanceRate.basisPoints, 5_000)
	assert.equal(metrics.evaluations.counts.failed, 1)
	assert.equal(metrics.usage.pricedAttemptCount, 2)
	assert.equal(metrics.usage.unpricedAttemptCount, 1)
	assert.equal(metrics.usage.fullyPricedTaskCount, 1)
	assert.equal(metrics.durationMs.routing.sampleCount, 2)
	assert.equal(metrics.durationMs.model.sampleCount, 3)
	assert.equal(metrics.coverage.legacyTaskCount, 0)
	assert.equal(metrics.coverage.attemptsWithoutModelTurnCount, 0)
	assert.equal(metrics.workers.length, 2)
	assert.match(metrics.sha256, /^[a-f0-9]{64}$/)

	const repeated = await fixture.service.metrics(fixture.repositoryRoot, {
		mode: 'implementation',
		taskLimit: 10,
	})
	assert.equal(repeated.sha256, metrics.sha256)
})

test('returns explicit empty coverage and rejects unbounded queries', async function () {
	const fixture = await createFixture()
	const metrics = await fixture.service.metrics(fixture.repositoryRoot, {
		mode: 'research',
		taskLimit: 10,
	})
	assert.equal(metrics.sampledTaskCount, 0)
	assert.equal(metrics.tasks.successRate.denominator, 0)
	assert.equal(metrics.tasks.successRate.basisPoints, null)
	assert.equal(metrics.usage.pricedAttemptCount, 0)
	assert.equal(metrics.usage.unpricedAttemptCount, 0)

	await assert.rejects(
		fixture.service.metrics(fixture.repositoryRoot, {
			mode: 'invalid' as 'research',
			taskLimit: 10,
		}),
		hasCode('INVALID_OBSERVABILITY_QUERY'),
	)
	await assert.rejects(
		fixture.service.trace(
			fixture.repositoryRoot,
			{ kind: 'task', taskId: randomUUID() },
			{ limit: 201, cursor: null },
		),
		hasCode('INVALID_OBSERVABILITY_QUERY'),
	)
})

test('projects workflow stages and approval with validated task provenance', async function () {
	const fixture = await createFixture()
	const workflowJournal = new WorkflowJournal()
	const stage = workflowStage()
	const definition: WorkflowDefinition = {
		schemaVersion: 1,
		objective: 'Observe a workflow.',
		repositoryPath: fixture.repositoryRoot,
		baseCommit: 'a'.repeat(40),
		deadlineAt: new Date(Date.now() + 60_000).toISOString(),
		maxTransitions: 4,
		maxRepairAttempts: 0,
		dependencyWorkflowIds: [],
		stages: {
			plan: null,
			implement: stage,
			test: null,
			review: null,
			repair: null,
		},
	}
	const created = await workflowJournal.create(fixture.artifactRoot, definition)
	const workflowId = created.summary.workflowId
	const executionId = randomUUID()
	await workflowJournal.append(fixture.artifactRoot, workflowId, {
		type: 'WorkflowStageStarted',
		data: {
			stage: 'implement',
			executionId,
			attemptNumber: 1,
			sourceRunId: null,
		},
	})
	const provenance = createWorkflowTaskProvenance(
		workflowId,
		'implement',
		executionId,
		stage,
		null,
	)
	const task = await createObservedTask(fixture, {
		workers: ['worker-one'],
		attempts: [{
			workerId: 'worker-one',
			status: 'completed',
			costMicroUsd: 25,
			withPatch: true,
			withTool: false,
		}],
		applyPatch: false,
		provenance,
	})
	await workflowJournal.append(fixture.artifactRoot, workflowId, {
		type: 'WorkflowStageCompleted',
		data: {
			stage: 'implement',
			executionId,
			taskId: task.taskId,
			runId: task.runId,
			status: 'completed',
			failureCode: null,
			candidateRunId: task.runId,
			nextStage: 'approval',
		},
	})
	await workflowJournal.append(fixture.artifactRoot, workflowId, {
		type: 'WorkflowApprovalRequested',
		data: { candidateRunId: task.runId },
	})
	await workflowJournal.append(fixture.artifactRoot, workflowId, {
		type: 'WorkflowApprovalDecided',
		data: {
			decision: 'approved',
			feedback: 'private-review-feedback',
			source: 'mcp_call',
			nextStage: null,
		},
	})
	await workflowJournal.append(fixture.artifactRoot, workflowId, {
		type: 'WorkflowCompleted',
		data: {
			status: 'completed',
			failureCode: null,
			candidateRunId: task.runId,
		},
	})

	const trace = await fixture.service.trace(
		fixture.repositoryRoot,
		{ kind: 'workflow', workflowId },
		{ limit: 100, cursor: null },
	)
	const stageSpan = trace.spans.find(span => span.kind === 'workflow_stage')
	const approvalSpan = trace.spans.find(
		span => span.kind === 'workflow_approval',
	)
	assert.equal(stageSpan?.kind === 'workflow_stage'
		? stageSpan.linkedTraceId
		: null, traceId('task', task.taskId))
	assert.equal(approvalSpan?.kind === 'workflow_approval'
		? approvalSpan.decision
		: null, 'approved')
	assert.equal(trace.root.status, 'ok')
	assert.doesNotMatch(JSON.stringify(trace), /private-review-feedback/)

	const mismatched = await workflowJournal.create(
		fixture.artifactRoot,
		definition,
	)
	const mismatchedExecutionId = randomUUID()
	await workflowJournal.append(
		fixture.artifactRoot,
		mismatched.summary.workflowId,
		{
			type: 'WorkflowStageStarted',
			data: {
				stage: 'implement',
				executionId: mismatchedExecutionId,
				attemptNumber: 1,
				sourceRunId: null,
			},
		},
	)
	await workflowJournal.append(
		fixture.artifactRoot,
		mismatched.summary.workflowId,
		{
			type: 'WorkflowStageCompleted',
			data: {
				stage: 'implement',
				executionId: mismatchedExecutionId,
				taskId: task.taskId,
				runId: task.runId,
				status: 'completed',
				failureCode: null,
				candidateRunId: task.runId,
				nextStage: 'approval',
			},
		},
	)
	await assert.rejects(
		fixture.service.trace(
			fixture.repositoryRoot,
			{ kind: 'workflow', workflowId: mismatched.summary.workflowId },
			{ limit: 100, cursor: null },
		),
		hasCode('OBSERVABILITY_PROVENANCE_MISMATCH'),
	)
})

test('fails closed on repository scope mismatch and cancellation', async function () {
	const fixture = await createFixture()
	const otherRepository = await resolveRepositoryRoot(await createTestRepository())
	const task = await fixture.taskJournal.create({
		artifactRoot: fixture.artifactRoot,
		objective: 'Wrong repository.',
		mode: 'implementation',
		repositoryPath: otherRepository,
		baseCommit: 'a'.repeat(40),
		executionStartedAt: new Date(Date.now() - 100).toISOString(),
		policy: policy(),
	})

	await assert.rejects(
		fixture.service.trace(
			fixture.repositoryRoot,
			{ kind: 'task', taskId: task.taskId },
			{ limit: 100, cursor: null },
		),
		hasCode('OBSERVABILITY_SCOPE_MISMATCH'),
	)
	const controller = new AbortController()
	controller.abort()
	await assert.rejects(
		fixture.service.metrics(
			fixture.repositoryRoot,
			{ mode: 'implementation', taskLimit: 10 },
			controller.signal,
		),
		hasCode('OBSERVABILITY_QUERY_CANCELLED'),
	)
})

test('enforces the absolute query deadline when synchronous work starves timers', async function () {
	const repositoryRoot = await resolveRepositoryRoot(await createTestRepository())
	const artifactOverride = await mkdtemp(path.join(os.tmpdir(), 'observability-timeout-'))
	const config = loadConfig({ AGENT_HARNESS_ARTIFACT_ROOT: artifactOverride })
	const taskJournal = new TaskJournal()
	let projectionStarted = false
	taskJournal.recentTimelines = async function () {
		projectionStarted = true
		const stopAt = Date.now() + 75
		while (Date.now() < stopAt) {
			// Exercise the absolute clock check after a timer-starved operation.
		}
		return []
	}
	const service = new ObservabilityService(config, {
		taskJournal,
		queryTimeoutMs: 50,
	})

	await assert.rejects(
		service.metrics(repositoryRoot, {
			mode: 'implementation',
			taskLimit: 10,
		}),
		hasCode('OBSERVABILITY_QUERY_TIMED_OUT'),
	)
	assert.equal(projectionStarted, true)
})

test('settles promptly when an in-flight journal read ignores the query deadline', async function () {
	const repositoryRoot = await resolveRepositoryRoot(await createTestRepository())
	const artifactOverride = await mkdtemp(path.join(os.tmpdir(), 'observability-stalled-'))
	const config = loadConfig({ AGENT_HARNESS_ARTIFACT_ROOT: artifactOverride })
	const taskJournal = new TaskJournal()
	let readStarted!: () => void
	const started = new Promise<void>(resolve => {
		readStarted = resolve
	})
	taskJournal.recentTimelines = async function () {
		readStarted()
		return await new Promise<never>(() => undefined)
	}
	const service = new ObservabilityService(config, {
		taskJournal,
		queryTimeoutMs: 25,
	})
	const query = service.metrics(repositoryRoot, {
		mode: 'implementation',
		taskLimit: 10,
	})
	await started
	await assert.rejects(query, hasCode('OBSERVABILITY_QUERY_TIMED_OUT'))
})

test('settles promptly when an in-flight journal read ignores cancellation', async function () {
	const repositoryRoot = await resolveRepositoryRoot(await createTestRepository())
	const artifactOverride = await mkdtemp(path.join(os.tmpdir(), 'observability-cancel-'))
	const config = loadConfig({ AGENT_HARNESS_ARTIFACT_ROOT: artifactOverride })
	const taskJournal = new TaskJournal()
	let readStarted!: () => void
	const started = new Promise<void>(resolve => {
		readStarted = resolve
	})
	taskJournal.recentTimelines = async function () {
		readStarted()
		return await new Promise<never>(() => undefined)
	}
	const service = new ObservabilityService(config, { taskJournal })
	const controller = new AbortController()
	const query = service.metrics(
		repositoryRoot,
		{ mode: 'implementation', taskLimit: 10 },
		controller.signal,
	)
	await started
	controller.abort()
	await assert.rejects(query, hasCode('OBSERVABILITY_QUERY_CANCELLED'))
})

type Fixture = Awaited<ReturnType<typeof createFixture>>

type AttemptInput = {
	workerId: string
	status: 'completed' | 'failed'
	costMicroUsd: number | null
	withPatch: boolean
	withTool: boolean
	clockSkew?: boolean
}

async function createFixture() {
	const repositoryRoot = await resolveRepositoryRoot(await createTestRepository())
	const artifactOverride = await mkdtemp(path.join(os.tmpdir(), 'observability-'))
	const config = loadConfig({ AGENT_HARNESS_ARTIFACT_ROOT: artifactOverride })
	const artifactRoot = resolveArtifactRoot(repositoryRoot, config)
	const taskJournal = new TaskJournal()
	return {
		repositoryRoot,
		artifactRoot,
		taskJournal,
		service: new ObservabilityService(config),
	}
}

async function createObservedTask(
	fixture: Fixture,
	input: {
		workers: Array<string>
		attempts: Array<AttemptInput>
		applyPatch: boolean
		provenance?: WorkflowTaskProvenance
	},
): Promise<{ taskId: string; runId: string }> {
	const task = await fixture.taskJournal.create({
		artifactRoot: fixture.artifactRoot,
		objective: 'Observed task.',
		mode: 'implementation',
		repositoryPath: fixture.repositoryRoot,
		baseCommit: 'a'.repeat(40),
		executionStartedAt: new Date(Date.now() - 1_000).toISOString(),
		policy: policy(),
		...(input.provenance === undefined
			? {}
			: { workflowProvenance: input.provenance }),
	})
	await fixture.taskJournal.append(fixture.artifactRoot, task.taskId, {
		type: 'RouteSelected',
		data: {
			strategy: 'balanced',
			candidateWorkerIds: input.workers,
			maxAttempts: input.workers.length,
			...timing(20),
			evidenceSha256: 'b'.repeat(64),
			evidenceTaskCount: 0,
			evidenceAttemptCount: 0,
			decisionSha256: 'c'.repeat(64),
		},
	})
	let latestRunId = ''
	for (const [index, attempt] of input.attempts.entries()) {
		latestRunId = randomUUID()
		await appendAttempt(
			fixture.taskJournal,
			fixture.artifactRoot,
			task.taskId,
			latestRunId,
			index + 1,
			attempt,
		)
	}
	await fixture.taskJournal.append(fixture.artifactRoot, task.taskId, {
		type: 'TaskCompleted',
		data: {
			runId: latestRunId,
			status: input.attempts.at(-1)?.status ?? 'failed',
			completedAt: new Date().toISOString(),
			durationMs: 500,
		},
	})
	if (input.applyPatch) {
		await fixture.taskJournal.append(fixture.artifactRoot, task.taskId, {
			type: 'PatchApplicationRequested',
			data: { runId: latestRunId },
		})
		await fixture.taskJournal.append(fixture.artifactRoot, task.taskId, {
			type: 'PatchApproved',
			data: { runId: latestRunId, source: 'mcp_call' },
		})
		await fixture.taskJournal.append(fixture.artifactRoot, task.taskId, {
			type: 'PatchApplied',
			data: { runId: latestRunId, changedFileCount: 1 },
		})
	}
	return { taskId: task.taskId, runId: latestRunId }
}

async function appendAttempt(
	journal: TaskJournal,
	artifactRoot: string,
	taskId: string,
	runId: string,
	attemptNumber: number,
	input: AttemptInput,
): Promise<void> {
	await journal.append(artifactRoot, taskId, {
		type: 'WorkerStarted',
		data: { runId, workerId: input.workerId, attemptNumber },
	})
	await journal.append(artifactRoot, taskId, {
		type: 'ModelTurnCompleted',
		data: {
			runId,
			iteration: 1,
			outcome: input.status === 'completed' ? 'succeeded' : 'failed',
			toolCallCount: input.withTool ? 1 : 0,
			...(input.clockSkew === true ? skewedTiming(40) : timing(40)),
		},
	})
	if (input.withTool) {
		await journal.append(artifactRoot, taskId, {
			type: 'ToolCalled',
			data: {
				runId,
				toolName: 'read_file',
				iteration: 1,
				outcome: 'succeeded',
				inputBytes: 10,
				outputBytes: 20,
				...timing(10),
			},
		})
	}
	await journal.append(artifactRoot, taskId, {
		type: 'WorkerCompleted',
		data: {
			runId,
			outcome: input.status === 'completed' ? 'succeeded' : 'failed',
			failureCode: input.status === 'completed' ? null : 'PROVIDER_FAILED',
			requestCount: 1,
		},
	})
	if (input.withPatch) {
		await journal.append(artifactRoot, taskId, {
			type: 'PatchProduced',
			data: {
				runId,
				patchSha256: 'd'.repeat(64),
				patchBytes: 20,
				changedFileCount: 1,
			},
		})
	}
	await journal.append(artifactRoot, taskId, {
		type: 'ValidationCompleted',
		data: {
			runId,
			outcome: 'skipped',
			commandCount: 0,
			...timing(15),
		},
	})
	const failed = input.status === 'failed'
	await journal.append(artifactRoot, taskId, {
		type: 'EvaluationCompleted',
		data: {
			runId,
			evaluatorIds: ['deterministic-v1'],
			outcome: failed ? 'failed' : 'passed',
			evaluationPolicy: 'default',
			failedDimensions: failed ? ['worker_execution'] : [],
			unknownDimensions: [],
			...timing(25),
		},
	})
	await journal.append(artifactRoot, taskId, {
		type: 'AttemptCompleted',
		data: {
			runId,
			status: input.status,
			failureCode: failed ? 'PROVIDER_FAILED' : null,
			...timing(100),
			providerLatencyMs: 40,
			totalTokens: 100,
			estimatedCostMicroUsd: input.costMicroUsd,
		},
	})
}

function policy(): ResolvedPolicy {
	const contents = {
		schemaVersion: 1 as const,
		sources: [],
		maxChangedFiles: 10,
		maxIterations: 8,
		maxTaskSeconds: 60,
		allowNetwork: false,
		prohibitedPaths: [],
		routing: {
			requiredCapabilities: [],
			maxCostTier: null,
			maxLatencyTier: null,
			allowFallback: true,
			maxAttempts: 2,
		},
	}
	return {
		...contents,
		digest: createHash('sha256')
			.update(JSON.stringify(contents))
			.digest('hex'),
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
		retryLimit: 1,
	}
}

function timing(durationMs: number): {
	startedAt: string
	completedAt: string
	durationMs: number
} {
	const completedAt = Date.now()
	return {
		startedAt: new Date(completedAt - durationMs).toISOString(),
		completedAt: new Date(completedAt).toISOString(),
		durationMs,
	}
}

function skewedTiming(durationMs: number): {
	startedAt: string
	completedAt: string
	durationMs: number
} {
	return {
		startedAt: new Date(Date.now() + 1_000).toISOString(),
		completedAt: new Date().toISOString(),
		durationMs,
	}
}

async function readAllTraceSpans(
	service: ObservabilityService,
	repositoryPath: string,
	target: { kind: 'task'; taskId: string },
) {
	const spans = []
	let cursor: string | null = null
	do {
		const page = await service.trace(
			repositoryPath,
			target,
			{ limit: 3, cursor },
		)
		spans.push(...page.spans)
		cursor = page.nextCursor
	} while (cursor !== null)
	return spans
}

function traceId(kind: string, id: string): string {
	return createHash('sha256')
		.update(`agent-os:${kind}:${id}`)
		.digest('hex')
		.slice(0, 32)
}

function hasCode(code: string): (error: unknown) => boolean {
	return error => typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === code
}
