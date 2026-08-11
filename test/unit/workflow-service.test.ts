import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadConfig, resolveArtifactRoot } from '../../src/config.js'
import type {
	WorkflowEvent,
	WorkflowEventInput,
	WorkflowWorkerStage,
	WorkerRunReport,
	WorkerTask,
} from '../../src/domain/types.js'
import { resolveCommit, resolveRepositoryRoot } from '../../src/git/repository.js'
import { WorkflowJournal } from '../../src/workflow/journal.js'
import {
	WorkflowService,
	type CreateWorkflowInput,
} from '../../src/workflow/service.js'
import { createTestRepository } from '../helpers/git.js'

class FakeWorkerService {
	readonly tasks: Array<WorkerTask> = []
	readonly reports = new Map<string, WorkerRunReport>()
	private readonly queuedReports: Array<WorkerRunReport>
	private blocking = false
	private validationBlocking = false
	private startedResolve: (() => void) | null = null
	private validationStartedResolve: (() => void) | null = null
	readonly validationCalls: Array<string> = []
	readonly started = new Promise<void>(resolve => {
		this.startedResolve = resolve
	})
	readonly validationStarted = new Promise<void>(resolve => {
		this.validationStartedResolve = resolve
	})

	constructor(reports: Array<WorkerRunReport>) {
		this.queuedReports = [...reports]
		for (const report of reports) {
			this.reports.set(report.runId, report)
		}
	}

	block(): void {
		this.blocking = true
	}

	blockValidation(): void {
		this.validationBlocking = true
	}

	async delegate(task: WorkerTask, signal?: AbortSignal): Promise<WorkerRunReport> {
		this.tasks.push(task)
		this.startedResolve?.()
		if (this.blocking) {
			return await new Promise<WorkerRunReport>((_resolve, reject) => {
				function abort(): void {
					reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
				}
				signal?.addEventListener('abort', abort, { once: true })
				if (signal?.aborted === true) {
					abort()
				}
			})
		}
		const report = this.queuedReports.shift()
		if (report === undefined) {
			throw new Error('No fake worker report remains')
		}
		return report
	}

	async getRun(_repositoryPath: string, runId: string): Promise<WorkerRunReport> {
		const report = this.reports.get(runId)
		if (report === undefined) {
			throw new Error(`Unknown fake run ${runId}`)
		}
		return report
	}

	async validateCandidateRun(
		_repositoryPath: string,
		runId: string,
		_baseCommit: string,
		signal?: AbortSignal,
	): Promise<WorkerRunReport> {
		this.validationCalls.push(runId)
		this.validationStartedResolve?.()
		if (this.validationBlocking) {
			await new Promise<void>((_resolve, reject) => {
				function abort(): void {
					reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
				}
				signal?.addEventListener('abort', abort, { once: true })
				if (signal?.aborted === true) {
					abort()
				}
			})
		}
		const report = await this.getRun('', runId)
		if (
			report.status !== 'completed' ||
			report.patchPath === null ||
			report.patchSha256 === null
		) {
			throw new Error('Invalid fake candidate')
		}
		return report
	}

	async validateWorkflowRun(
		_repositoryPath: string,
		runId: string,
		_baseCommit: string,
		expectedStatus: WorkerRunReport['status'],
		signal?: AbortSignal,
	): Promise<WorkerRunReport> {
		this.validationCalls.push(runId)
		this.validationStartedResolve?.()
		if (this.validationBlocking) {
			await new Promise<void>((_resolve, reject) => {
				function abort(): void {
					reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
				}
				signal?.addEventListener('abort', abort, { once: true })
				if (signal?.aborted === true) {
					abort()
				}
			})
		}
		const report = await this.getRun('', runId)
		if (report.status !== expectedStatus) {
			throw new Error('Unexpected fake run status')
		}
		return report
	}
}

class BlockingWorkflowJournal extends WorkflowJournal {
	private resolveBlocked: (() => void) | null = null
	private releaseBlock: (() => void) | null = null
	readonly blocked = new Promise<void>(resolve => {
		this.resolveBlocked = resolve
	})
	private readonly release = new Promise<void>(resolve => {
		this.releaseBlock = resolve
	})
	private readonly blockedType: WorkflowEventInput['type']

	constructor(blockedType: WorkflowEventInput['type'] = 'WorkflowApprovalRequested') {
		super()
		this.blockedType = blockedType
	}

	continue(): void {
		this.releaseBlock?.()
	}

	override async append(
		artifactRoot: string,
		workflowId: string,
		input: WorkflowEventInput,
		signal?: AbortSignal,
	): Promise<WorkflowEvent> {
		if (input.type === this.blockedType) {
			this.resolveBlocked?.()
			await this.release
		}
		return await super.append(artifactRoot, workflowId, input, signal)
	}
}

test('runs, approves, lists, and reads a durable coding workflow', async function () {
	const repositoryPath = await createTestRepository()
	const implementation = report('completed', true)
	const worker = new FakeWorkerService([implementation])
	const service = await createService(worker)
	const created = await service.create(workflowInput(repositoryPath))
	const workflowId = created.summary.workflowId

	const waiting = await service.run(repositoryPath, workflowId)
	assert.equal(waiting.summary.status, 'waiting_for_approval')
	assert.equal(waiting.summary.currentStage, 'approval')
	assert.equal(waiting.summary.candidateRunId, implementation.runId)
	assert.equal(worker.tasks[0]?.candidateRunId, undefined)

	const completed = await service.approve(
		repositoryPath,
		workflowId,
		'approved',
		'',
	)
	assert.equal(completed.summary.status, 'completed')
	assert.equal(completed.summary.approvalDecision, 'approved')
	assert.equal((await service.get(repositoryPath, workflowId)).events.length, 6)
	assert.deepEqual(
		(await service.list(repositoryPath, 10, null)).workflows.map(
			workflow => workflow.workflowId,
		),
		[workflowId],
	)
})

test('rejects a candidate into a bounded repair loop with cumulative input', async function () {
	const repositoryPath = await createTestRepository()
	const implementation = report('completed', true)
	const repair = report('completed', true)
	const worker = new FakeWorkerService([implementation, repair])
	const service = await createService(worker)
	const input = workflowInput(repositoryPath)
	input.maxRepairAttempts = 1
	input.stages.repair = stage('Repair the rejected candidate.', 0)
	const created = await service.create(input)
	const workflowId = created.summary.workflowId

	await service.run(repositoryPath, workflowId)
	const rejected = await service.approve(
		repositoryPath,
		workflowId,
		'rejected',
		'Handle the edge case.',
	)
	assert.equal(rejected.summary.currentStage, 'repair')

	const repaired = await service.run(repositoryPath, workflowId)
	assert.equal(repaired.summary.status, 'waiting_for_approval')
	assert.equal(repaired.summary.candidateRunId, repair.runId)
	assert.equal(repaired.summary.repairAttemptCount, 1)
	assert.equal(worker.tasks[1]?.candidateRunId, implementation.runId)
	assert.match(worker.tasks[1]?.objective ?? '', /Handle the edge case/)

	const exhausted = await service.approve(
		repositoryPath,
		workflowId,
		'rejected',
		'Still not acceptable.',
	)
	assert.equal(exhausted.summary.status, 'failed')
	assert.equal(exhausted.summary.lastFailureCode, 'WORKFLOW_APPROVAL_REJECTED')
})

test('advances each configured optional stage exactly once', async function () {
	const repositoryPath = await createTestRepository()
	const implementation = report('completed', true)
	const testing = report('completed', false)
	const review = report('completed', false)
	const worker = new FakeWorkerService([implementation, testing, review])
	const service = await createService(worker)
	const input = workflowInput(repositoryPath)
	input.stages.test = stage('Test the candidate.')
	input.stages.review = stage('Review the candidate.')
	const created = await service.create(input)

	const waiting = await service.run(repositoryPath, created.summary.workflowId)
	assert.equal(waiting.summary.status, 'waiting_for_approval')
	assert.deepEqual(worker.tasks.map(task => task.mode), [
		'implementation',
		'testing',
		'review',
	])
	assert.equal(worker.tasks[1]?.candidateRunId, implementation.runId)
	assert.equal(worker.tasks[2]?.candidateRunId, implementation.runId)
	assert.deepEqual(worker.validationCalls, [
		implementation.runId,
		testing.runId,
		review.runId,
	])
})

test('does not seed a retry from a failed partial patch', async function () {
	const repositoryPath = await createTestRepository()
	const failed = report('failed', true)
	failed.failureCode = 'PROVIDER_RESPONSE_INVALID'
	const completed = report('completed', true)
	const worker = new FakeWorkerService([failed, completed])
	const service = await createService(worker)
	const created = await service.create(workflowInput(repositoryPath))

	const waiting = await service.run(repositoryPath, created.summary.workflowId)
	assert.equal(waiting.summary.status, 'waiting_for_approval')
	assert.equal(waiting.summary.candidateRunId, completed.runId)
	assert.equal(worker.tasks.length, 2)
	assert.equal(worker.tasks[1]?.candidateRunId, undefined)
})

test('resumes an interrupted stage as a fresh bounded delegation', async function () {
	const repositoryPath = await createTestRepository()
	const journal = new WorkflowJournal()
	const worker = new FakeWorkerService([report('completed', true)])
	const service = await createService(worker, journal)
	const created = await service.create(workflowInput(repositoryPath))
	const workflowId = created.summary.workflowId
	const artifactRoot = artifactRootFor(service, created.summary.repositoryPath)
	const executionId = randomUUID()
	await journal.append(artifactRoot, workflowId, {
		type: 'WorkflowStageStarted',
		data: {
			stage: 'implement',
			executionId,
			attemptNumber: 1,
			sourceRunId: null,
		},
	})

	const resumed = await service.run(repositoryPath, workflowId)
	assert.equal(resumed.summary.status, 'waiting_for_approval')
	assert.equal(resumed.summary.stageAttempts.implement, 2)
	assert.equal(
		resumed.events.some(event => event.type === 'WorkflowStageInterrupted'),
		true,
	)
	assert.equal(worker.tasks.length, 1)
})

test('times out an active crash remnant before attempting resumed work', async function () {
	const repositoryPath = await createTestRepository()
	const repositoryRoot = await resolveRepositoryRoot(repositoryPath)
	const journal = new WorkflowJournal()
	const worker = new FakeWorkerService([])
	const service = await createService(worker, journal)
	const input = workflowInput(repositoryRoot)
	const artifactRoot = artifactRootFor(service, repositoryRoot)
	const created = await journal.create(artifactRoot, {
		schemaVersion: 1,
		objective: input.objective,
		repositoryPath: repositoryRoot,
		baseCommit: await resolveCommit(repositoryRoot, 'HEAD'),
		deadlineAt: new Date(Date.now() - 1).toISOString(),
		maxTransitions: input.maxTransitions,
		maxRepairAttempts: 0,
		dependencyWorkflowIds: [],
		stages: input.stages,
	})
	const executionId = randomUUID()
	await journal.append(artifactRoot, created.summary.workflowId, {
		type: 'WorkflowStageStarted',
		data: {
			stage: 'implement',
			executionId,
			attemptNumber: 1,
			sourceRunId: null,
		},
	})

	const result = await service.run(repositoryRoot, created.summary.workflowId)
	assert.equal(result.summary.status, 'timed_out')
	assert.equal(worker.tasks.length, 0)
	const interruption = result.events.find(event =>
		event.type === 'WorkflowStageInterrupted'
	)
	assert.equal(
		interruption?.type === 'WorkflowStageInterrupted'
			? interruption.data.reason
			: null,
		'deadline',
	)
})

test('replays a committed approval decision after a crash before completion', async function () {
	const repositoryPath = await createTestRepository()
	const journal = new WorkflowJournal()
	const worker = new FakeWorkerService([report('completed', true)])
	const service = await createService(worker, journal)
	const created = await service.create(workflowInput(repositoryPath))
	const waiting = await service.run(repositoryPath, created.summary.workflowId)
	const artifactRoot = artifactRootFor(service, waiting.summary.repositoryPath)
	await journal.append(artifactRoot, created.summary.workflowId, {
		type: 'WorkflowApprovalDecided',
		data: {
			decision: 'approved',
			feedback: '',
			source: 'mcp_call',
			nextStage: null,
		},
	})

	const recovered = await service.run(repositoryPath, created.summary.workflowId)
	assert.equal(recovered.summary.status, 'completed')
	assert.equal(recovered.summary.approvalDecision, 'approved')
	assert.equal(worker.tasks.length, 1)
})

test('replays a terminal stage decision after a crash before completion', async function () {
	const repositoryPath = await createTestRepository()
	const repositoryRoot = await resolveRepositoryRoot(repositoryPath)
	const journal = new WorkflowJournal()
	const worker = new FakeWorkerService([])
	const service = await createService(worker, journal)
	const input = workflowInput(repositoryRoot)
	input.stages.implement.retryLimit = 0
	const artifactRoot = artifactRootFor(service, repositoryRoot)
	const created = await journal.create(artifactRoot, {
		schemaVersion: 1,
		objective: input.objective,
		repositoryPath: repositoryRoot,
		baseCommit: await resolveCommit(repositoryRoot, 'HEAD'),
		deadlineAt: new Date(Date.now() + 60_000).toISOString(),
		maxTransitions: input.maxTransitions,
		maxRepairAttempts: 0,
		dependencyWorkflowIds: [],
		stages: input.stages,
	})
	const executionId = randomUUID()
	await journal.append(artifactRoot, created.summary.workflowId, {
		type: 'WorkflowStageStarted',
		data: {
			stage: 'implement',
			executionId,
			attemptNumber: 1,
			sourceRunId: null,
		},
	})
	await journal.append(artifactRoot, created.summary.workflowId, {
		type: 'WorkflowStageCompleted',
		data: {
			stage: 'implement',
			executionId,
			taskId: null,
			runId: null,
			status: 'policy_violation',
			failureCode: 'CANDIDATE_PATCH_INVALID',
			candidateRunId: null,
			nextStage: null,
		},
	})

	const recovered = await service.run(repositoryRoot, created.summary.workflowId)
	assert.equal(recovered.summary.status, 'blocked')
	assert.equal(recovered.summary.lastFailureCode, 'CANDIDATE_PATCH_INVALID')
	assert.equal(worker.tasks.length, 0)
})

test('blocks crash recovery when approval evidence does not match candidate history', async function () {
	const repositoryPath = await createTestRepository()
	const repositoryRoot = await resolveRepositoryRoot(repositoryPath)
	const journal = new WorkflowJournal()
	const candidate = report('completed', true)
	const worker = new FakeWorkerService([candidate])
	const service = await createService(worker, journal)
	const input = workflowInput(repositoryRoot)
	const artifactRoot = artifactRootFor(service, repositoryRoot)
	const created = await journal.create(artifactRoot, {
		schemaVersion: 1,
		objective: input.objective,
		repositoryPath: repositoryRoot,
		baseCommit: await resolveCommit(repositoryRoot, 'HEAD'),
		deadlineAt: new Date(Date.now() + 60_000).toISOString(),
		maxTransitions: input.maxTransitions,
		maxRepairAttempts: 0,
		dependencyWorkflowIds: [],
		stages: input.stages,
	})
	const executionId = randomUUID()
	await journal.append(artifactRoot, created.summary.workflowId, {
		type: 'WorkflowStageStarted',
		data: {
			stage: 'implement',
			executionId,
			attemptNumber: 1,
			sourceRunId: null,
		},
	})
	await journal.append(artifactRoot, created.summary.workflowId, {
		type: 'WorkflowStageCompleted',
		data: {
			stage: 'implement',
			executionId,
			taskId: randomUUID(),
			runId: candidate.runId,
			status: 'completed',
			failureCode: null,
			candidateRunId: candidate.runId,
			nextStage: 'approval',
		},
	})
	await journal.append(artifactRoot, created.summary.workflowId, {
		type: 'WorkflowApprovalRequested',
		data: { candidateRunId: candidate.runId },
	})
	await journal.append(artifactRoot, created.summary.workflowId, {
		type: 'WorkflowApprovalDecided',
		data: {
			decision: 'approved',
			feedback: '',
			source: 'mcp_call',
			nextStage: null,
		},
	})

	const blocked = await service.run(repositoryRoot, created.summary.workflowId)
	assert.equal(blocked.summary.status, 'blocked')
	assert.equal(blocked.summary.lastFailureCode, 'WORKFLOW_CANDIDATE_INVALID')
	assert.deepEqual(worker.validationCalls, [candidate.runId])
})

test('blocks approval when later stage evidence cannot be validated', async function () {
	const repositoryPath = await createTestRepository()
	const repositoryRoot = await resolveRepositoryRoot(repositoryPath)
	const journal = new WorkflowJournal()
	const candidate = report('completed', true)
	const worker = new FakeWorkerService([candidate])
	const service = await createService(worker, journal)
	const input = workflowInput(repositoryRoot)
	input.stages.review = stage('Review the candidate.')
	const artifactRoot = artifactRootFor(service, repositoryRoot)
	const created = await journal.create(artifactRoot, {
		schemaVersion: 1,
		objective: input.objective,
		repositoryPath: repositoryRoot,
		baseCommit: await resolveCommit(repositoryRoot, 'HEAD'),
		deadlineAt: new Date(Date.now() + 60_000).toISOString(),
		maxTransitions: input.maxTransitions,
		maxRepairAttempts: 0,
		dependencyWorkflowIds: [],
		stages: input.stages,
	})
	const implementationExecutionId = randomUUID()
	await journal.append(artifactRoot, created.summary.workflowId, {
		type: 'WorkflowStageStarted',
		data: {
			stage: 'implement',
			executionId: implementationExecutionId,
			attemptNumber: 1,
			sourceRunId: null,
		},
	})
	await journal.append(artifactRoot, created.summary.workflowId, {
		type: 'WorkflowStageCompleted',
		data: {
			stage: 'implement',
			executionId: implementationExecutionId,
			taskId: candidate.taskId ?? null,
			runId: candidate.runId,
			status: 'completed',
			failureCode: null,
			candidateRunId: candidate.runId,
			nextStage: 'review',
		},
	})
	const reviewExecutionId = randomUUID()
	const forgedReviewRunId = randomUUID()
	await journal.append(artifactRoot, created.summary.workflowId, {
		type: 'WorkflowStageStarted',
		data: {
			stage: 'review',
			executionId: reviewExecutionId,
			attemptNumber: 1,
			sourceRunId: candidate.runId,
		},
	})
	await journal.append(artifactRoot, created.summary.workflowId, {
		type: 'WorkflowStageCompleted',
		data: {
			stage: 'review',
			executionId: reviewExecutionId,
			taskId: randomUUID(),
			runId: forgedReviewRunId,
			status: 'completed',
			failureCode: null,
			candidateRunId: candidate.runId,
			nextStage: 'approval',
		},
	})

	const blocked = await service.run(repositoryRoot, created.summary.workflowId)
	assert.equal(blocked.summary.status, 'blocked')
	assert.equal(blocked.summary.lastFailureCode, 'WORKFLOW_CANDIDATE_INVALID')
	assert.deepEqual(worker.validationCalls, [candidate.runId, forgedReviewRunId])
	assert.equal(
		blocked.events.some(event => event.type === 'WorkflowApprovalRequested'),
		false,
	)
})

test('cancels an active workflow and records a terminal outcome', async function () {
	const repositoryPath = await createTestRepository()
	const worker = new FakeWorkerService([])
	worker.block()
	const service = await createService(worker)
	const created = await service.create(workflowInput(repositoryPath))
	const run = service.run(repositoryPath, created.summary.workflowId)
	await worker.started

	const cancelled = await service.cancel(
		repositoryPath,
		created.summary.workflowId,
	)
	assert.equal(cancelled.summary.status, 'cancelled')
	assert.equal(cancelled.summary.lastFailureCode, 'WORKFLOW_CANCELLED')
	assert.equal((await run).summary.status, 'cancelled')
})

test('keeps cancellation authoritative during final approval publication', async function () {
	const repositoryPath = await createTestRepository()
	const worker = new FakeWorkerService([report('completed', true)])
	const journal = new BlockingWorkflowJournal()
	const service = await createService(worker, journal)
	const created = await service.create(workflowInput(repositoryPath))
	const run = service.run(repositoryPath, created.summary.workflowId)
	await journal.blocked

	const cancellation = service.cancel(repositoryPath, created.summary.workflowId)
	journal.continue()
	const [runResult, cancelResult] = await Promise.all([run, cancellation])
	assert.equal(runResult.summary.status, 'cancelled')
	assert.equal(cancelResult.summary.status, 'cancelled')
	assert.equal(
		runResult.events.some(event => event.type === 'WorkflowApprovalRequested'),
		false,
	)
})

test('keeps cancellation authoritative during candidate validation', async function () {
	const repositoryPath = await createTestRepository()
	const worker = new FakeWorkerService([report('completed', true)])
	worker.blockValidation()
	const service = await createService(worker)
	const created = await service.create(workflowInput(repositoryPath))
	const run = service.run(repositoryPath, created.summary.workflowId)
	await worker.validationStarted

	const cancellation = await service.cancel(
		repositoryPath,
		created.summary.workflowId,
	)
	assert.equal(cancellation.summary.status, 'cancelled')
	assert.equal((await run).summary.status, 'cancelled')
})

test('keeps the absolute deadline active during candidate validation', async function () {
	const repositoryPath = await createTestRepository()
	const repositoryRoot = await resolveRepositoryRoot(repositoryPath)
	const worker = new FakeWorkerService([report('completed', true)])
	worker.blockValidation()
	const journal = new WorkflowJournal()
	const service = await createService(worker, journal)
	const input = workflowInput(repositoryRoot)
	const artifactRoot = artifactRootFor(service, repositoryRoot)
	const created = await journal.create(artifactRoot, {
		schemaVersion: 1,
		objective: input.objective,
		repositoryPath: repositoryRoot,
		baseCommit: await resolveCommit(repositoryRoot, 'HEAD'),
		deadlineAt: new Date(Date.now() + 1_000).toISOString(),
		maxTransitions: input.maxTransitions,
		maxRepairAttempts: 0,
		dependencyWorkflowIds: [],
		stages: input.stages,
	})

	const result = await service.run(repositoryRoot, created.summary.workflowId)
	assert.equal(result.summary.status, 'timed_out')
	assert.equal(result.summary.lastFailureCode, 'WORKFLOW_DEADLINE_EXCEEDED')
	assert.equal(
		result.events.some(event => event.type === 'WorkflowApprovalRequested'),
		false,
	)
})

test('keeps the absolute deadline active during approval publication', async function () {
	const repositoryPath = await createTestRepository()
	const repositoryRoot = await resolveRepositoryRoot(repositoryPath)
	const worker = new FakeWorkerService([report('completed', true)])
	const journal = new BlockingWorkflowJournal('WorkflowApprovalRequested')
	const service = await createService(worker, journal)
	const input = workflowInput(repositoryRoot)
	const artifactRoot = artifactRootFor(service, repositoryRoot)
	const deadlineAt = new Date(Date.now() + 1_000).toISOString()
	const created = await journal.create(artifactRoot, {
		schemaVersion: 1,
		objective: input.objective,
		repositoryPath: repositoryRoot,
		baseCommit: await resolveCommit(repositoryRoot, 'HEAD'),
		deadlineAt,
		maxTransitions: input.maxTransitions,
		maxRepairAttempts: 0,
		dependencyWorkflowIds: [],
		stages: input.stages,
	})
	const run = service.run(repositoryRoot, created.summary.workflowId)
	await journal.blocked
	await new Promise(resolve => setTimeout(
		resolve,
		Math.max(1, Date.parse(deadlineAt) - Date.now() + 20),
	))
	journal.continue()

	const result = await run
	assert.equal(result.summary.status, 'timed_out')
	assert.equal(result.summary.lastFailureCode, 'WORKFLOW_DEADLINE_EXCEEDED')
	assert.equal(
		result.events.some(event => event.type === 'WorkflowApprovalRequested'),
		false,
	)
})

test('keeps cancellation authoritative during stage-result publication', async function () {
	const repositoryPath = await createTestRepository()
	const worker = new FakeWorkerService([report('completed', true)])
	const journal = new BlockingWorkflowJournal('WorkflowStageCompleted')
	const service = await createService(worker, journal)
	const created = await service.create(workflowInput(repositoryPath))
	const run = service.run(repositoryPath, created.summary.workflowId)
	await journal.blocked

	const cancellation = service.cancel(repositoryPath, created.summary.workflowId)
	journal.continue()
	const [runResult, cancelResult] = await Promise.all([run, cancellation])
	assert.equal(runResult.summary.status, 'cancelled')
	assert.equal(cancelResult.summary.status, 'cancelled')
	assert.equal(
		runResult.events.some(event => event.type === 'WorkflowStageCompleted'),
		false,
	)
})

test('keeps cancellation authoritative during terminal publication', async function () {
	const repositoryPath = await createTestRepository()
	const worker = new FakeWorkerService([report('failed', false)])
	const journal = new BlockingWorkflowJournal('WorkflowCompleted')
	const service = await createService(worker, journal)
	const input = workflowInput(repositoryPath)
	input.stages.implement.retryLimit = 0
	const created = await service.create(input)
	const run = service.run(repositoryPath, created.summary.workflowId)
	await journal.blocked

	const cancellation = service.cancel(repositoryPath, created.summary.workflowId)
	journal.continue()
	const [runResult, cancelResult] = await Promise.all([run, cancellation])
	assert.equal(runResult.summary.status, 'cancelled')
	assert.equal(cancelResult.summary.status, 'cancelled')
	assert.equal(runResult.summary.lastFailureCode, 'WORKFLOW_CANCELLED')
})

test('keeps the deadline authoritative during approval-decision publication', async function () {
	const repositoryPath = await createTestRepository()
	const repositoryRoot = await resolveRepositoryRoot(repositoryPath)
	const worker = new FakeWorkerService([report('completed', true)])
	const journal = new BlockingWorkflowJournal('WorkflowApprovalDecided')
	const service = await createService(worker, journal)
	const input = workflowInput(repositoryRoot)
	const artifactRoot = artifactRootFor(service, repositoryRoot)
	const definition = {
		schemaVersion: 1 as const,
		objective: input.objective,
		repositoryPath: repositoryRoot,
		baseCommit: await resolveCommit(repositoryRoot, 'HEAD'),
		deadlineAt: new Date(Date.now() + 2_000).toISOString(),
		maxTransitions: input.maxTransitions,
		maxRepairAttempts: 0,
		dependencyWorkflowIds: [],
		stages: input.stages,
	}
	const created = await journal.create(artifactRoot, definition)
	const waiting = await service.run(repositoryRoot, created.summary.workflowId)
	assert.equal(waiting.summary.status, 'waiting_for_approval')

	const approval = service.approve(
		repositoryRoot,
		created.summary.workflowId,
		'approved',
		'',
	)
	await journal.blocked
	await new Promise(resolve => setTimeout(
		resolve,
		Math.max(1, Date.parse(definition.deadlineAt) - Date.now() + 20),
	))
	journal.continue()
	const result = await approval
	assert.equal(result.summary.status, 'timed_out')
	assert.equal(result.summary.approvalDecision, null)
	assert.equal(result.summary.lastFailureCode, 'WORKFLOW_DEADLINE_EXCEEDED')
})

test('keeps the deadline authoritative during stage-result publication', async function () {
	const repositoryPath = await createTestRepository()
	const repositoryRoot = await resolveRepositoryRoot(repositoryPath)
	const worker = new FakeWorkerService([report('completed', true)])
	const journal = new BlockingWorkflowJournal('WorkflowStageCompleted')
	const service = await createService(worker, journal)
	const input = workflowInput(repositoryRoot)
	const artifactRoot = artifactRootFor(service, repositoryRoot)
	const definition = {
		schemaVersion: 1 as const,
		objective: input.objective,
		repositoryPath: repositoryRoot,
		baseCommit: await resolveCommit(repositoryRoot, 'HEAD'),
		deadlineAt: new Date(Date.now() + 2_000).toISOString(),
		maxTransitions: input.maxTransitions,
		maxRepairAttempts: 0,
		dependencyWorkflowIds: [],
		stages: input.stages,
	}
	const created = await journal.create(artifactRoot, definition)
	const run = service.run(repositoryRoot, created.summary.workflowId)
	await journal.blocked
	await new Promise(resolve => setTimeout(
		resolve,
		Math.max(1, Date.parse(definition.deadlineAt) - Date.now() + 20),
	))
	journal.continue()

	const result = await run
	assert.equal(result.summary.status, 'timed_out')
	assert.equal(result.summary.candidateRunId, null)
	assert.equal(
		result.events.some(event => event.type === 'WorkflowStageCompleted'),
		false,
	)
})

test('keeps the deadline authoritative during terminal publication', async function () {
	const repositoryPath = await createTestRepository()
	const repositoryRoot = await resolveRepositoryRoot(repositoryPath)
	const worker = new FakeWorkerService([report('failed', false)])
	const journal = new BlockingWorkflowJournal('WorkflowCompleted')
	const service = await createService(worker, journal)
	const input = workflowInput(repositoryRoot)
	input.stages.implement.retryLimit = 0
	const artifactRoot = artifactRootFor(service, repositoryRoot)
	const definition = {
		schemaVersion: 1 as const,
		objective: input.objective,
		repositoryPath: repositoryRoot,
		baseCommit: await resolveCommit(repositoryRoot, 'HEAD'),
		deadlineAt: new Date(Date.now() + 2_000).toISOString(),
		maxTransitions: input.maxTransitions,
		maxRepairAttempts: 0,
		dependencyWorkflowIds: [],
		stages: input.stages,
	}
	const created = await journal.create(artifactRoot, definition)
	const run = service.run(repositoryRoot, created.summary.workflowId)
	await journal.blocked
	await new Promise(resolve => setTimeout(
		resolve,
		Math.max(1, Date.parse(definition.deadlineAt) - Date.now() + 20),
	))
	journal.continue()

	const result = await run
	assert.equal(result.summary.status, 'timed_out')
	assert.equal(result.summary.lastFailureCode, 'WORKFLOW_DEADLINE_EXCEEDED')
})

test('validates repository ownership before cancelling an active workflow', async function () {
	const repositoryPath = await createTestRepository()
	const otherRepositoryPath = await createTestRepository()
	const worker = new FakeWorkerService([])
	worker.block()
	const service = await createService(worker)
	const created = await service.create(workflowInput(repositoryPath))
	const run = service.run(repositoryPath, created.summary.workflowId)
	await worker.started

	await assert.rejects(
		service.cancel(otherRepositoryPath, created.summary.workflowId),
		hasCode('WORKFLOW_NOT_FOUND'),
	)
	const cancelled = await service.cancel(repositoryPath, created.summary.workflowId)
	assert.equal(cancelled.summary.status, 'cancelled')
	assert.equal((await run).summary.status, 'cancelled')
})

test('persists dependency waits and continues after the dependency completes', async function () {
	const repositoryPath = await createTestRepository()
	const worker = new FakeWorkerService([
		report('completed', true),
		report('completed', true),
	])
	const service = await createService(worker)
	const dependency = await service.create(workflowInput(repositoryPath))
	const dependentInput = workflowInput(repositoryPath)
	dependentInput.dependencyWorkflowIds = [dependency.summary.workflowId]
	const dependent = await service.create(dependentInput)

	const waiting = await service.run(repositoryPath, dependent.summary.workflowId)
	assert.equal(waiting.summary.status, 'waiting_for_dependency')
	assert.equal(
		(await service.get(repositoryPath, dependent.summary.workflowId)).summary.status,
		'waiting_for_dependency',
	)
	assert.equal(worker.tasks.length, 0)

	await service.run(repositoryPath, dependency.summary.workflowId)
	await service.approve(
		repositoryPath,
		dependency.summary.workflowId,
		'approved',
		'',
	)
	const continued = await service.run(repositoryPath, dependent.summary.workflowId)
	assert.equal(continued.summary.status, 'waiting_for_approval')
	assert.equal(
		continued.events.filter(event =>
			event.type === 'WorkflowDependencyStateChanged'
		).length,
		2,
	)
	assert.equal(worker.tasks.length, 2)
})

test('enforces the absolute workflow deadline during an active delegation', async function () {
	const repositoryPath = await createTestRepository()
	const worker = new FakeWorkerService([])
	worker.block()
	const journal = new WorkflowJournal()
	const service = await createService(worker, journal)
	const input = workflowInput(repositoryPath)
	const repositoryRoot = await resolveRepositoryRoot(repositoryPath)
	const artifactRoot = artifactRootFor(service, repositoryRoot)
	const persistedDefinition = {
		schemaVersion: 1 as const,
		objective: input.objective,
		repositoryPath: repositoryRoot,
		baseCommit: await resolveCommit(repositoryRoot, 'HEAD'),
		deadlineAt: new Date(Date.now() + 2_000).toISOString(),
		maxTransitions: input.maxTransitions,
		maxRepairAttempts: 0,
		dependencyWorkflowIds: [],
		stages: input.stages,
	}
	const created = await journal.create(artifactRoot, persistedDefinition)

	const timedOut = await service.run(repositoryPath, created.summary.workflowId)
	assert.equal(timedOut.summary.status, 'timed_out')
	assert.equal(timedOut.summary.lastFailureCode, 'WORKFLOW_DEADLINE_EXCEEDED')
	assert.equal(timedOut.summary.activeExecutionId, null)
	assert.equal(worker.tasks.length, 1)
})

async function createService(
	worker: FakeWorkerService,
	journal = new WorkflowJournal(),
): Promise<WorkflowService> {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'workflow-artifacts-'))
	const config = loadConfig({ AGENT_HARNESS_ARTIFACT_ROOT: artifactRoot })
	const service = new WorkflowService(config, {
		workerService: worker,
		journal,
	})
	Object.defineProperty(service, '__testConfig', { value: config })
	return service
}

function artifactRootFor(service: WorkflowService, repositoryPath: string): string {
	const config = (service as unknown as {
		__testConfig: ReturnType<typeof loadConfig>
	}).__testConfig
	return resolveArtifactRoot(repositoryPath, config)
}

function workflowInput(repositoryPath: string): CreateWorkflowInput {
	return {
		objective: 'Ship a durable implementation.',
		repositoryPath,
		baseRef: 'HEAD',
		deadlineSeconds: 3_600,
		maxTransitions: 12,
		maxRepairAttempts: 0,
		dependencyWorkflowIds: [],
		stages: {
			plan: null,
			implement: stage('Implement the change.'),
			test: null,
			review: null,
			repair: null,
		},
	}
}

function stage(objective: string, retryLimit = 1): WorkflowWorkerStage {
	return {
		objective,
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
		retryLimit,
	}
}

function report(
	status: 'completed' | 'failed',
	withPatch: boolean,
): WorkerRunReport {
	const runId = randomUUID()
	return {
		schemaVersion: 3,
		taskId: randomUUID(),
		runId,
		status,
		failureCode: status === 'completed' ? null : 'EVALUATION_FAILED',
		objective: 'Fake stage.',
		mode: 'implementation',
		repositoryPath: '/tmp/fake',
		baseRef: 'a'.repeat(40),
		startedAt: new Date().toISOString(),
		completedAt: new Date().toISOString(),
		durationMs: 1,
		workerSummary: 'Completed fake stage.',
		changedFiles: withPatch ? ['src/generated.ts'] : [],
		patchPath: withPatch ? `/tmp/${runId}.patch` : null,
		patchSha256: withPatch ? 'b'.repeat(64) : null,
		reportPath: `/tmp/${runId}.json`,
		commandResults: [],
		acceptanceCriteria: [],
		policyViolations: [],
		warnings: [],
		evaluation: {
			schemaVersion: 1,
			evaluatedAt: new Date().toISOString(),
			outcome: status === 'completed' ? 'passed' : 'failed',
			results: [],
		},
		provider: {
			workerId: 'fake-worker',
			adapter: 'openai-compatible',
			baseUrl: 'http://127.0.0.1',
			model: 'fake',
			requestCount: 1,
		},
	}
}

function hasCode(code: string): (error: unknown) => boolean {
	return error => typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === code
}
