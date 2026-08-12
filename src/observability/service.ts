import { createHash } from 'node:crypto'
import type { HarnessConfig } from '../config.js'
import {
	assertArtifactRootOutsideRepository,
	getWorkerSecrets,
	resolveArtifactRoot,
} from '../config.js'
import { TaskJournal } from '../artifacts/task-journal.js'
import type {
	EvaluationDimensionId,
	EvaluationOutcome,
	PatchApplicationStatus,
	RoutingStrategy,
	RunStatus,
	TaskEvent,
	TaskStatus,
	TaskTimeline,
	WorkerMode,
	WorkflowEvent,
	WorkflowStatus,
	WorkflowTimeline,
	WorkflowWorkerStageName,
} from '../domain/types.js'
import { resolveRepositoryRoot } from '../git/repository.js'
import { HarnessError } from '../lib/errors.js'
import { Redactor } from '../lib/redaction.js'
import { WorkflowJournal } from '../workflow/journal.js'
import { workflowStageContractSha256 } from '../workflow/provenance.js'

const maxTracePageSize = 200
const maxMetricTaskCount = 100
const maxResponseBytes = 524_288
const queryTimeoutMs = 30_000
const spanIdPattern = /^[a-f0-9]{16}$/

export type ObservabilityTraceTarget =
	| { kind: 'task'; taskId: string }
	| { kind: 'workflow'; workflowId: string }

export type TracePageQuery = {
	limit: number
	cursor: string | null
}

export type ObservabilityMetricQuery = {
	mode: WorkerMode
	taskLimit: number
}

export type TraceSpanStatus = 'ok' | 'error' | 'unset'

export type TraceTimingSource = 'measured' | 'journal' | 'missing'

type TraceSpanBase = {
	traceId: string
	spanId: string
	parentSpanId: string | null
	sequence: number
	lastSequence: number
	name: string
	startedAt: string | null
	completedAt: string | null
	durationMs: number | null
	timingSource: TraceTimingSource
	status: TraceSpanStatus
	sourceEventIds: Array<string>
}

export type ObservabilityTraceSpan =
	| TraceSpanBase & {
		kind: 'routing'
		strategy: RoutingStrategy
		candidateWorkerCount: number
		maxAttempts: number
		evidenceTaskCount: number | null
		evidenceAttemptCount: number | null
	}
	| TraceSpanBase & {
		kind: 'attempt'
		runId: string
		workerId: string
		attemptNumber: number
		outcome: 'succeeded' | 'failed' | 'in_progress'
		runStatus: RunStatus | 'in_progress'
		failureCode: string | null
		requestCount: number | null
		providerLatencyMs: number | null
		reportedTotalTokens: number | null
		estimatedCostMicroUsd: number | null
	}
	| TraceSpanBase & {
		kind: 'model'
		runId: string
		iteration: number
		outcome: 'succeeded' | 'failed'
		toolCallCount: number
	}
	| TraceSpanBase & {
		kind: 'tool'
		runId: string
		iteration: number
		toolName: string
		outcome: 'succeeded' | 'failed'
		inputBytes: number
		outputBytes: number
	}
	| TraceSpanBase & {
		kind: 'patch'
		runId: string
		patchSha256: string
		patchBytes: number
		changedFileCount: number
	}
	| TraceSpanBase & {
		kind: 'validation'
		runId: string
		outcome: 'passed' | 'failed' | 'skipped'
		commandCount: number
	}
	| TraceSpanBase & {
		kind: 'evaluation'
		runId: string
		outcome: EvaluationOutcome
		evaluatorCount: number
		failedDimensions: Array<EvaluationDimensionId>
		unknownDimensions: Array<EvaluationDimensionId>
	}
	| TraceSpanBase & {
		kind: 'task_completion'
		runId: string | null
		runStatus: RunStatus
	}
	| TraceSpanBase & {
		kind: 'patch_application'
		runId: string
		applicationStatus: 'pending' | 'approved' | 'applied' | 'rejected'
		changedFileCount: number | null
		failureCode: string | null
	}
	| TraceSpanBase & {
		kind: 'workflow_dependency'
		dependencyStatus: 'waiting' | 'ready'
	}
	| TraceSpanBase & {
		kind: 'workflow_stage'
		stage: WorkflowWorkerStageName
		executionId: string
		attemptNumber: number
		runId: string | null
		taskId: string | null
		runStatus: RunStatus | 'running' | 'interrupted'
		failureCode: string | null
		linkedTraceId: string | null
	}
	| TraceSpanBase & {
		kind: 'workflow_approval'
		candidateRunId: string
		decision: 'approved' | 'rejected' | 'pending'
	}
	| TraceSpanBase & {
		kind: 'workflow_completion'
		workflowStatus: Exclude<WorkflowStatus, 'pending' | 'running' | 'waiting_for_dependency' | 'waiting_for_approval'>
		failureCode: string | null
	}

export type TaskTraceRoot = TraceSpanBase & {
	kind: 'task'
	taskId: string
	mode: WorkerMode
	taskStatus: TaskStatus
	attemptCount: number
	patchApplicationStatus: PatchApplicationStatus
}

export type WorkflowTraceRoot = TraceSpanBase & {
	kind: 'workflow'
	workflowId: string
	workflowStatus: WorkflowStatus
	transitionCount: number
	repairAttemptCount: number
}

export type ObservabilityTrace = {
	schemaVersion: 1
	targetKind: 'task' | 'workflow'
	traceId: string
	clockAnomalyCount: number
	source: {
		id: string
		eventCount: number
		latestEventSha256: string
	}
	root: TaskTraceRoot | WorkflowTraceRoot
	spans: Array<ObservabilityTraceSpan>
	totalSpanCount: number
	nextCursor: string | null
}

export type RatioMetric = {
	numerator: number
	denominator: number
	basisPoints: number | null
}

export type DistributionMetric = {
	sampleCount: number
	minimum: number | null
	median: number | null
	p95: number | null
	maximum: number | null
	total: number
	average: number | null
}

export type RunStatusCounts = {
	completed: number
	failed: number
	blocked: number
	policyViolation: number
	timedOut: number
	cancelled: number
}

export type TaskStatusCounts = RunStatusCounts & {
	inProgress: number
}

export type EvaluationOutcomeCounts = {
	passed: number
	failed: number
	inconclusive: number
}

export type WorkerObservabilityMetrics = {
	workerId: string
	attemptCount: number
	statusCounts: RunStatusCounts
	successRate: RatioMetric
	evaluationCounts: EvaluationOutcomeCounts
	evaluationFailureRate: RatioMetric
	patchProducedCount: number
	patchAppliedCount: number
	patchAcceptanceRate: RatioMetric
	attemptDurationMs: DistributionMetric
	providerLatencyMs: DistributionMetric
	reportedTotalTokens: DistributionMetric
	estimatedCostMicroUsd: DistributionMetric
}

export type ObservabilityMetricsSnapshot = {
	schemaVersion: 1
	mode: WorkerMode
	taskLimit: number
	observedThrough: string | null
	sampledTaskCount: number
	sampledAttemptCount: number
	sources: Array<{
		taskId: string
		latestEventSha256: string
	}>
	tasks: {
		statusCounts: TaskStatusCounts
		terminalCount: number
		successRate: RatioMetric
		retryAttemptRate: RatioMetric
		fallbackTaskRate: RatioMetric
	}
	attempts: {
		statusCounts: RunStatusCounts
		successRate: RatioMetric
	}
	evaluations: {
		counts: EvaluationOutcomeCounts
		failureRate: RatioMetric
		failedDimensions: Array<{
			dimension: EvaluationDimensionId
			count: number
		}>
	}
	patches: {
		producedRunCount: number
		appliedRunCount: number
		acceptanceRate: RatioMetric
	}
	durationMs: {
		task: DistributionMetric
		routing: DistributionMetric
		attempt: DistributionMetric
		model: DistributionMetric
		tool: DistributionMetric
		validation: DistributionMetric
		evaluation: DistributionMetric
		provider: DistributionMetric
	}
	usage: {
		reportedTokensPerFullyMeasuredTask: DistributionMetric
		estimatedCostPerFullyPricedTaskMicroUsd: DistributionMetric
		reportedTokenAttemptCount: number
		pricedAttemptCount: number
		unpricedAttemptCount: number
		fullyPricedTaskCount: number
	}
	coverage: {
		eventSchemaVersions: Array<number>
		legacyTaskCount: number
		measuredTaskDurationCount: number
		unmeasuredTaskDurationCount: number
		measuredRoutingDurationCount: number
		unmeasuredRoutingDurationCount: number
		measuredAttemptCount: number
		unmeasuredTerminalAttemptCount: number
		modelTurnCount: number
		attemptsWithoutModelTurnCount: number
		clockAnomalyCount: number
	}
	workers: Array<WorkerObservabilityMetrics>
	sha256: string
}

type ObservabilityServiceDependencies = {
	taskJournal?: TaskJournal
	workflowJournal?: WorkflowJournal
	queryTimeoutMs?: number
}

type AttemptObservation = {
	runId: string
	workerId: string
	attemptNumber: number
	status: RunStatus | null
	failureCode: string | null
	durationMs: number | null
	providerLatencyMs: number | null
	reportedTotalTokens: number | null
	estimatedCostMicroUsd: number | null
	evaluation: EvaluationOutcome | null
	failedDimensions: Array<EvaluationDimensionId>
	patchProduced: boolean
	patchApplied: boolean
}

export class ObservabilityService {
	private readonly config: HarnessConfig
	private readonly taskJournal: TaskJournal
	private readonly workflowJournal: WorkflowJournal
	private readonly redactor: Redactor
	private readonly queryTimeoutMs: number

	constructor(
		config: HarnessConfig,
		dependencies: ObservabilityServiceDependencies = {},
	) {
		this.config = config
		const secrets = getWorkerSecrets(config)
		this.redactor = new Redactor(
			secrets.namedSecrets,
			secrets.additionalSecrets,
		)
		this.taskJournal = dependencies.taskJournal ?? new TaskJournal(this.redactor)
		this.workflowJournal = dependencies.workflowJournal ??
			new WorkflowJournal(this.redactor)
		this.queryTimeoutMs = dependencies.queryTimeoutMs ?? queryTimeoutMs
		if (
			!Number.isSafeInteger(this.queryTimeoutMs) ||
			this.queryTimeoutMs < 1 ||
			this.queryTimeoutMs > queryTimeoutMs
		) {
			throw new HarnessError(
				'INVALID_OBSERVABILITY_QUERY_TIMEOUT',
				`Observability query timeout must be 1-${queryTimeoutMs} milliseconds`,
			)
		}
	}

	async trace(
		repositoryPath: string,
		target: ObservabilityTraceTarget,
		query: TracePageQuery,
		externalSignal?: AbortSignal,
	): Promise<ObservabilityTrace> {
		assertTraceQuery(query)
		return await this.runQuery(externalSignal, async (signal, check) => {
			check()
			const repositoryRoot = await this.resolveScope(repositoryPath, signal)
			const artifactRoot = await this.getArtifactRoot(repositoryRoot, signal)
			const trace = target.kind === 'task'
				? await this.taskTrace(
					repositoryRoot,
					artifactRoot,
					target.taskId,
					query,
					signal,
					check,
				)
				: await this.workflowTrace(
					repositoryRoot,
					artifactRoot,
					target.workflowId,
					query,
					signal,
					check,
				)
			check()
			const result = this.assertSafeResult(trace)
			check()
			return result
		})
	}

	async metrics(
		repositoryPath: string,
		query: ObservabilityMetricQuery,
		externalSignal?: AbortSignal,
	): Promise<ObservabilityMetricsSnapshot> {
		assertMetricQuery(query)
		return await this.runQuery(externalSignal, async (signal, check) => {
			check()
			const repositoryRoot = await this.resolveScope(repositoryPath, signal)
			const artifactRoot = await this.getArtifactRoot(repositoryRoot, signal)
			const timelines = await this.taskJournal.recentTimelines(
				artifactRoot,
				query.mode,
				query.taskLimit,
				signal,
			)
			for (const timeline of timelines) {
				check()
				if (
					timeline.task.repositoryPath !== repositoryRoot ||
					timeline.task.mode !== query.mode
				) {
					throw new HarnessError(
						'OBSERVABILITY_SCOPE_MISMATCH',
						'Task history is outside the requested repository or mode',
					)
				}
			}
			const snapshot = aggregateMetrics(query, timelines, check)
			check()
			const result = this.assertSafeResult(snapshot)
			check()
			return result
		})
	}

	private async taskTrace(
		repositoryRoot: string,
		artifactRoot: string,
		taskId: string,
		query: TracePageQuery,
		signal: AbortSignal,
		check: () => void,
	): Promise<ObservabilityTrace> {
		const timeline = await this.taskJournal.timeline(
			artifactRoot,
			taskId,
			signal,
		)
		if (timeline.task.repositoryPath !== repositoryRoot) {
			throw new HarnessError(
				'OBSERVABILITY_SCOPE_MISMATCH',
				'Task history is outside the requested repository',
			)
		}
		check()
		return paginateTrace(projectTaskTrace(timeline, check), query, check)
	}

	private async workflowTrace(
		repositoryRoot: string,
		artifactRoot: string,
		workflowId: string,
		query: TracePageQuery,
		signal: AbortSignal,
		check: () => void,
	): Promise<ObservabilityTrace> {
		const timeline = await this.workflowJournal.timeline(
			artifactRoot,
			workflowId,
			signal,
		)
		if (timeline.summary.repositoryPath !== repositoryRoot) {
			throw new HarnessError(
				'OBSERVABILITY_SCOPE_MISMATCH',
				'Workflow history is outside the requested repository',
			)
		}
		await this.assertWorkflowTaskLinks(
			repositoryRoot,
			artifactRoot,
			timeline,
			signal,
			check,
		)
		check()
		return paginateTrace(projectWorkflowTrace(timeline, check), query, check)
	}

	private async assertWorkflowTaskLinks(
		repositoryRoot: string,
		artifactRoot: string,
		workflow: WorkflowTimeline,
		signal: AbortSignal,
		check: () => void,
	): Promise<void> {
		const starts = new Map(
			workflow.events.flatMap(event =>
				event.type === 'WorkflowStageStarted'
					? [[event.data.executionId, event] as const]
					: [],
			),
		)
		for (const event of workflow.events) {
			check()
			if (
				event.type !== 'WorkflowStageCompleted' ||
				event.data.taskId === null ||
				event.data.runId === null
			) {
				continue
			}
			const started = starts.get(event.data.executionId)
			const task = await this.taskJournal.timeline(
				artifactRoot,
				event.data.taskId,
				signal,
			)
			const created = task.events[0]
			const provenance = created?.type === 'TaskCreated'
				? created.data.workflowProvenance
				: undefined
			const stageContract = workflow.definition.stages[event.data.stage]
			if (
				started === undefined ||
				task.task.repositoryPath !== repositoryRoot ||
				task.task.baseCommit !== workflow.definition.baseCommit ||
				task.task.mode !== workflowStageMode(event.data.stage) ||
				task.task.latestRunId !== event.data.runId ||
				task.task.status !== event.data.status ||
				provenance === undefined ||
				provenance === null ||
				provenance.workflowId !== workflow.summary.workflowId ||
				provenance.stage !== event.data.stage ||
				provenance.executionId !== event.data.executionId ||
				stageContract === null ||
				provenance.stageContractSha256 !==
					workflowStageContractSha256(stageContract) ||
				provenance.sourceRunId !== started.data.sourceRunId
			) {
				throw new HarnessError(
					'OBSERVABILITY_PROVENANCE_MISMATCH',
					'Workflow stage does not match its task history',
				)
			}
		}
	}

	private async resolveScope(
		repositoryPath: string,
		signal: AbortSignal,
	): Promise<string> {
		signal.throwIfAborted()
		const repositoryRoot = await resolveRepositoryRoot(repositoryPath, signal)
		signal.throwIfAborted()
		return repositoryRoot
	}

	private async getArtifactRoot(
		repositoryRoot: string,
		signal: AbortSignal,
	): Promise<string> {
		const artifactRoot = resolveArtifactRoot(repositoryRoot, this.config)
		await assertArtifactRootOutsideRepository(repositoryRoot, artifactRoot)
		signal.throwIfAborted()
		return artifactRoot
	}

	private async runQuery<Result>(
		externalSignal: AbortSignal | undefined,
		operation: (
			signal: AbortSignal,
			check: () => void,
		) => Promise<Result>,
	): Promise<Result> {
		const deadlineAt = Date.now() + this.queryTimeoutMs
		const timeoutController = new AbortController()
		const timeout = setTimeout(
			() => timeoutController.abort(),
			this.queryTimeoutMs,
		)
		const timeoutSignal = timeoutController.signal
		const signal = externalSignal === undefined
			? timeoutSignal
			: AbortSignal.any([externalSignal, timeoutSignal])
		const check = (): void => {
			signal.throwIfAborted()
			if (Date.now() >= deadlineAt) {
				throw new HarnessError(
					'OBSERVABILITY_QUERY_TIMED_OUT',
					`Observability query exceeded ${this.queryTimeoutMs} milliseconds`,
				)
			}
		}
		try {
			check()
			const operationPromise = operation(signal, check)
			const abortPromise = new Promise<never>((_resolve, reject) => {
				function abort(): void {
					reject(signal.reason)
				}

				if (signal.aborted) {
					abort()
					return
				}
				signal.addEventListener('abort', abort, { once: true })
				operationPromise.finally(() => {
					signal.removeEventListener('abort', abort)
				}).catch(() => undefined)
			})
			const result = await Promise.race([operationPromise, abortPromise])
			check()
			return result
		} catch (error) {
			if (externalSignal?.aborted === true) {
				throw new HarnessError(
					'OBSERVABILITY_QUERY_CANCELLED',
					'Observability query was cancelled',
				)
			}
			if (timeoutSignal.aborted) {
				throw new HarnessError(
					'OBSERVABILITY_QUERY_TIMED_OUT',
					`Observability query exceeded ${this.queryTimeoutMs} milliseconds`,
				)
			}
			throw error
		} finally {
			clearTimeout(timeout)
		}
	}

	private assertSafeResult<Result>(result: Result): Result {
		if (this.redactor.containsCredentialMaterial(result)) {
			throw new HarnessError(
				'OBSERVABILITY_CONTAINS_SECRET',
				'Observability output contains credential material',
			)
		}
		const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8')
		if (bytes > maxResponseBytes) {
			throw new HarnessError(
				'OBSERVABILITY_RESPONSE_TOO_LARGE',
				`Observability response exceeds ${maxResponseBytes} bytes`,
			)
		}
		return result
	}
}

function projectTaskTrace(
	timeline: TaskTimeline,
	check: () => void,
): ObservabilityTrace {
	const traceId = traceIdentifier('task', timeline.task.taskId)
	const rootSpanId = spanIdentifier(traceId, 'task', timeline.task.taskId)
	const attempts = new Map<string, {
		started: Extract<TaskEvent, { type: 'WorkerStarted' }>
		workerCompleted: Extract<TaskEvent, { type: 'WorkerCompleted' }> | null
		completed: Extract<TaskEvent, { type: 'AttemptCompleted' }> | null
	}>()
	const spans: Array<ObservabilityTraceSpan> = []
	let activeApplication: Array<TaskEvent> | null = null
	let taskCompleted: Extract<TaskEvent, { type: 'TaskCompleted' }> | null = null

	for (const event of timeline.events) {
		check()
		switch (event.type) {
			case 'RouteSelected':
				spans.push(routingSpan(traceId, rootSpanId, event))
				break
			case 'WorkerStarted':
				attempts.set(event.data.runId, {
					started: event,
					workerCompleted: null,
					completed: null,
				})
				break
			case 'ModelTurnCompleted':
				spans.push(modelSpan(traceId, event))
				break
			case 'ToolCalled':
				spans.push(toolSpan(traceId, event))
				break
			case 'WorkerCompleted': {
				const attempt = requireAttempt(attempts, event.data.runId)
				attempt.workerCompleted = event
				break
			}
			case 'PatchProduced':
				spans.push(patchSpan(traceId, event))
				break
			case 'ValidationCompleted':
				spans.push(validationSpan(traceId, event))
				break
			case 'EvaluationCompleted':
				spans.push(evaluationSpan(traceId, event))
				break
			case 'AttemptCompleted': {
				const attempt = requireAttempt(attempts, event.data.runId)
				attempt.completed = event
				break
			}
			case 'TaskCompleted':
				taskCompleted = event
				spans.push(taskCompletionSpan(traceId, rootSpanId, event))
				break
			case 'PatchApplicationRequested':
				if (activeApplication !== null) {
					throw invalidHistory('Patch application trace overlaps another request')
				}
				activeApplication = [event]
				break
			case 'PatchApproved':
				if (activeApplication === null) {
					throw invalidHistory('Patch approval has no trace request')
				}
				activeApplication.push(event)
				break
			case 'PatchApplied':
			case 'PatchApplicationRejected':
				if (activeApplication === null) {
					throw invalidHistory('Patch application result has no trace request')
				}
				activeApplication.push(event)
				spans.push(patchApplicationSpan(
					traceId,
					rootSpanId,
					activeApplication,
				))
				activeApplication = null
				break
		}
	}
	if (activeApplication !== null) {
		spans.push(patchApplicationSpan(
			traceId,
			rootSpanId,
			activeApplication,
		))
	}
	for (const attempt of attempts.values()) {
		check()
		spans.push(attemptSpan(traceId, rootSpanId, attempt))
	}
	spans.sort(compareSpans)
	const created = timeline.events[0]
	if (created?.type !== 'TaskCreated') {
		throw invalidHistory('Task trace is missing TaskCreated')
	}
	const startedAt = created.data.executionStartedAt ?? created.occurredAt
	const completedAt = taskCompleted === null
		? null
		: taskCompleted.data.completedAt ?? taskCompleted.occurredAt
	const durationMs = taskCompleted?.data.durationMs ??
		journalDuration(startedAt, completedAt)
	const root: TaskTraceRoot = {
		traceId,
		spanId: rootSpanId,
		parentSpanId: null,
		sequence: 1,
		lastSequence: taskCompleted?.sequence ?? timeline.task.eventCount,
		kind: 'task',
		name: 'agent_os.task',
		startedAt,
		completedAt,
		durationMs,
		timingSource: taskCompleted?.data.durationMs === undefined
			? completedAt === null ? 'missing' : 'journal'
			: 'measured',
		status: traceStatus(timeline.task.status),
		sourceEventIds: taskCompleted === null
			? [created.eventId]
			: [created.eventId, taskCompleted.eventId],
		taskId: timeline.task.taskId,
		mode: timeline.task.mode,
		taskStatus: timeline.task.status,
		attemptCount: timeline.task.attemptCount,
		patchApplicationStatus: timeline.task.patchApplicationStatus,
	}
	return {
		schemaVersion: 1,
		targetKind: 'task',
		traceId,
		clockAnomalyCount: countClockAnomalies(timeline.events, check),
		source: {
			id: timeline.task.taskId,
			eventCount: timeline.task.eventCount,
			latestEventSha256: timeline.task.latestEventSha256,
		},
		root,
		spans,
		totalSpanCount: spans.length,
		nextCursor: null,
	}
}

function projectWorkflowTrace(
	timeline: WorkflowTimeline,
	check: () => void,
): ObservabilityTrace {
	const traceId = traceIdentifier('workflow', timeline.summary.workflowId)
	const rootSpanId = spanIdentifier(
		traceId,
		'workflow',
		timeline.summary.workflowId,
	)
	const spans: Array<ObservabilityTraceSpan> = []
	const activeStages = new Map<string, Extract<WorkflowEvent, {
		type: 'WorkflowStageStarted'
	}>>()
	let dependencyStart: Extract<WorkflowEvent, {
		type: 'WorkflowDependencyStateChanged'
	}> | null = null
	let approvalEvents: Array<WorkflowEvent> | null = null
	let completed: Extract<WorkflowEvent, { type: 'WorkflowCompleted' }> | null = null

	for (const event of timeline.events) {
		check()
		switch (event.type) {
			case 'WorkflowCreated':
				break
			case 'WorkflowDependencyStateChanged':
				if (event.data.state === 'waiting') {
					dependencyStart = event
				} else {
					if (dependencyStart === null) {
						throw invalidHistory('Workflow dependency ready has no wait')
					}
					spans.push(workflowDependencySpan(
						traceId,
						rootSpanId,
						dependencyStart,
						event,
					))
					dependencyStart = null
				}
				break
			case 'WorkflowStageStarted':
				activeStages.set(event.data.executionId, event)
				break
			case 'WorkflowStageInterrupted':
			case 'WorkflowStageCompleted': {
				const started = activeStages.get(event.data.executionId)
				if (started === undefined) {
					throw invalidHistory('Workflow stage result has no trace start')
				}
				spans.push(workflowStageSpan(
					traceId,
					rootSpanId,
					started,
					event,
				))
				activeStages.delete(event.data.executionId)
				break
			}
			case 'WorkflowApprovalRequested':
				approvalEvents = [event]
				break
			case 'WorkflowApprovalDecided':
				if (approvalEvents === null) {
					throw invalidHistory('Workflow approval decision has no request')
				}
				approvalEvents.push(event)
				spans.push(workflowApprovalSpan(
					traceId,
					rootSpanId,
					approvalEvents,
				))
				approvalEvents = null
				break
			case 'WorkflowCompleted':
				completed = event
				spans.push(workflowCompletionSpan(traceId, rootSpanId, event))
				break
		}
	}
	if (dependencyStart !== null) {
		spans.push(workflowDependencySpan(
			traceId,
			rootSpanId,
			dependencyStart,
			null,
		))
	}
	for (const started of activeStages.values()) {
		check()
		spans.push(workflowStageSpan(traceId, rootSpanId, started, null))
	}
	if (approvalEvents !== null) {
		spans.push(workflowApprovalSpan(traceId, rootSpanId, approvalEvents))
	}
	spans.sort(compareSpans)
	const created = timeline.events[0]
	if (created?.type !== 'WorkflowCreated') {
		throw invalidHistory('Workflow trace is missing WorkflowCreated')
	}
	const completedAt = completed?.occurredAt ?? null
	const root: WorkflowTraceRoot = {
		traceId,
		spanId: rootSpanId,
		parentSpanId: null,
		sequence: 1,
		lastSequence: completed?.sequence ?? timeline.summary.eventCount,
		kind: 'workflow',
		name: 'agent_os.workflow',
		startedAt: created.occurredAt,
		completedAt,
		durationMs: journalDuration(created.occurredAt, completedAt),
		timingSource: completedAt === null ? 'missing' : 'journal',
		status: traceStatus(timeline.summary.status),
		sourceEventIds: completed === null
			? [created.eventId]
			: [created.eventId, completed.eventId],
		workflowId: timeline.summary.workflowId,
		workflowStatus: timeline.summary.status,
		transitionCount: timeline.summary.transitionCount,
		repairAttemptCount: timeline.summary.repairAttemptCount,
	}
	return {
		schemaVersion: 1,
		targetKind: 'workflow',
		traceId,
		clockAnomalyCount: countEventClockAnomalies(timeline.events, check),
		source: {
			id: timeline.summary.workflowId,
			eventCount: timeline.summary.eventCount,
			latestEventSha256: timeline.summary.latestEventSha256,
		},
		root,
		spans,
		totalSpanCount: spans.length,
		nextCursor: null,
	}
}

function routingSpan(
	traceId: string,
	rootSpanId: string,
	event: Extract<TaskEvent, { type: 'RouteSelected' }>,
): ObservabilityTraceSpan {
	return {
		...eventSpanBase(traceId, rootSpanId, event, 'routing'),
		kind: 'routing',
		name: 'agent_os.routing',
		startedAt: event.data.startedAt ?? null,
		completedAt: event.data.completedAt ?? null,
		durationMs: event.data.durationMs ?? null,
		timingSource: event.data.durationMs === undefined ? 'missing' : 'measured',
		status: 'ok',
		strategy: event.data.strategy,
		candidateWorkerCount: event.data.candidateWorkerIds.length,
		maxAttempts: event.data.maxAttempts,
		evidenceTaskCount: event.data.evidenceTaskCount ?? null,
		evidenceAttemptCount: event.data.evidenceAttemptCount ?? null,
	}
}

function attemptSpan(
	traceId: string,
	rootSpanId: string,
	attempt: {
		started: Extract<TaskEvent, { type: 'WorkerStarted' }>
		workerCompleted: Extract<TaskEvent, { type: 'WorkerCompleted' }> | null
		completed: Extract<TaskEvent, { type: 'AttemptCompleted' }> | null
	},
): ObservabilityTraceSpan {
	const { started, workerCompleted, completed } = attempt
	const spanId = spanIdentifier(traceId, 'attempt', started.data.runId)
	return {
		traceId,
		spanId,
		parentSpanId: rootSpanId,
		sequence: started.sequence,
		lastSequence: completed?.sequence ?? workerCompleted?.sequence ?? started.sequence,
		kind: 'attempt',
		name: 'agent_os.worker.attempt',
		startedAt: completed?.data.startedAt ?? started.occurredAt,
		completedAt: completed?.data.completedAt ?? null,
		durationMs: completed?.data.durationMs ?? null,
		timingSource: completed?.data.durationMs === undefined
			? 'missing'
			: 'measured',
		status: completed === null ? 'unset' : traceStatus(completed.data.status),
		sourceEventIds: [
			started.eventId,
			...(workerCompleted === null ? [] : [workerCompleted.eventId]),
			...(completed === null ? [] : [completed.eventId]),
		],
		runId: started.data.runId,
		workerId: started.data.workerId,
		attemptNumber: started.data.attemptNumber,
		outcome: workerCompleted?.data.outcome ?? 'in_progress',
		runStatus: completed?.data.status ?? 'in_progress',
		failureCode: completed?.data.failureCode ??
			workerCompleted?.data.failureCode ?? null,
		requestCount: workerCompleted?.data.requestCount ?? null,
		providerLatencyMs: completed?.data.providerLatencyMs ?? null,
		reportedTotalTokens: completed?.data.totalTokens ?? null,
		estimatedCostMicroUsd: completed?.data.estimatedCostMicroUsd ?? null,
	}
}

function modelSpan(
	traceId: string,
	event: Extract<TaskEvent, { type: 'ModelTurnCompleted' }>,
): ObservabilityTraceSpan {
	return {
		...eventSpanBase(
			traceId,
			spanIdentifier(traceId, 'attempt', event.data.runId),
			event,
			`model:${event.data.runId}:${event.data.iteration}`,
		),
		kind: 'model',
		name: 'agent_os.model.turn',
		startedAt: event.data.startedAt,
		completedAt: event.data.completedAt,
		durationMs: event.data.durationMs,
		timingSource: 'measured',
		status: event.data.outcome === 'succeeded' ? 'ok' : 'error',
		runId: event.data.runId,
		iteration: event.data.iteration,
		outcome: event.data.outcome,
		toolCallCount: event.data.toolCallCount,
	}
}

function toolSpan(
	traceId: string,
	event: Extract<TaskEvent, { type: 'ToolCalled' }>,
): ObservabilityTraceSpan {
	return {
		...eventSpanBase(
			traceId,
			spanIdentifier(traceId, 'attempt', event.data.runId),
			event,
			`tool:${event.eventId}`,
		),
		kind: 'tool',
		name: `agent_os.worker.tool.${event.data.toolName}`,
		startedAt: event.data.startedAt ?? null,
		completedAt: event.data.completedAt ?? event.occurredAt,
		durationMs: event.data.durationMs,
		timingSource: 'measured',
		status: event.data.outcome === 'succeeded' ? 'ok' : 'error',
		runId: event.data.runId,
		iteration: event.data.iteration,
		toolName: event.data.toolName,
		outcome: event.data.outcome,
		inputBytes: event.data.inputBytes,
		outputBytes: event.data.outputBytes,
	}
}

function patchSpan(
	traceId: string,
	event: Extract<TaskEvent, { type: 'PatchProduced' }>,
): ObservabilityTraceSpan {
	return {
		...eventSpanBase(
			traceId,
			spanIdentifier(traceId, 'attempt', event.data.runId),
			event,
			`patch:${event.eventId}`,
		),
		kind: 'patch',
		name: 'agent_os.patch.produced',
		startedAt: null,
		completedAt: event.occurredAt,
		durationMs: null,
		timingSource: 'missing',
		status: 'ok',
		runId: event.data.runId,
		patchSha256: event.data.patchSha256,
		patchBytes: event.data.patchBytes,
		changedFileCount: event.data.changedFileCount,
	}
}

function validationSpan(
	traceId: string,
	event: Extract<TaskEvent, { type: 'ValidationCompleted' }>,
): ObservabilityTraceSpan {
	return {
		...eventSpanBase(
			traceId,
			spanIdentifier(traceId, 'attempt', event.data.runId),
			event,
			`validation:${event.eventId}`,
		),
		kind: 'validation',
		name: 'agent_os.validation',
		startedAt: event.data.startedAt ?? null,
		completedAt: event.data.completedAt ?? event.occurredAt,
		durationMs: event.data.durationMs ?? null,
		timingSource: event.data.durationMs === undefined ? 'missing' : 'measured',
		status: event.data.outcome === 'failed' ? 'error' : 'ok',
		runId: event.data.runId,
		outcome: event.data.outcome,
		commandCount: event.data.commandCount,
	}
}

function evaluationSpan(
	traceId: string,
	event: Extract<TaskEvent, { type: 'EvaluationCompleted' }>,
): ObservabilityTraceSpan {
	return {
		...eventSpanBase(
			traceId,
			spanIdentifier(traceId, 'attempt', event.data.runId),
			event,
			`evaluation:${event.eventId}`,
		),
		kind: 'evaluation',
		name: 'agent_os.evaluation',
		startedAt: event.data.startedAt ?? null,
		completedAt: event.data.completedAt ?? event.occurredAt,
		durationMs: event.data.durationMs ?? null,
		timingSource: event.data.durationMs === undefined ? 'missing' : 'measured',
		status: event.data.outcome === 'passed'
			? 'ok'
			: event.data.outcome === 'failed'
				? 'error'
				: 'unset',
		runId: event.data.runId,
		outcome: event.data.outcome,
		evaluatorCount: event.data.evaluatorIds.length,
		failedDimensions: [...event.data.failedDimensions],
		unknownDimensions: [...event.data.unknownDimensions],
	}
}

function taskCompletionSpan(
	traceId: string,
	rootSpanId: string,
	event: Extract<TaskEvent, { type: 'TaskCompleted' }>,
): ObservabilityTraceSpan {
	return {
		...eventSpanBase(traceId, rootSpanId, event, `task-completion:${event.eventId}`),
		kind: 'task_completion',
		name: 'agent_os.task.completed',
		startedAt: null,
		completedAt: event.data.completedAt ?? event.occurredAt,
		durationMs: null,
		timingSource: 'missing',
		status: traceStatus(event.data.status),
		runId: event.data.runId,
		runStatus: event.data.status,
	}
}

function patchApplicationSpan(
	traceId: string,
	rootSpanId: string,
	events: Array<TaskEvent>,
): ObservabilityTraceSpan {
	const requested = events[0]
	if (requested?.type !== 'PatchApplicationRequested') {
		throw invalidHistory('Patch application trace is missing its request')
	}
	const last = events.at(-1) ?? requested
	const approved = events.some(event => event.type === 'PatchApproved')
	const applied = last.type === 'PatchApplied' ? last : null
	const rejected = last.type === 'PatchApplicationRejected' ? last : null
	const applicationStatus = applied !== null
		? 'applied'
		: rejected !== null
			? 'rejected'
			: approved ? 'approved' : 'pending'
	return {
		traceId,
		spanId: spanIdentifier(traceId, 'patch-application', requested.eventId),
		parentSpanId: rootSpanId,
		sequence: requested.sequence,
		lastSequence: last.sequence,
		kind: 'patch_application',
		name: 'agent_os.patch.application',
		startedAt: requested.occurredAt,
		completedAt: applied?.occurredAt ?? rejected?.occurredAt ?? null,
		durationMs: journalDuration(
			requested.occurredAt,
			applied?.occurredAt ?? rejected?.occurredAt ?? null,
		),
		timingSource: applied === null && rejected === null ? 'missing' : 'journal',
		status: rejected === null
			? applied === null ? 'unset' : 'ok'
			: 'error',
		sourceEventIds: events.map(event => event.eventId),
		runId: requested.data.runId,
		applicationStatus,
		changedFileCount: applied?.data.changedFileCount ?? null,
		failureCode: rejected?.data.failureCode ?? null,
	}
}

function workflowDependencySpan(
	traceId: string,
	rootSpanId: string,
	started: Extract<WorkflowEvent, { type: 'WorkflowDependencyStateChanged' }>,
	completed: Extract<WorkflowEvent, { type: 'WorkflowDependencyStateChanged' }> | null,
): ObservabilityTraceSpan {
	return {
		traceId,
		spanId: spanIdentifier(traceId, 'workflow-dependency', started.eventId),
		parentSpanId: rootSpanId,
		sequence: started.sequence,
		lastSequence: completed?.sequence ?? started.sequence,
		kind: 'workflow_dependency',
		name: 'agent_os.workflow.dependency',
		startedAt: started.occurredAt,
		completedAt: completed?.occurredAt ?? null,
		durationMs: journalDuration(started.occurredAt, completed?.occurredAt ?? null),
		timingSource: completed === null ? 'missing' : 'journal',
		status: completed === null ? 'unset' : 'ok',
		sourceEventIds: completed === null
			? [started.eventId]
			: [started.eventId, completed.eventId],
		dependencyStatus: completed === null ? 'waiting' : 'ready',
	}
}

function workflowStageSpan(
	traceId: string,
	rootSpanId: string,
	started: Extract<WorkflowEvent, { type: 'WorkflowStageStarted' }>,
	result: Extract<WorkflowEvent, {
		type: 'WorkflowStageCompleted' | 'WorkflowStageInterrupted'
	}> | null,
): ObservabilityTraceSpan {
	const completed = result?.type === 'WorkflowStageCompleted' ? result : null
	const interrupted = result?.type === 'WorkflowStageInterrupted'
	return {
		traceId,
		spanId: spanIdentifier(traceId, 'workflow-stage', started.data.executionId),
		parentSpanId: rootSpanId,
		sequence: started.sequence,
		lastSequence: result?.sequence ?? started.sequence,
		kind: 'workflow_stage',
		name: `agent_os.workflow.stage.${started.data.stage}`,
		startedAt: started.occurredAt,
		completedAt: result?.occurredAt ?? null,
		durationMs: journalDuration(started.occurredAt, result?.occurredAt ?? null),
		timingSource: result === null ? 'missing' : 'journal',
		status: result === null
			? 'unset'
			: interrupted ? 'error' : traceStatus(completed?.data.status ?? 'failed'),
		sourceEventIds: result === null
			? [started.eventId]
			: [started.eventId, result.eventId],
		stage: started.data.stage,
		executionId: started.data.executionId,
		attemptNumber: started.data.attemptNumber,
		runId: completed?.data.runId ?? null,
		taskId: completed?.data.taskId ?? null,
		runStatus: completed?.data.status ?? (interrupted ? 'interrupted' : 'running'),
		failureCode: completed?.data.failureCode ?? null,
		linkedTraceId: completed?.data.taskId === null ||
			completed?.data.taskId === undefined
			? null
			: traceIdentifier('task', completed.data.taskId),
	}
}

function workflowApprovalSpan(
	traceId: string,
	rootSpanId: string,
	events: Array<WorkflowEvent>,
): ObservabilityTraceSpan {
	const requested = events[0]
	if (requested?.type !== 'WorkflowApprovalRequested') {
		throw invalidHistory('Workflow approval trace is missing its request')
	}
	const decision = events.find(
		(event): event is Extract<WorkflowEvent, { type: 'WorkflowApprovalDecided' }> =>
			event.type === 'WorkflowApprovalDecided',
	) ?? null
	return {
		traceId,
		spanId: spanIdentifier(traceId, 'workflow-approval', requested.eventId),
		parentSpanId: rootSpanId,
		sequence: requested.sequence,
		lastSequence: decision?.sequence ?? requested.sequence,
		kind: 'workflow_approval',
		name: 'agent_os.workflow.approval',
		startedAt: requested.occurredAt,
		completedAt: decision?.occurredAt ?? null,
		durationMs: journalDuration(requested.occurredAt, decision?.occurredAt ?? null),
		timingSource: decision === null ? 'missing' : 'journal',
		status: decision === null ? 'unset' : 'ok',
		sourceEventIds: decision === null
			? [requested.eventId]
			: [requested.eventId, decision.eventId],
		candidateRunId: requested.data.candidateRunId,
		decision: decision?.data.decision ?? 'pending',
	}
}

function workflowCompletionSpan(
	traceId: string,
	rootSpanId: string,
	event: Extract<WorkflowEvent, { type: 'WorkflowCompleted' }>,
): ObservabilityTraceSpan {
	return {
		...workflowEventSpanBase(
			traceId,
			rootSpanId,
			event,
			`workflow-completion:${event.eventId}`,
		),
		kind: 'workflow_completion',
		name: 'agent_os.workflow.completed',
		startedAt: null,
		completedAt: event.occurredAt,
		durationMs: null,
		timingSource: 'missing',
		status: traceStatus(event.data.status),
		workflowStatus: event.data.status,
		failureCode: event.data.failureCode,
	}
}

function eventSpanBase(
	traceId: string,
	parentSpanId: string,
	event: TaskEvent,
	identity: string,
): TraceSpanBase {
	return {
		traceId,
		spanId: spanIdentifier(traceId, identity, event.eventId),
		parentSpanId,
		sequence: event.sequence,
		lastSequence: event.sequence,
		name: '',
		startedAt: null,
		completedAt: event.occurredAt,
		durationMs: null,
		timingSource: 'missing',
		status: 'unset',
		sourceEventIds: [event.eventId],
	}
}

function workflowEventSpanBase(
	traceId: string,
	parentSpanId: string,
	event: WorkflowEvent,
	identity: string,
): TraceSpanBase {
	return {
		traceId,
		spanId: spanIdentifier(traceId, identity, event.eventId),
		parentSpanId,
		sequence: event.sequence,
		lastSequence: event.sequence,
		name: '',
		startedAt: null,
		completedAt: event.occurredAt,
		durationMs: null,
		timingSource: 'missing',
		status: 'unset',
		sourceEventIds: [event.eventId],
	}
}

function aggregateMetrics(
	query: ObservabilityMetricQuery,
	timelines: Array<TaskTimeline>,
	check: () => void,
): ObservabilityMetricsSnapshot {
	const taskStatusCounts = emptyTaskStatusCounts()
	const attemptStatusCounts = emptyRunStatusCounts()
	const evaluationCounts = emptyEvaluationCounts()
	const failedDimensions = new Map<EvaluationDimensionId, number>()
	const attempts: Array<AttemptObservation> = []
	const workerAttempts = new Map<string, Array<AttemptObservation>>()
	const taskDurations: Array<number> = []
	const routingDurations: Array<number> = []
	const modelDurations: Array<number> = []
	const toolDurations: Array<number> = []
	const validationDurations: Array<number> = []
	const evaluationDurations: Array<number> = []
	const reportedTokensPerTask: Array<number> = []
	const costsPerTask: Array<number> = []
	const schemas = new Set<number>()
	const modelObservedRuns = new Set<string>()
	let attemptedTaskCount = 0
	let retryAttemptCount = 0
	let fallbackTaskCount = 0
	let clockAnomalyCount = 0
	let routeSelectedCount = 0
	let legacyTaskCount = 0

	for (const timeline of timelines) {
		check()
		incrementTaskStatus(taskStatusCounts, timeline.task.status)
		for (const event of timeline.events) {
			check()
			schemas.add(event.schemaVersion)
		}
		if ((timeline.events[0]?.schemaVersion ?? 7) < 7) {
			legacyTaskCount += 1
		}
		const taskObservations = collectAttemptObservations(timeline, check)
		attempts.push(...taskObservations)
		if (taskObservations.length > 0) {
			attemptedTaskCount += 1
			retryAttemptCount += Math.max(0, taskObservations.length - 1)
			if (taskObservations.length > 1) {
				fallbackTaskCount += 1
			}
		}
		for (const observation of taskObservations) {
			check()
			const byWorker = workerAttempts.get(observation.workerId) ?? []
			byWorker.push(observation)
			workerAttempts.set(observation.workerId, byWorker)
			if (observation.status !== null) {
				incrementRunStatus(attemptStatusCounts, observation.status)
			}
			if (observation.evaluation !== null) {
				incrementEvaluation(evaluationCounts, observation.evaluation)
			}
			for (const dimension of observation.failedDimensions) {
				failedDimensions.set(
					dimension,
					(failedDimensions.get(dimension) ?? 0) + 1,
				)
			}
		}
		const taskCompleted = timeline.events.find(
			(event): event is Extract<TaskEvent, { type: 'TaskCompleted' }> =>
				event.type === 'TaskCompleted',
		)
		if (taskCompleted?.data.durationMs !== undefined) {
			taskDurations.push(taskCompleted.data.durationMs)
		}
		for (const event of timeline.events) {
			check()
			switch (event.type) {
				case 'RouteSelected':
					routeSelectedCount += 1
					if (event.data.durationMs !== undefined) {
						routingDurations.push(event.data.durationMs)
					}
					break
				case 'ModelTurnCompleted':
					modelDurations.push(event.data.durationMs)
					modelObservedRuns.add(event.data.runId)
					break
				case 'ToolCalled':
					toolDurations.push(event.data.durationMs)
					break
				case 'ValidationCompleted':
					if (event.data.durationMs !== undefined) {
						validationDurations.push(event.data.durationMs)
					}
					break
				case 'EvaluationCompleted':
					if (event.data.durationMs !== undefined) {
						evaluationDurations.push(event.data.durationMs)
					}
					break
			}
		}
		if (
			timeline.task.status !== 'in_progress' &&
			taskObservations.length > 0 &&
			taskObservations.every(item => item.reportedTotalTokens !== null)
		) {
			reportedTokensPerTask.push(checkedSum(
				taskObservations.map(item => item.reportedTotalTokens ?? 0),
			))
		}
		if (
			timeline.task.status !== 'in_progress' &&
			taskObservations.length > 0 &&
			taskObservations.every(item => item.estimatedCostMicroUsd !== null)
		) {
			costsPerTask.push(checkedSum(
				taskObservations.map(item => item.estimatedCostMicroUsd ?? 0),
			))
		}
		clockAnomalyCount += countClockAnomalies(timeline.events, check)
	}

	const terminalCount = timelines.filter(
		timeline => timeline.task.status !== 'in_progress',
	).length
	const completedTasks = taskStatusCounts.completed
	const terminalAttempts = attempts.filter(item => item.status !== null)
	const completedAttempts = attemptStatusCounts.completed
	const producedRuns = new Set(
		attempts.filter(item => item.patchProduced).map(item => item.runId),
	)
	const appliedRuns = new Set(
		attempts.filter(item => item.patchApplied).map(item => item.runId),
	)
	const attemptDurations = attempts.flatMap(item =>
		item.durationMs === null ? [] : [item.durationMs],
	)
	const providerDurations = attempts.flatMap(item =>
		item.providerLatencyMs === null ? [] : [item.providerLatencyMs],
	)
	const pricedAttemptCount = terminalAttempts.filter(
		item => item.estimatedCostMicroUsd !== null,
	).length
	const deterministic = {
		schemaVersion: 1 as const,
		mode: query.mode,
		taskLimit: query.taskLimit,
		observedThrough: timelines[0]?.task.updatedAt ?? null,
		sampledTaskCount: timelines.length,
		sampledAttemptCount: attempts.length,
		sources: timelines.map(timeline => ({
			taskId: timeline.task.taskId,
			latestEventSha256: timeline.task.latestEventSha256,
		})),
		tasks: {
			statusCounts: taskStatusCounts,
			terminalCount,
			successRate: ratio(completedTasks, terminalCount),
			retryAttemptRate: ratio(retryAttemptCount, attempts.length),
			fallbackTaskRate: ratio(fallbackTaskCount, attemptedTaskCount),
		},
		attempts: {
			statusCounts: attemptStatusCounts,
			successRate: ratio(completedAttempts, terminalAttempts.length),
		},
		evaluations: {
			counts: evaluationCounts,
			failureRate: ratio(
				evaluationCounts.failed,
				evaluationCounts.passed +
					evaluationCounts.failed +
					evaluationCounts.inconclusive,
			),
			failedDimensions: [...failedDimensions]
				.map(([dimension, count]) => ({ dimension, count }))
				.sort((left, right) => left.dimension.localeCompare(right.dimension)),
		},
		patches: {
			producedRunCount: producedRuns.size,
			appliedRunCount: appliedRuns.size,
			acceptanceRate: ratio(appliedRuns.size, producedRuns.size),
		},
		durationMs: {
			task: distribution(taskDurations),
			routing: distribution(routingDurations),
			attempt: distribution(attemptDurations),
			model: distribution(modelDurations),
			tool: distribution(toolDurations),
			validation: distribution(validationDurations),
			evaluation: distribution(evaluationDurations),
			provider: distribution(providerDurations),
		},
		usage: {
			reportedTokensPerFullyMeasuredTask: distribution(reportedTokensPerTask),
			estimatedCostPerFullyPricedTaskMicroUsd: distribution(costsPerTask),
			reportedTokenAttemptCount: terminalAttempts.filter(
				item => item.reportedTotalTokens !== null,
			).length,
			pricedAttemptCount,
			unpricedAttemptCount: terminalAttempts.length - pricedAttemptCount,
			fullyPricedTaskCount: costsPerTask.length,
		},
		coverage: {
			eventSchemaVersions: [...schemas].sort((left, right) => left - right),
			legacyTaskCount,
			measuredTaskDurationCount: taskDurations.length,
			unmeasuredTaskDurationCount: timelines.length - taskDurations.length,
			measuredRoutingDurationCount: routingDurations.length,
			unmeasuredRoutingDurationCount:
				routeSelectedCount - routingDurations.length,
			measuredAttemptCount: attemptDurations.length,
			unmeasuredTerminalAttemptCount:
				terminalAttempts.length - attemptDurations.length,
			modelTurnCount: modelDurations.length,
			attemptsWithoutModelTurnCount: attempts.filter(
				item => !modelObservedRuns.has(item.runId),
			).length,
			clockAnomalyCount,
		},
		workers: [...workerAttempts]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([workerId, observations]) =>
				workerMetrics(workerId, observations)
			),
	}
	return {
		...deterministic,
		sha256: createHash('sha256')
			.update(JSON.stringify(deterministic))
			.digest('hex'),
	}
}

function collectAttemptObservations(
	timeline: TaskTimeline,
	check: () => void,
): Array<AttemptObservation> {
	const observations = new Map<string, AttemptObservation>()
	for (const event of timeline.events) {
		check()
		switch (event.type) {
			case 'WorkerStarted':
				observations.set(event.data.runId, {
					runId: event.data.runId,
					workerId: event.data.workerId,
					attemptNumber: event.data.attemptNumber,
					status: null,
					failureCode: null,
					durationMs: null,
					providerLatencyMs: null,
					reportedTotalTokens: null,
					estimatedCostMicroUsd: null,
					evaluation: null,
					failedDimensions: [],
					patchProduced: false,
					patchApplied: false,
				})
				break
			case 'EvaluationCompleted': {
				const observation = requireObservation(observations, event.data.runId)
				observation.evaluation = event.data.outcome
				observation.failedDimensions = [...event.data.failedDimensions]
				break
			}
			case 'PatchProduced':
				requireObservation(observations, event.data.runId).patchProduced = true
				break
			case 'AttemptCompleted': {
				const observation = requireObservation(observations, event.data.runId)
				observation.status = event.data.status
				observation.failureCode = event.data.failureCode
				observation.durationMs = event.data.durationMs ?? null
				observation.providerLatencyMs = event.data.providerLatencyMs ?? null
				observation.reportedTotalTokens = event.data.totalTokens ?? null
				observation.estimatedCostMicroUsd =
					event.data.estimatedCostMicroUsd ?? null
				break
			}
			case 'PatchApplied':
				requireObservation(observations, event.data.runId).patchApplied = true
				break
		}
	}
	return [...observations.values()].sort(
		(left, right) => left.attemptNumber - right.attemptNumber,
	)
}

function workerMetrics(
	workerId: string,
	observations: Array<AttemptObservation>,
): WorkerObservabilityMetrics {
	const statusCounts = emptyRunStatusCounts()
	const evaluationCounts = emptyEvaluationCounts()
	for (const observation of observations) {
		if (observation.status !== null) {
			incrementRunStatus(statusCounts, observation.status)
		}
		if (observation.evaluation !== null) {
			incrementEvaluation(evaluationCounts, observation.evaluation)
		}
	}
	const produced = observations.filter(item => item.patchProduced)
	const applied = produced.filter(item => item.patchApplied)
	const evaluationTotal = evaluationCounts.passed +
		evaluationCounts.failed + evaluationCounts.inconclusive
	const terminalCount = observations.filter(item => item.status !== null).length
	return {
		workerId,
		attemptCount: observations.length,
		statusCounts,
		successRate: ratio(statusCounts.completed, terminalCount),
		evaluationCounts,
		evaluationFailureRate: ratio(evaluationCounts.failed, evaluationTotal),
		patchProducedCount: produced.length,
		patchAppliedCount: applied.length,
		patchAcceptanceRate: ratio(applied.length, produced.length),
		attemptDurationMs: distribution(observations.flatMap(
			item => item.durationMs === null ? [] : [item.durationMs],
		)),
		providerLatencyMs: distribution(observations.flatMap(
			item => item.providerLatencyMs === null ? [] : [item.providerLatencyMs],
		)),
		reportedTotalTokens: distribution(observations.flatMap(
			item => item.reportedTotalTokens === null
				? []
				: [item.reportedTotalTokens],
		)),
		estimatedCostMicroUsd: distribution(observations.flatMap(
			item => item.estimatedCostMicroUsd === null
				? []
				: [item.estimatedCostMicroUsd],
		)),
	}
}

function paginateTrace(
	trace: ObservabilityTrace,
	query: TracePageQuery,
	check: () => void,
): ObservabilityTrace {
	check()
	let startIndex = 0
	if (query.cursor !== null) {
		const cursorIndex = trace.spans.findIndex(span => {
			check()
			return span.spanId === query.cursor
		})
		if (cursorIndex === -1) {
			throw new HarnessError(
				'INVALID_OBSERVABILITY_CURSOR',
				'Observability cursor is not present in this trace',
			)
		}
		startIndex = cursorIndex + 1
	}
	const spans = trace.spans.slice(startIndex, startIndex + query.limit)
	const hasMore = startIndex + spans.length < trace.spans.length
	check()
	return {
		...trace,
		spans,
		nextCursor: hasMore ? spans.at(-1)?.spanId ?? null : null,
	}
}

function eventTiming(
	event: TaskEvent,
): { startedAt: string | null; completedAt: string | null; durationMs: number | null } {
	if (
		event.type === 'RouteSelected' ||
		event.type === 'ModelTurnCompleted' ||
		event.type === 'ToolCalled' ||
		event.type === 'ValidationCompleted' ||
		event.type === 'EvaluationCompleted' ||
		event.type === 'AttemptCompleted'
	) {
		return {
			startedAt: event.data.startedAt ?? null,
			completedAt: event.data.completedAt ?? event.occurredAt,
			durationMs: event.data.durationMs ?? null,
		}
	}
	return { startedAt: null, completedAt: event.occurredAt, durationMs: null }
}

function countClockAnomalies(
	events: Array<TaskEvent>,
	check: () => void,
): number {
	let anomalies = 0
	let previous = -Infinity
	for (const event of events) {
		check()
		const occurredAt = Date.parse(event.occurredAt)
		if (occurredAt < previous) {
			anomalies += 1
		}
		previous = occurredAt
		const timing = eventTiming(event)
		if (
			timing.startedAt !== null &&
			timing.completedAt !== null &&
			Date.parse(timing.completedAt) < Date.parse(timing.startedAt)
		) {
			anomalies += 1
		}
	}
	return anomalies
}

function countEventClockAnomalies(
	events: Array<TaskEvent> | Array<WorkflowEvent>,
	check: () => void,
): number {
	let anomalies = 0
	let previous = -Infinity
	for (const event of events) {
		check()
		const occurredAt = Date.parse(event.occurredAt)
		if (occurredAt < previous) {
			anomalies += 1
		}
		previous = occurredAt
	}
	return anomalies
}

function journalDuration(
	startedAt: string,
	completedAt: string | null,
): number | null {
	if (completedAt === null) {
		return null
	}
	const duration = Date.parse(completedAt) - Date.parse(startedAt)
	return Number.isSafeInteger(duration) && duration >= 0 ? duration : null
}

function requireAttempt(
	attempts: Map<string, {
		started: Extract<TaskEvent, { type: 'WorkerStarted' }>
		workerCompleted: Extract<TaskEvent, { type: 'WorkerCompleted' }> | null
		completed: Extract<TaskEvent, { type: 'AttemptCompleted' }> | null
	}>,
	runId: string,
) {
	const attempt = attempts.get(runId)
	if (attempt === undefined) {
		throw invalidHistory('Task trace event has no matching attempt')
	}
	return attempt
}

function requireObservation(
	observations: Map<string, AttemptObservation>,
	runId: string,
): AttemptObservation {
	const observation = observations.get(runId)
	if (observation === undefined) {
		throw invalidHistory('Task metric event has no matching attempt')
	}
	return observation
}

function traceIdentifier(kind: string, id: string): string {
	return digestIdentifier(`agent-os:${kind}:${id}`, 32)
}

function spanIdentifier(traceId: string, kind: string, id: string): string {
	return digestIdentifier(`${traceId}:${kind}:${id}`, 16)
}

function digestIdentifier(value: string, length: number): string {
	const identifier = createHash('sha256').update(value).digest('hex').slice(0, length)
	return /^0+$/.test(identifier)
		? `${identifier.slice(0, -1)}1`
		: identifier
}

function compareSpans(
	left: ObservabilityTraceSpan,
	right: ObservabilityTraceSpan,
): number {
	return left.sequence - right.sequence || left.spanId.localeCompare(right.spanId)
}

function traceStatus(status: TaskStatus | WorkflowStatus): TraceSpanStatus {
	return status === 'in_progress' ||
		status === 'pending' ||
		status === 'running' ||
		status === 'waiting_for_dependency' ||
		status === 'waiting_for_approval'
		? 'unset'
		: status === 'completed' ? 'ok' : 'error'
}

function workflowStageMode(stage: WorkflowWorkerStageName): WorkerMode {
	if (stage === 'plan') {
		return 'research'
	}
	if (stage === 'test') {
		return 'testing'
	}
	if (stage === 'review') {
		return 'review'
	}
	return 'implementation'
}

function ratio(numerator: number, denominator: number): RatioMetric {
	return {
		numerator,
		denominator,
		basisPoints: denominator === 0
			? null
			: Number(
				(BigInt(numerator) * 10_000n + BigInt(Math.floor(denominator / 2))) /
					BigInt(denominator),
			),
	}
}

function distribution(values: Array<number>): DistributionMetric {
	if (values.length === 0) {
		return {
			sampleCount: 0,
			minimum: null,
			median: null,
			p95: null,
			maximum: null,
			total: 0,
			average: null,
		}
	}
	const sorted = [...values].sort((left, right) => left - right)
	const total = checkedSum(sorted)
	const middle = Math.floor(sorted.length / 2)
	const median = sorted.length % 2 === 1
		? sorted[middle] ?? null
		: roundedAverage(sorted[middle - 1] ?? 0, sorted[middle] ?? 0)
	const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1)
	return {
		sampleCount: sorted.length,
		minimum: sorted[0] ?? null,
		median,
		p95: sorted[p95Index] ?? null,
		maximum: sorted.at(-1) ?? null,
		total,
		average: roundedQuotient(total, sorted.length),
	}
}

function checkedSum(values: Array<number>): number {
	let total = 0n
	for (const value of values) {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw invalidHistory('Observability metric contains an invalid number')
		}
		total += BigInt(value)
		if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
			throw new HarnessError(
				'OBSERVABILITY_COUNTER_OVERFLOW',
				'Observability metric exceeds the safe integer range',
			)
		}
	}
	return Number(total)
}

function roundedAverage(left: number, right: number): number {
	return Number((BigInt(left) + BigInt(right) + 1n) / 2n)
}

function roundedQuotient(total: number, count: number): number {
	return Number(
		(BigInt(total) + BigInt(Math.floor(count / 2))) / BigInt(count),
	)
}

function emptyRunStatusCounts(): RunStatusCounts {
	return {
		completed: 0,
		failed: 0,
		blocked: 0,
		policyViolation: 0,
		timedOut: 0,
		cancelled: 0,
	}
}

function emptyTaskStatusCounts(): TaskStatusCounts {
	return { ...emptyRunStatusCounts(), inProgress: 0 }
}

function emptyEvaluationCounts(): EvaluationOutcomeCounts {
	return { passed: 0, failed: 0, inconclusive: 0 }
}

function incrementRunStatus(counts: RunStatusCounts, status: RunStatus): void {
	counts[statusKey(status)] += 1
}

function incrementTaskStatus(counts: TaskStatusCounts, status: TaskStatus): void {
	if (status === 'in_progress') {
		counts.inProgress += 1
		return
	}
	incrementRunStatus(counts, status)
}

function incrementEvaluation(
	counts: EvaluationOutcomeCounts,
	outcome: EvaluationOutcome,
): void {
	counts[outcome] += 1
}

function statusKey(status: RunStatus): keyof RunStatusCounts {
	switch (status) {
		case 'policy_violation': return 'policyViolation'
		case 'timed_out': return 'timedOut'
		default: return status
	}
}

function assertTraceQuery(query: TracePageQuery): void {
	if (
		!Number.isSafeInteger(query.limit) ||
		query.limit < 1 ||
		query.limit > maxTracePageSize ||
		(query.cursor !== null && !spanIdPattern.test(query.cursor))
	) {
		throw new HarnessError(
			'INVALID_OBSERVABILITY_QUERY',
			`Trace limit must be 1-${maxTracePageSize} and cursor must be a span ID`,
		)
	}
}

function assertMetricQuery(query: ObservabilityMetricQuery): void {
	if (
		!isWorkerMode(query.mode) ||
		!Number.isSafeInteger(query.taskLimit) ||
		query.taskLimit < 1 ||
		query.taskLimit > maxMetricTaskCount
	) {
		throw new HarnessError(
			'INVALID_OBSERVABILITY_QUERY',
			`Metric task limit must be 1-${maxMetricTaskCount}`,
		)
	}
}

function isWorkerMode(value: unknown): value is WorkerMode {
	return value === 'implementation' ||
		value === 'testing' ||
		value === 'review' ||
		value === 'research'
}

function invalidHistory(message: string): HarnessError {
	return new HarnessError('INVALID_OBSERVABILITY_HISTORY', message)
}
