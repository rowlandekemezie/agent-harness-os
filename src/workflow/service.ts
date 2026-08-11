import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { HarnessConfig } from '../config.js'
import {
	assertArtifactRootOutsideRepository,
	getWorkerSecrets,
	resolveArtifactRoot,
} from '../config.js'
import type {
	RunStatus,
	WorkflowDefinition,
	WorkflowEventInput,
	WorkflowPage,
	WorkflowStageName,
	WorkflowSummary,
	WorkflowTimeline,
	WorkflowWorkerStage,
	WorkflowWorkerStageName,
	WorkerRunReport,
	WorkerTask,
} from '../domain/types.js'
import {
	assertSafeRepositoryConfiguration,
	resolveCommit,
	resolveRepositoryRoot,
} from '../git/repository.js'
import { HarnessError } from '../lib/errors.js'
import { Redactor } from '../lib/redaction.js'
import { truncateUtf8 } from '../lib/text.js'
import { WorkerService } from '../worker/service.js'
import { validateWorkflowDefinition } from './event-model.js'
import { WorkflowJournal } from './journal.js'
import { acquireWorkflowLease } from './lease.js'
import {
	isRepairableWorkflowFailure,
	isRetryableWorkflowFailure,
	nextSuccessfulStage,
} from './transitions.js'

export type CreateWorkflowInput = {
	objective: string
	repositoryPath: string
	baseRef: string
	deadlineSeconds: number
	maxTransitions: number
	maxRepairAttempts: number
	dependencyWorkflowIds: Array<string>
	stages: WorkflowDefinition['stages']
}

type WorkflowWorker = Pick<
	WorkerService,
	'delegate' | 'getRun' | 'validateCandidateRun' | 'validateWorkflowRun'
>

export type WorkflowServiceDependencies = {
	workerService?: WorkflowWorker
	journal?: WorkflowJournal
}

type ActiveWorkflow = {
	controller: AbortController
	completion: Promise<void>
	resolveCompletion(): void
}

type StageResult = {
	report: WorkerRunReport | null
	status: RunStatus
	failureCode: string | null
	candidateRunId: string | null
	nextStage: WorkflowStageName | null
}

export class WorkflowService {
	private readonly config: HarnessConfig
	private readonly workerService: WorkflowWorker
	private readonly journal: WorkflowJournal
	private readonly activeWorkflows = new Map<string, ActiveWorkflow>()

	constructor(
		config: HarnessConfig,
		dependencies: WorkflowServiceDependencies = {},
	) {
		this.config = config
		this.workerService = dependencies.workerService ?? new WorkerService(config)
		const secrets = getWorkerSecrets(config)
		this.journal = dependencies.journal ?? new WorkflowJournal(new Redactor(
			secrets.namedSecrets,
			secrets.additionalSecrets,
		))
	}

	async create(input: CreateWorkflowInput): Promise<WorkflowTimeline> {
		if (
			!Number.isSafeInteger(input.deadlineSeconds) ||
			input.deadlineSeconds < 60 ||
			input.deadlineSeconds > 86_400
		) {
			throw new HarnessError(
				'INVALID_WORKFLOW_DEFINITION',
				'Workflow deadline must be between 60 and 86400 seconds',
			)
		}
		const repositoryPath = await resolveRepositoryRoot(input.repositoryPath)
		await assertSafeRepositoryConfiguration(repositoryPath)
		const baseCommit = await resolveCommit(repositoryPath, input.baseRef)
		const artifactRoot = await this.getArtifactRoot(repositoryPath)
		for (const dependencyWorkflowId of input.dependencyWorkflowIds) {
			const dependency = await this.journal.timeline(
				artifactRoot,
				dependencyWorkflowId,
			)
			if (path.resolve(dependency.summary.repositoryPath) !== repositoryPath) {
				throw new HarnessError(
					'WORKFLOW_DEPENDENCY_REPOSITORY_MISMATCH',
					'Workflow dependencies must belong to the same repository',
				)
			}
		}
		const definition: WorkflowDefinition = {
			schemaVersion: 1,
			objective: input.objective,
			repositoryPath,
			baseCommit,
			deadlineAt: new Date(
				Date.now() + input.deadlineSeconds * 1_000,
			).toISOString(),
			maxTransitions: input.maxTransitions,
			maxRepairAttempts: input.maxRepairAttempts,
			dependencyWorkflowIds: [...input.dependencyWorkflowIds],
			stages: cloneStages(input.stages),
		}
		if (!validateWorkflowDefinition(definition)) {
			throw new HarnessError(
				'INVALID_WORKFLOW_DEFINITION',
				'Workflow definition does not satisfy the durable execution contract',
			)
		}
		return await this.journal.create(artifactRoot, definition)
	}

	async run(
		repositoryPath: string,
		workflowId: string,
		externalSignal?: AbortSignal,
	): Promise<WorkflowTimeline> {
		const repositoryRoot = await resolveRepositoryRoot(repositoryPath)
		const activeKey = activeWorkflowKey(repositoryRoot, workflowId)
		if (this.activeWorkflows.has(activeKey)) {
			throw new HarnessError('WORKFLOW_BUSY', 'Workflow is already running')
		}
		const controller = new AbortController()
		let resolveCompletion = (): void => undefined
		const completion = new Promise<void>(resolve => {
			resolveCompletion = resolve
		})
		this.activeWorkflows.set(activeKey, {
			controller,
			completion,
			resolveCompletion,
		})
		const signal = externalSignal === undefined
			? controller.signal
			: AbortSignal.any([externalSignal, controller.signal])

		try {
			const artifactRoot = await this.getArtifactRoot(repositoryRoot)
			const lease = await acquireWorkflowLease(artifactRoot, workflowId)
			try {
				try {
					return await this.runWithLease(
						repositoryRoot,
						artifactRoot,
						workflowId,
						signal,
					)
				} catch (error) {
					if (signal.aborted) {
						return await this.finalizeInterruptedRun(
							artifactRoot,
							repositoryRoot,
							workflowId,
							'cancelled',
							'WORKFLOW_CANCELLED',
							'cancel',
						)
					}
					if (error instanceof DOMException && error.name === 'TimeoutError') {
						return await this.finalizeInterruptedRun(
							artifactRoot,
							repositoryRoot,
							workflowId,
							'timed_out',
							'WORKFLOW_DEADLINE_EXCEEDED',
							'deadline',
						)
					}
					throw error
				}
			} finally {
				await lease.release()
			}
		} finally {
			this.activeWorkflows.delete(activeKey)
			resolveCompletion()
		}
	}

	async approve(
		repositoryPath: string,
		workflowId: string,
		decision: 'approved' | 'rejected',
		feedback: string,
	): Promise<WorkflowTimeline> {
		const repositoryRoot = await resolveRepositoryRoot(repositoryPath)
		const artifactRoot = await this.getArtifactRoot(repositoryRoot)
		const lease = await acquireWorkflowLease(artifactRoot, workflowId)
		try {
			const timeline = await this.loadForRepository(
				artifactRoot,
				repositoryRoot,
				workflowId,
			)
			if (timeline.summary.status !== 'waiting_for_approval') {
				throw new HarnessError(
					'WORKFLOW_NOT_WAITING_FOR_APPROVAL',
					'Workflow does not have a pending approval stage',
				)
			}
			if (Date.now() >= Date.parse(timeline.definition.deadlineAt)) {
				await this.journal.append(artifactRoot, workflowId, {
					type: 'WorkflowCompleted',
					data: {
						status: 'timed_out',
						failureCode: 'WORKFLOW_DEADLINE_EXCEEDED',
						candidateRunId: timeline.summary.candidateRunId,
					},
				})
				return await this.journal.timeline(artifactRoot, workflowId)
			}
			if (!await this.validateCandidateForApproval(
				artifactRoot,
				workflowId,
				timeline,
			)) {
				return await this.journal.timeline(artifactRoot, workflowId)
			}
			const canRepair = decision === 'rejected' &&
				timeline.definition.stages.repair !== null &&
				timeline.summary.repairAttemptCount <
					timeline.definition.maxRepairAttempts &&
				timeline.summary.transitionCount < timeline.definition.maxTransitions &&
				Date.now() < Date.parse(timeline.definition.deadlineAt)
			const decisionCommitted = await this.appendBeforeDeadline(
				artifactRoot,
				workflowId,
				timeline.definition.deadlineAt,
				{
					type: 'WorkflowApprovalDecided',
					data: {
						decision,
						feedback,
						source: 'mcp_call',
						nextStage: canRepair ? 'repair' : null,
					},
				},
			)
			if (!decisionCommitted) {
				await this.complete(
					artifactRoot,
					workflowId,
					timeline,
					'timed_out',
					'WORKFLOW_DEADLINE_EXCEEDED',
				)
				return await this.journal.timeline(artifactRoot, workflowId)
			}
			const decidedTimeline = await this.journal.timeline(artifactRoot, workflowId)
			if (decision === 'approved' || !canRepair) {
				await this.journal.append(artifactRoot, workflowId, {
					type: 'WorkflowCompleted',
					data: {
						status: decision === 'approved' ? 'completed' : 'failed',
						failureCode: decision === 'approved'
							? null
							: 'WORKFLOW_APPROVAL_REJECTED',
						candidateRunId: decidedTimeline.summary.candidateRunId,
					},
				})
			}
			return await this.journal.timeline(artifactRoot, workflowId)
		} finally {
			await lease.release()
		}
	}

	async cancel(
		repositoryPath: string,
		workflowId: string,
	): Promise<WorkflowTimeline> {
		const repositoryRoot = await resolveRepositoryRoot(repositoryPath)
		const artifactRoot = await this.getArtifactRoot(repositoryRoot)
		await this.loadForRepository(artifactRoot, repositoryRoot, workflowId)
		const active = this.activeWorkflows.get(
			activeWorkflowKey(repositoryRoot, workflowId),
		)
		if (active !== undefined) {
			active.controller.abort(new DOMException('Workflow cancelled', 'AbortError'))
			await active.completion
			return await this.loadForRepository(
				artifactRoot,
				repositoryRoot,
				workflowId,
			)
		}

		const lease = await acquireWorkflowLease(artifactRoot, workflowId)
		try {
			let timeline = await this.loadForRepository(
				artifactRoot,
				repositoryRoot,
				workflowId,
			)
			if (isTerminal(timeline.summary.status)) {
				return timeline
			}
			if (timeline.summary.activeExecutionId !== null) {
				await this.journal.append(artifactRoot, workflowId, {
					type: 'WorkflowStageInterrupted',
					data: {
						stage: timeline.summary.currentStage as WorkflowWorkerStageName,
						executionId: timeline.summary.activeExecutionId,
						reason: 'cancel',
					},
				})
				timeline = await this.journal.timeline(artifactRoot, workflowId)
			}
			await this.journal.append(artifactRoot, workflowId, {
				type: 'WorkflowCompleted',
				data: {
					status: 'cancelled',
					failureCode: 'WORKFLOW_CANCELLED',
					candidateRunId: timeline.summary.candidateRunId,
				},
			})
			return await this.journal.timeline(artifactRoot, workflowId)
		} finally {
			await lease.release()
		}
	}

	async get(
		repositoryPath: string,
		workflowId: string,
	): Promise<WorkflowTimeline> {
		const repositoryRoot = await resolveRepositoryRoot(repositoryPath)
		const artifactRoot = await this.getArtifactRoot(repositoryRoot)
		return await this.loadForRepository(
			artifactRoot,
			repositoryRoot,
			workflowId,
		)
	}

	async list(
		repositoryPath: string,
		limit: number,
		cursor: string | null,
		signal?: AbortSignal,
	): Promise<WorkflowPage> {
		const repositoryRoot = await resolveRepositoryRoot(repositoryPath)
		const artifactRoot = await this.getArtifactRoot(repositoryRoot)
		const page = await this.journal.list(artifactRoot, limit, cursor, signal)
		if (page.workflows.some(item =>
			path.resolve(item.repositoryPath) !== repositoryRoot
		)) {
			throw new HarnessError(
				'WORKFLOW_REPOSITORY_MISMATCH',
				'Workflow history contains an entry for another repository',
			)
		}
		return page
	}

	private async runWithLease(
		repositoryPath: string,
		artifactRoot: string,
		workflowId: string,
		signal: AbortSignal,
	): Promise<WorkflowTimeline> {
		let timeline = await this.loadForRepository(
			artifactRoot,
			repositoryPath,
			workflowId,
		)
		if (isTerminal(timeline.summary.status)) {
			return timeline
		}
		if (timeline.summary.activeExecutionId !== null) {
			const interruptedFor = signal.aborted
				? 'cancel'
				: Date.now() >= Date.parse(timeline.definition.deadlineAt)
					? 'deadline'
					: 'resume'
			await this.journal.append(artifactRoot, workflowId, {
				type: 'WorkflowStageInterrupted',
				data: {
					stage: timeline.summary.currentStage as WorkflowWorkerStageName,
					executionId: timeline.summary.activeExecutionId,
					reason: interruptedFor,
				},
			})
			timeline = await this.journal.timeline(artifactRoot, workflowId)
		}
		const recovered = await this.recoverPendingTerminal(
			artifactRoot,
			workflowId,
			timeline,
			signal,
		)
		if (recovered !== null) {
			return recovered
		}
		if (signal.aborted) {
			await this.complete(
				artifactRoot,
				workflowId,
				timeline,
				'cancelled',
				'WORKFLOW_CANCELLED',
			)
			return await this.journal.timeline(artifactRoot, workflowId)
		}
		if (Date.now() >= Date.parse(timeline.definition.deadlineAt)) {
			await this.complete(
				artifactRoot,
				workflowId,
				timeline,
				'timed_out',
				'WORKFLOW_DEADLINE_EXCEEDED',
			)
			return await this.journal.timeline(artifactRoot, workflowId)
		}
		const workflowDeadlineMs = Date.parse(timeline.definition.deadlineAt)
		const dependencyState = await this.checkDependencies(
			artifactRoot,
			timeline,
			signal,
			workflowDeadlineMs,
		)
		if (dependencyState === 'waiting') {
			if (timeline.summary.status !== 'waiting_for_dependency') {
				await this.journal.append(artifactRoot, workflowId, {
					type: 'WorkflowDependencyStateChanged',
					data: { state: 'waiting' },
				})
			}
			timeline = await this.journal.timeline(artifactRoot, workflowId)
			if (signal.aborted) {
				await this.complete(
					artifactRoot,
					workflowId,
					timeline,
					'cancelled',
					'WORKFLOW_CANCELLED',
				)
				return await this.journal.timeline(artifactRoot, workflowId)
			}
			if (Date.now() >= Date.parse(timeline.definition.deadlineAt)) {
				await this.complete(
					artifactRoot,
					workflowId,
					timeline,
					'timed_out',
					'WORKFLOW_DEADLINE_EXCEEDED',
				)
				return await this.journal.timeline(artifactRoot, workflowId)
			}
			return timeline
		}
		if (dependencyState === 'failed') {
			await this.complete(
				artifactRoot,
				workflowId,
				timeline,
				'blocked',
				'WORKFLOW_DEPENDENCY_FAILED',
			)
			return await this.journal.timeline(artifactRoot, workflowId)
		}
		if (timeline.summary.status === 'waiting_for_dependency') {
			await this.journal.append(artifactRoot, workflowId, {
				type: 'WorkflowDependencyStateChanged',
				data: { state: 'ready' },
			})
			timeline = await this.journal.timeline(artifactRoot, workflowId)
		}

		while (!isTerminal(timeline.summary.status)) {
			if (signal.aborted) {
				await this.complete(
					artifactRoot,
					workflowId,
					timeline,
					'cancelled',
					'WORKFLOW_CANCELLED',
				)
				return await this.journal.timeline(artifactRoot, workflowId)
			}
			const remainingMs = Date.parse(timeline.definition.deadlineAt) - Date.now()
			if (remainingMs <= 0) {
				await this.complete(
					artifactRoot,
					workflowId,
					timeline,
					'timed_out',
					'WORKFLOW_DEADLINE_EXCEEDED',
				)
				return await this.journal.timeline(artifactRoot, workflowId)
			}
			if (timeline.summary.currentStage === 'approval') {
				if (timeline.summary.status !== 'waiting_for_approval') {
					const candidateRunId = timeline.summary.candidateRunId
					if (candidateRunId === null) {
						throw new HarnessError(
							'WORKFLOW_CANDIDATE_MISSING',
							'Approval stage requires a candidate run',
						)
					}
					if (!await this.validateCandidateForApproval(
						artifactRoot,
						workflowId,
						timeline,
						signal,
					)) {
						return await this.journal.timeline(artifactRoot, workflowId)
					}
					const approvalRequested = await this.appendBeforeDeadline(
						artifactRoot,
						workflowId,
						timeline.definition.deadlineAt,
						{
							type: 'WorkflowApprovalRequested',
							data: { candidateRunId },
						},
						signal,
					)
					if (!approvalRequested) {
						await this.complete(
							artifactRoot,
							workflowId,
							timeline,
							signal.aborted ? 'cancelled' : 'timed_out',
							signal.aborted
								? 'WORKFLOW_CANCELLED'
								: 'WORKFLOW_DEADLINE_EXCEEDED',
						)
						return await this.journal.timeline(artifactRoot, workflowId)
					}
				}
				timeline = await this.journal.timeline(artifactRoot, workflowId)
				if (signal.aborted) {
					await this.complete(
						artifactRoot,
						workflowId,
						timeline,
						'cancelled',
						'WORKFLOW_CANCELLED',
					)
					return await this.journal.timeline(artifactRoot, workflowId)
				}
				if (Date.now() >= Date.parse(timeline.definition.deadlineAt)) {
					await this.complete(
						artifactRoot,
						workflowId,
						timeline,
						'timed_out',
						'WORKFLOW_DEADLINE_EXCEEDED',
					)
					return await this.journal.timeline(artifactRoot, workflowId)
				}
				return timeline
			}
			const stageName = timeline.summary.currentStage
			if (stageName === null) {
				throw new HarnessError(
					'INVALID_WORKFLOW_JOURNAL',
					'Non-terminal workflow has no current stage',
				)
			}
			if (timeline.summary.transitionCount >= timeline.definition.maxTransitions) {
				await this.complete(
					artifactRoot,
					workflowId,
					timeline,
					'failed',
					'WORKFLOW_TRANSITION_LIMIT',
				)
				return await this.journal.timeline(artifactRoot, workflowId)
			}

			const executionId = randomUUID()
			const attemptNumber = (timeline.summary.stageAttempts[stageName] ?? 0) + 1
			const attemptLimit = stageName === 'repair'
				? timeline.definition.maxRepairAttempts
				: (timeline.definition.stages[stageName]?.retryLimit ?? 0) + 1
			if (attemptNumber > attemptLimit) {
				await this.complete(
					artifactRoot,
					workflowId,
					timeline,
					'failed',
					'WORKFLOW_STAGE_RETRY_LIMIT',
				)
				return await this.journal.timeline(artifactRoot, workflowId)
			}
			const sourceRunId = stageName === 'plan' || stageName === 'implement'
				? null
				: timeline.summary.candidateRunId
			const deadlineController = new AbortController()
			const deadlineTimer = setTimeout(() => {
				deadlineController.abort(new DOMException(
					'Workflow deadline expired',
					'TimeoutError',
				))
			}, Math.max(1, remainingMs))
			const deadlineSignal = deadlineController.signal
			const stageSignal = AbortSignal.any([signal, deadlineSignal])
			const stage = timeline.definition.stages[stageName]
			if (stage === null) {
				clearTimeout(deadlineTimer)
				throw new HarnessError(
					'INVALID_WORKFLOW_JOURNAL',
					`Current workflow stage is not configured: ${stageName}`,
				)
			}
			let report: WorkerRunReport | null = null
			let thrownError: unknown = null
			let stageStarted = false
			let result: StageResult
			try {
				try {
					await this.journal.append(artifactRoot, workflowId, {
						type: 'WorkflowStageStarted',
						data: { stage: stageName, executionId, attemptNumber, sourceRunId },
					}, stageSignal)
					stageStarted = true
					const task = await this.buildTask(
						timeline,
						stageName,
						stage,
						sourceRunId,
						remainingMs,
					)
					report = await this.workerService.delegate(task, stageSignal)
				} catch (error) {
					if (!stageStarted) {
						throw error
					}
					thrownError = error
				}
				result = this.stageResult(
					timeline,
					stageName,
					stage,
					report,
					thrownError,
					signal,
					deadlineSignal.aborted ||
						Date.now() >= Date.parse(timeline.definition.deadlineAt),
				)
				await this.journal.append(artifactRoot, workflowId, {
					type: 'WorkflowStageCompleted',
					data: {
						stage: stageName,
						executionId,
						taskId: result.report?.taskId ?? null,
						runId: result.report?.runId ?? null,
						status: result.status,
						failureCode: result.failureCode,
						candidateRunId: result.candidateRunId,
						nextStage: result.nextStage,
					},
				}, stageSignal)
			} finally {
				clearTimeout(deadlineTimer)
			}
			timeline = await this.journal.timeline(artifactRoot, workflowId)
			if (result.nextStage === null) {
				const completionCommitted = await this.appendBeforeDeadline(
					artifactRoot,
					workflowId,
					timeline.definition.deadlineAt,
					{
						type: 'WorkflowCompleted',
						data: {
							status: workflowTerminalStatus(result.status),
							failureCode: result.failureCode ?? 'WORKFLOW_STAGE_FAILED',
							candidateRunId: timeline.summary.candidateRunId,
						},
					},
					signal,
				)
				if (!completionCommitted) {
					await this.complete(
						artifactRoot,
						workflowId,
						timeline,
						signal.aborted ? 'cancelled' : 'timed_out',
						signal.aborted
							? 'WORKFLOW_CANCELLED'
							: 'WORKFLOW_DEADLINE_EXCEEDED',
					)
				}
				return await this.journal.timeline(artifactRoot, workflowId)
			}
			if (signal.aborted) {
				await this.complete(
					artifactRoot,
					workflowId,
					timeline,
					'cancelled',
					'WORKFLOW_CANCELLED',
				)
				return await this.journal.timeline(artifactRoot, workflowId)
			}
		}
		return timeline
	}

	private stageResult(
		timeline: WorkflowTimeline,
		stageName: WorkflowWorkerStageName,
		stage: WorkflowWorkerStage,
		report: WorkerRunReport | null,
		error: unknown,
		cancelSignal: AbortSignal,
		deadlineExpired: boolean,
	): StageResult {
		const priorCandidateRunId = timeline.summary.candidateRunId
		let status: RunStatus
		let failureCode: string | null
		let candidateRunId = priorCandidateRunId
		if (report === null) {
			status = cancelSignal.aborted
				? 'cancelled'
				: deadlineExpired
					? 'timed_out'
					: classifyStageError(error)
			failureCode = status === 'cancelled'
				? 'WORKFLOW_CANCELLED'
				: status === 'timed_out'
					? 'WORKFLOW_DEADLINE_EXCEEDED'
					: getFailureCode(error)
		} else {
			status = cancelSignal.aborted
				? 'cancelled'
				: deadlineExpired
					? 'timed_out'
					: report.status
			failureCode = status === 'cancelled'
				? 'WORKFLOW_CANCELLED'
				: status === 'timed_out'
					? 'WORKFLOW_DEADLINE_EXCEEDED'
					: report.failureCode ?? 'WORKFLOW_STAGE_FAILED'
			if (
				status === 'completed' &&
				stageName !== 'plan' &&
				report.patchPath !== null &&
				report.patchSha256 !== null
			) {
				candidateRunId = report.runId
			}
		}

		if (status === 'completed') {
			if (stageName === 'plan') {
				return {
					report,
					status,
					failureCode: null,
					candidateRunId,
					nextStage: 'implement',
				}
			}
			if (
				candidateRunId === null ||
				((stageName === 'implement' || stageName === 'repair') &&
					candidateRunId !== report?.runId)
			) {
				return {
					report,
					status: 'failed',
					failureCode: 'WORKFLOW_CANDIDATE_MISSING',
					candidateRunId: null,
					nextStage: null,
				}
			}
			return {
				report,
				status,
				failureCode: null,
				candidateRunId,
				nextStage: nextSuccessfulStage(timeline.definition, stageName),
			}
		}

		const attemptNumber = (timeline.summary.stageAttempts[stageName] ?? 0) + 1
		if (
			stageName !== 'repair' &&
			(status === 'failed' || status === 'blocked') &&
			attemptNumber <= stage.retryLimit &&
			failureCode !== null &&
				isRetryableWorkflowFailure(failureCode)
		) {
				return {
					report,
					status,
					failureCode,
					candidateRunId: priorCandidateRunId,
					nextStage: stageName,
				}
		}
		const repairAttemptsAfterCurrent = timeline.summary.repairAttemptCount +
			(stageName === 'repair' ? 1 : 0)
		const repairCandidateRunId = report !== null &&
			report.patchPath !== null &&
			report.patchSha256 !== null
			? report.runId
			: candidateRunId
		if (
			repairCandidateRunId !== null &&
			failureCode !== null &&
				isRepairableWorkflowFailure(failureCode) &&
			timeline.definition.stages.repair !== null &&
			repairAttemptsAfterCurrent <
				timeline.definition.maxRepairAttempts
		) {
			return {
				report,
				status,
				failureCode,
				candidateRunId: repairCandidateRunId,
				nextStage: 'repair',
			}
		}
		return { report, status, failureCode, candidateRunId, nextStage: null }
	}

	private async buildTask(
		timeline: WorkflowTimeline,
		stageName: WorkflowWorkerStageName,
		stage: WorkflowWorkerStage,
		sourceRunId: string | null,
		remainingMs: number,
	): Promise<WorkerTask> {
		const context = await this.stageContext(timeline, stageName)
		const objective = context === ''
			? stage.objective
			: truncateUtf8(`${stage.objective}\n\nWORKFLOW CONTEXT:\n${context}`, 4_000)
		return {
			objective,
			repositoryPath: timeline.definition.repositoryPath,
			mode: stageMode(stageName),
			allowedPaths: [...stage.allowedPaths],
			prohibitedPaths: [...stage.prohibitedPaths],
			acceptanceCriteria: [...stage.acceptanceCriteria],
			requiredCommands: stage.requiredCommands.map(command => ({
				...command,
				args: [...command.args],
			})),
			baseRef: timeline.definition.baseCommit,
			maxIterations: stage.maxIterations,
			timeoutSeconds: Math.max(
				1,
				Math.min(stage.timeoutSeconds, Math.floor(remainingMs / 1_000)),
			),
			allowNetwork: stage.allowNetwork,
			routing: {
				...stage.routing,
				requiredCapabilities: [...stage.routing.requiredCapabilities],
			},
			...(sourceRunId === null ? {} : { candidateRunId: sourceRunId }),
		}
	}

	private async stageContext(
		timeline: WorkflowTimeline,
		stageName: WorkflowWorkerStageName,
	): Promise<string> {
		const parts = [`Workflow objective: ${timeline.definition.objective}`]
		if (stageName === 'implement') {
			const plan = [...timeline.events].reverse().find(event =>
				event.type === 'WorkflowStageCompleted' &&
				event.data.stage === 'plan' &&
				event.data.runId !== null
			)
			if (plan?.type === 'WorkflowStageCompleted' && plan.data.runId !== null) {
				const report = await this.workerService.getRun(
					timeline.definition.repositoryPath,
					plan.data.runId,
				)
				parts.push(`Plan: ${truncateUtf8(report.workerSummary, 1_500)}`)
			}
		}
		if (stageName === 'repair') {
			const approval = [...timeline.events].reverse().find(event =>
				event.type === 'WorkflowApprovalDecided' &&
				event.data.decision === 'rejected'
			)
			if (
				approval?.type === 'WorkflowApprovalDecided' &&
				approval.data.feedback !== ''
			) {
				parts.push(`Approval feedback: ${truncateUtf8(approval.data.feedback, 1_500)}`)
			}
			const failedStage = [...timeline.events].reverse().find(event =>
				event.type === 'WorkflowStageCompleted' &&
				event.data.status !== 'completed'
			)
			if (
				failedStage?.type === 'WorkflowStageCompleted' &&
				failedStage.data.runId !== null
			) {
				const report = await this.workerService.getRun(
					timeline.definition.repositoryPath,
					failedStage.data.runId,
				)
				parts.push(
					`Failed ${failedStage.data.stage} stage: ${failedStage.data.failureCode ?? 'unknown'}`,
					`Worker report: ${truncateUtf8(report.workerSummary, 1_500)}`,
				)
			}
		}
		return parts.join('\n')
	}

	private async checkDependencies(
		artifactRoot: string,
		timeline: WorkflowTimeline,
		signal: AbortSignal,
		deadlineMs: number,
	): Promise<'ready' | 'waiting' | 'failed'> {
		for (const workflowId of timeline.definition.dependencyWorkflowIds) {
			signal.throwIfAborted()
			if (Date.now() >= deadlineMs) {
				throw new DOMException('Workflow deadline expired', 'TimeoutError')
			}
			const dependency = await this.journal.timeline(
				artifactRoot,
				workflowId,
				signal,
			)
			if (
				path.resolve(dependency.summary.repositoryPath) !==
				path.resolve(timeline.summary.repositoryPath)
			) {
				throw new HarnessError(
					'WORKFLOW_DEPENDENCY_REPOSITORY_MISMATCH',
					'Workflow dependency moved outside the repository scope',
				)
			}
			if (dependency.summary.status === 'completed') {
				continue
			}
			if (isTerminal(dependency.summary.status)) {
				return 'failed'
			}
			return 'waiting'
		}
		return 'ready'
	}

	private async complete(
		artifactRoot: string,
		workflowId: string,
		timeline: WorkflowTimeline,
		status: 'failed' | 'blocked' | 'timed_out' | 'cancelled',
		failureCode: string,
	): Promise<void> {
		await this.journal.append(artifactRoot, workflowId, {
			type: 'WorkflowCompleted',
			data: {
				status,
				failureCode,
				candidateRunId: timeline.summary.candidateRunId,
			},
		})
	}

	private async appendBeforeDeadline(
		artifactRoot: string,
		workflowId: string,
		deadlineAt: string,
		input: WorkflowEventInput,
		externalSignal?: AbortSignal,
	): Promise<boolean> {
		const remainingMs = Date.parse(deadlineAt) - Date.now()
		if (remainingMs <= 0) {
			return false
		}
		const controller = new AbortController()
		const timeout = setTimeout(() => {
			controller.abort(new DOMException(
				'Workflow deadline expired',
				'TimeoutError',
			))
		}, remainingMs)
		const signal = externalSignal === undefined
			? controller.signal
			: AbortSignal.any([externalSignal, controller.signal])
		try {
			await this.journal.append(
				artifactRoot,
				workflowId,
				input,
				signal,
			)
			if (signal.aborted) {
				return false
			}
			return true
		} catch (error) {
			if (
				signal.aborted &&
				error === signal.reason
			) {
				return false
			}
			throw error
		} finally {
			clearTimeout(timeout)
		}
	}

	private async recoverPendingTerminal(
		artifactRoot: string,
		workflowId: string,
		timeline: WorkflowTimeline,
		signal: AbortSignal,
	): Promise<WorkflowTimeline | null> {
		const lastEvent = timeline.events.at(-1)
		let status: 'completed' | 'failed' | 'blocked' | 'timed_out' | 'cancelled'
		let failureCode: string | null
		if (
			lastEvent?.type === 'WorkflowApprovalDecided' &&
			lastEvent.data.nextStage === null
		) {
			if (
				lastEvent.data.decision === 'approved' &&
				!await this.validateCandidateForApproval(
					artifactRoot,
					workflowId,
					timeline,
					signal,
				)
			) {
				return await this.journal.timeline(artifactRoot, workflowId)
			}
			status = lastEvent.data.decision === 'approved' ? 'completed' : 'failed'
			failureCode = lastEvent.data.decision === 'approved'
				? null
				: 'WORKFLOW_APPROVAL_REJECTED'
		} else if (
			lastEvent?.type === 'WorkflowStageCompleted' &&
			lastEvent.data.nextStage === null
		) {
			status = workflowTerminalStatus(lastEvent.data.status)
			failureCode = lastEvent.data.failureCode ?? 'WORKFLOW_STAGE_FAILED'
		} else if (
			lastEvent?.type === 'WorkflowStageInterrupted' &&
			lastEvent.data.reason !== 'resume'
		) {
			status = lastEvent.data.reason === 'cancel' ? 'cancelled' : 'timed_out'
			failureCode = lastEvent.data.reason === 'cancel'
				? 'WORKFLOW_CANCELLED'
				: 'WORKFLOW_DEADLINE_EXCEEDED'
		} else {
			return null
		}
		await this.journal.append(artifactRoot, workflowId, {
			type: 'WorkflowCompleted',
			data: {
				status,
				failureCode,
				candidateRunId: timeline.summary.candidateRunId,
			},
		})
		return await this.journal.timeline(artifactRoot, workflowId)
	}

	private async validateCandidateForApproval(
		artifactRoot: string,
		workflowId: string,
		timeline: WorkflowTimeline,
		signal?: AbortSignal,
	): Promise<boolean> {
		const candidateRunId = timeline.summary.candidateRunId
		if (candidateRunId === null) {
			return false
		}
		const remainingMs = Date.parse(timeline.definition.deadlineAt) - Date.now()
		if (remainingMs <= 0) {
			await this.complete(
				artifactRoot,
				workflowId,
				timeline,
				'timed_out',
				'WORKFLOW_DEADLINE_EXCEEDED',
			)
			return false
		}
		const deadlineController = new AbortController()
		const deadlineTimer = setTimeout(() => {
			deadlineController.abort(new DOMException(
				'Workflow deadline expired',
				'TimeoutError',
			))
		}, remainingMs)
		const validationSignal = signal === undefined
			? deadlineController.signal
			: AbortSignal.any([signal, deadlineController.signal])
		try {
			const seenRunIds = new Set<string>()
			let candidateValidated = false
			for (const event of timeline.events) {
				if (
					event.type !== 'WorkflowStageCompleted' ||
					event.data.runId === null ||
					event.data.taskId === null
				) {
					continue
				}
				if (seenRunIds.has(event.data.runId)) {
					throw new HarnessError(
						'WORKFLOW_RUN_REUSED',
						'One worker run cannot provide evidence for multiple workflow stages',
					)
				}
				seenRunIds.add(event.data.runId)
				const candidateSource = event.data.status === 'completed' &&
					event.data.runId === candidateRunId &&
					event.data.candidateRunId === candidateRunId
				const report = await waitForSignal(
					candidateSource
						? async () => await this.workerService.validateCandidateRun(
							timeline.summary.repositoryPath,
							event.data.runId as string,
							timeline.summary.baseCommit,
							validationSignal,
						)
						: async () => await this.workerService.validateWorkflowRun(
							timeline.summary.repositoryPath,
							event.data.runId as string,
							timeline.summary.baseCommit,
							event.data.status,
							validationSignal,
						),
					validationSignal,
				)
				if (event.data.taskId !== report.taskId) {
					throw new HarnessError(
						'WORKFLOW_RUN_HISTORY_MISMATCH',
						'Workflow stage evidence does not match validated run history',
					)
				}
				candidateValidated ||= candidateSource
			}
			if (!candidateValidated) {
				throw new HarnessError(
					'WORKFLOW_CANDIDATE_HISTORY_MISMATCH',
					'Workflow candidate does not match its originating stage evidence',
				)
			}
			return true
		} catch {
			const cancelled = signal?.aborted === true
			const deadlineExpired = Date.now() >= Date.parse(
				timeline.definition.deadlineAt,
			)
			await this.complete(
				artifactRoot,
				workflowId,
				timeline,
				cancelled ? 'cancelled' : deadlineExpired ? 'timed_out' : 'blocked',
				cancelled
					? 'WORKFLOW_CANCELLED'
					: deadlineExpired
						? 'WORKFLOW_DEADLINE_EXCEEDED'
						: 'WORKFLOW_CANDIDATE_INVALID',
			)
			return false
		} finally {
			clearTimeout(deadlineTimer)
		}
	}

	private async finalizeInterruptedRun(
		artifactRoot: string,
		repositoryPath: string,
		workflowId: string,
		status: 'timed_out' | 'cancelled',
		failureCode: string,
		reason: 'cancel' | 'deadline',
	): Promise<WorkflowTimeline> {
		let timeline = await this.loadForRepository(
			artifactRoot,
			repositoryPath,
			workflowId,
		)
		if (isTerminal(timeline.summary.status)) {
			return timeline
		}
		if (timeline.summary.activeExecutionId !== null) {
			await this.journal.append(artifactRoot, workflowId, {
				type: 'WorkflowStageInterrupted',
				data: {
					stage: timeline.summary.currentStage as WorkflowWorkerStageName,
					executionId: timeline.summary.activeExecutionId,
					reason,
				},
			})
			timeline = await this.journal.timeline(artifactRoot, workflowId)
		}
		await this.complete(
			artifactRoot,
			workflowId,
			timeline,
			status,
			failureCode,
		)
		return await this.journal.timeline(artifactRoot, workflowId)
	}

	private async loadForRepository(
		artifactRoot: string,
		repositoryPath: string,
		workflowId: string,
	): Promise<WorkflowTimeline> {
		const timeline = await this.journal.timeline(artifactRoot, workflowId)
		if (path.resolve(timeline.summary.repositoryPath) !== repositoryPath) {
			throw new HarnessError(
				'WORKFLOW_REPOSITORY_MISMATCH',
				'Workflow belongs to a different repository',
			)
		}
		return timeline
	}

	private async getArtifactRoot(repositoryPath: string): Promise<string> {
		const artifactRoot = resolveArtifactRoot(repositoryPath, this.config)
		await assertArtifactRootOutsideRepository(repositoryPath, artifactRoot)
		return artifactRoot
	}
}

function stageMode(stageName: WorkflowWorkerStageName): WorkerTask['mode'] {
	if (stageName === 'plan') {
		return 'research'
	}
	if (stageName === 'test') {
		return 'testing'
	}
	if (stageName === 'review') {
		return 'review'
	}
	return 'implementation'
}

function workflowTerminalStatus(
	status: RunStatus,
): 'failed' | 'blocked' | 'timed_out' | 'cancelled' {
	if (status === 'cancelled') {
		return 'cancelled'
	}
	if (status === 'timed_out') {
		return 'timed_out'
	}
	if (status === 'blocked' || status === 'policy_violation') {
		return 'blocked'
	}
	return 'failed'
}

function classifyStageError(error: unknown): RunStatus {
	if (error instanceof DOMException && error.name === 'AbortError') {
		return 'cancelled'
	}
	if (error instanceof DOMException && error.name === 'TimeoutError') {
		return 'timed_out'
	}
	if (
		error instanceof HarnessError &&
		(error.code.includes('POLICY') ||
			error.code.includes('DENIED') ||
			error.code.includes('CANDIDATE') ||
			error.code.includes('HISTORY') ||
			error.code.includes('ARTIFACT'))
	) {
		return 'policy_violation'
	}
	return 'failed'
}

function getFailureCode(error: unknown): string {
	return error instanceof HarnessError ? error.code : 'WORKFLOW_STAGE_FAILED'
}

function isTerminal(status: WorkflowSummary['status']): boolean {
	return status === 'completed' ||
		status === 'failed' ||
		status === 'blocked' ||
		status === 'timed_out' ||
		status === 'cancelled'
}

function activeWorkflowKey(repositoryPath: string, workflowId: string): string {
	return `${repositoryPath}\0${workflowId}`
}

async function waitForSignal<Type>(
	operation: () => Promise<Type>,
	signal?: AbortSignal,
): Promise<Type> {
	if (signal === undefined) {
		return await operation()
	}
	signal.throwIfAborted()
	return await new Promise<Type>((resolve, reject) => {
		let settled = false
		function abort(): void {
			if (!settled) {
				settled = true
				reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
			}
		}
		signal.addEventListener('abort', abort, { once: true })
		if (signal.aborted) {
			abort()
			return
		}
		operation().then(
			value => {
				signal.removeEventListener('abort', abort)
				if (!settled) {
					settled = true
					resolve(value)
				}
			},
			error => {
				signal.removeEventListener('abort', abort)
				if (!settled) {
					settled = true
					reject(error)
				}
			},
		)
	})
}

function cloneStages(
	stages: WorkflowDefinition['stages'],
): WorkflowDefinition['stages'] {
	return {
		plan: stages.plan === null ? null : cloneStage(stages.plan),
		implement: cloneStage(stages.implement),
		test: stages.test === null ? null : cloneStage(stages.test),
		review: stages.review === null ? null : cloneStage(stages.review),
		repair: stages.repair === null ? null : cloneStage(stages.repair),
	}
}

function cloneStage(stage: WorkflowWorkerStage): WorkflowWorkerStage {
	return {
		...stage,
		allowedPaths: [...stage.allowedPaths],
		prohibitedPaths: [...stage.prohibitedPaths],
		acceptanceCriteria: [...stage.acceptanceCriteria],
		requiredCommands: stage.requiredCommands.map(command => ({
			...command,
			args: [...command.args],
		})),
		routing: {
			...stage.routing,
			requiredCapabilities: [...stage.routing.requiredCapabilities],
		},
	}
}
