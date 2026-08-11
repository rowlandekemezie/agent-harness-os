export type WorkerMode = 'research' | 'implementation' | 'testing' | 'review'

export type ExecutionBackend = 'local' | 'docker'

export type WorkerAdapter = 'openai-compatible' | 'anthropic' | 'codex'

export type WorkerCapability =
	| WorkerMode
	| 'tool-calling'
	| 'long-context'
	| 'private'

export type WorkerCostTier = 'low' | 'medium' | 'high'

export type WorkerLatencyTier = 'fast' | 'standard' | 'slow'

export type RoutingStrategy = 'balanced' | 'cost' | 'latency' | 'quality'

export type WorkerRoutingPolicy = {
	preferredWorkerId: string | null
	requiredCapabilities: Array<WorkerCapability>
	strategy: RoutingStrategy
	maxCostTier: WorkerCostTier | null
	maxLatencyTier: WorkerLatencyTier | null
	allowFallback: boolean
	maxAttempts: number
}

export type PolicySource = {
	scope: 'organization' | 'repository'
	location: string
	sha256: string
}

export type ResolvedPolicy = {
	schemaVersion: 1
	digest: string
	sources: Array<PolicySource>
	maxChangedFiles: number
	maxIterations: number
	maxTaskSeconds: number
	allowNetwork: boolean
	prohibitedPaths: Array<string>
	routing: {
		requiredCapabilities: Array<WorkerCapability>
		maxCostTier: WorkerCostTier | null
		maxLatencyTier: WorkerLatencyTier | null
		allowFallback: boolean
		maxAttempts: number
	}
}

export type RunStatus =
	| 'completed'
	| 'failed'
	| 'blocked'
	| 'policy_violation'
	| 'timed_out'
	| 'cancelled'

export type TaskStatus = 'in_progress' | RunStatus

export type PatchApplicationStatus =
	| 'not_requested'
	| 'pending'
	| 'approved'
	| 'applied'
	| 'rejected'

export type CommandSpec = {
	command: string
	args: Array<string>
	timeoutMs?: number
}

export type AcceptanceCriterionResult = {
	criterion: string
	status: 'passed' | 'failed' | 'unknown'
	evidence: Array<string>
}

export type EvaluationDimensionId =
	| 'worker_execution'
	| 'tests'
	| 'lint'
	| 'typecheck'
	| 'changed_files_scope'
	| 'acceptance_criteria'
	| 'patch_size'
	| 'new_warnings'
	| 'security_policy_compliance'
	| 'correctness'
	| 'maintainability'
	| 'architecture_fit'
	| 'test_quality'

export type EvaluationDimensionStatus =
	| 'passed'
	| 'failed'
	| 'unknown'
	| 'not_applicable'

export type EvaluationDimensionResult = {
	id: EvaluationDimensionId
	status: EvaluationDimensionStatus
	summary: string
	evidence: Array<string>
}

export type EvaluationOutcome = 'passed' | 'failed' | 'inconclusive'

export type EvaluationResult = {
	schemaVersion: 1
	evaluatorId: string
	evaluatorKind: 'deterministic' | 'model'
	evaluatedAt: string
	outcome: EvaluationOutcome
	dimensions: Array<EvaluationDimensionResult>
}

export type EvaluationSummary = {
	schemaVersion: 1
	evaluatedAt: string
	outcome: EvaluationOutcome
	results: Array<EvaluationResult>
}

export type EvaluationInput = {
	runId: string
	objective: string
	mode: WorkerMode
	baseCommit: string
	allowedPaths: Array<string>
	prohibitedPaths: Array<string>
	candidatePatch: string
	runStatus: RunStatus
	failureCode: string | null
	requiredCommands: Array<CommandSpec>
	commandResults: Array<CommandResult>
	changedFiles: Array<string>
	patchBytes: number
	acceptanceCriteria: Array<AcceptanceCriterionResult>
	policyViolations: Array<string>
	warnings: Array<string>
	maxChangedFiles: number
	maxPatchBytes: number
	deadlineMs: number
}

export type CommandResult = {
	command: string
	args: Array<string>
	exitCode: number | null
	signal: string | null
	stdout: string
	stderr: string
	durationMs: number
	timedOut: boolean
	outputTruncated: boolean
}

export type WorkerTask = {
	objective: string
	repositoryPath: string
	mode: WorkerMode
	allowedPaths: Array<string>
	prohibitedPaths: Array<string>
	acceptanceCriteria: Array<string>
	requiredCommands: Array<CommandSpec>
	baseRef: string
	maxIterations: number
	timeoutSeconds: number
	allowNetwork: boolean
	routing?: WorkerRoutingPolicy
	candidateRunId?: string
	workflowProvenance?: WorkflowTaskProvenance
}

export type WorkflowWorkerStageName =
	| 'plan'
	| 'implement'
	| 'test'
	| 'review'
	| 'repair'

export type WorkflowStageName = WorkflowWorkerStageName | 'approval'

export type WorkflowWorkerStage = {
	objective: string
	allowedPaths: Array<string>
	prohibitedPaths: Array<string>
	acceptanceCriteria: Array<string>
	requiredCommands: Array<CommandSpec>
	maxIterations: number
	timeoutSeconds: number
	allowNetwork: boolean
	routing: WorkerRoutingPolicy
	retryLimit: number
}

export type WorkflowTaskProvenance = {
	workflowId: string
	stage: WorkflowWorkerStageName
	executionId: string
	stageContractSha256: string
	sourceRunId: string | null
}

export type WorkflowDefinition = {
	schemaVersion: 1
	objective: string
	repositoryPath: string
	baseCommit: string
	deadlineAt: string
	maxTransitions: number
	maxRepairAttempts: number
	dependencyWorkflowIds: Array<string>
	stages: {
		plan: WorkflowWorkerStage | null
		implement: WorkflowWorkerStage
		test: WorkflowWorkerStage | null
		review: WorkflowWorkerStage | null
		repair: WorkflowWorkerStage | null
	}
}

export type WorkflowStatus =
	| 'pending'
	| 'running'
	| 'waiting_for_dependency'
	| 'waiting_for_approval'
	| 'completed'
	| 'failed'
	| 'blocked'
	| 'timed_out'
	| 'cancelled'

export type WorkflowSummary = {
	schemaVersion: 1
	workflowId: string
	objective: string
	repositoryPath: string
	baseCommit: string
	createdAt: string
	updatedAt: string
	deadlineAt: string
	status: WorkflowStatus
	currentStage: WorkflowStageName | null
	activeExecutionId: string | null
	candidateRunId: string | null
	transitionCount: number
	repairAttemptCount: number
	stageAttempts: Partial<Record<WorkflowWorkerStageName, number>>
	approvalDecision: 'approved' | 'rejected' | null
	lastFailureCode: string | null
	eventCount: number
	latestEventSha256: string
}

export type WorkflowEventBase = {
	schemaVersion: 1
	eventId: string
	workflowId: string
	sequence: number
	occurredAt: string
	previousEventSha256: string | null
}

export type WorkflowCreatedEvent = WorkflowEventBase & {
	type: 'WorkflowCreated'
	data: { definition: WorkflowDefinition }
}

export type WorkflowStageStartedEvent = WorkflowEventBase & {
	type: 'WorkflowStageStarted'
	data: {
		stage: WorkflowWorkerStageName
		executionId: string
		attemptNumber: number
		sourceRunId: string | null
	}
}

export type WorkflowStageInterruptedEvent = WorkflowEventBase & {
	type: 'WorkflowStageInterrupted'
	data: {
		stage: WorkflowWorkerStageName
		executionId: string
		reason: 'resume' | 'cancel' | 'deadline'
	}
}

export type WorkflowDependencyStateChangedEvent = WorkflowEventBase & {
	type: 'WorkflowDependencyStateChanged'
	data: { state: 'waiting' | 'ready' }
}

export type WorkflowStageCompletedEvent = WorkflowEventBase & {
	type: 'WorkflowStageCompleted'
	data: {
		stage: WorkflowWorkerStageName
		executionId: string
		taskId: string | null
		runId: string | null
		status: RunStatus
		failureCode: string | null
		candidateRunId: string | null
		nextStage: WorkflowStageName | null
	}
}

export type WorkflowApprovalRequestedEvent = WorkflowEventBase & {
	type: 'WorkflowApprovalRequested'
	data: { candidateRunId: string }
}

export type WorkflowApprovalDecidedEvent = WorkflowEventBase & {
	type: 'WorkflowApprovalDecided'
	data: {
		decision: 'approved' | 'rejected'
		feedback: string
		source: 'mcp_call'
		nextStage: 'repair' | null
	}
}

export type WorkflowCompletedEvent = WorkflowEventBase & {
	type: 'WorkflowCompleted'
	data: {
		status: 'completed' | 'failed' | 'blocked' | 'timed_out' | 'cancelled'
		failureCode: string | null
		candidateRunId: string | null
	}
}

export type WorkflowEvent =
	| WorkflowCreatedEvent
	| WorkflowStageStartedEvent
	| WorkflowStageInterruptedEvent
	| WorkflowDependencyStateChangedEvent
	| WorkflowStageCompletedEvent
	| WorkflowApprovalRequestedEvent
	| WorkflowApprovalDecidedEvent
	| WorkflowCompletedEvent

export type WorkflowEventInput = WorkflowEvent extends infer Event
	? Event extends WorkflowEvent
		? Omit<Event, keyof WorkflowEventBase>
		: never
	: never

export type WorkflowTimeline = {
	definition: WorkflowDefinition
	summary: WorkflowSummary
	events: Array<WorkflowEvent>
}

export type WorkflowPage = {
	workflows: Array<WorkflowSummary>
	nextCursor: string | null
}

export type ProviderUsage = {
	requestCount: number
	inputTokens: number
	outputTokens: number
	totalTokens: number
	totalLatencyMs: number
	estimatedCostUsd: number | null
}

export type WorkerAttemptSummary = {
	runId: string
	workerId: string
	status: RunStatus
	failureCode: string | null
}

export type WorkerRoutingEvidence = {
	workerId: string
	mode: WorkerMode
	sampleSize: number
	successCount: number
	evaluationCount: number
	evaluationPassCount: number
	patchProducedCount: number
	patchAppliedCount: number
	medianDurationMs: number
	averageProviderLatencyMs: number
	averageTotalTokens: number
	estimatedCostSampleCount: number
	averageEstimatedCostMicroUsd: number | null
}

export type RoutingEvidenceTaskSource = {
	taskId: string
	latestEventSha256: string
}

export type RoutingEvidenceSnapshot = {
	schemaVersion: 1
	mode: WorkerMode
	taskLimit: number
	sampledTaskCount: number
	sampledAttemptCount: number
	sources: Array<RoutingEvidenceTaskSource>
	workers: Array<WorkerRoutingEvidence>
	sha256: string
}

export type WorkerRouteCandidateMetadata = {
	workerId: string
	score: number
	reasons: Array<string>
}

export type WorkerRoutingMetadata = {
	strategy: RoutingStrategy
	requiredCapabilities: Array<WorkerCapability>
	candidateWorkerIds: Array<string>
	selectedWorkerId: string
	attemptNumber: number
	maxAttempts: number
	fallbackEnabled: boolean
	previousAttempts: Array<WorkerAttemptSummary>
	evidence?: RoutingEvidenceSnapshot
	candidates?: Array<WorkerRouteCandidateMetadata>
	decisionSha256?: string
}

export type WorkerRunReport = {
	schemaVersion: 1 | 2 | 3
	taskId?: string
	runId: string
	status: RunStatus
	failureCode?: string | null
	objective: string
	mode: WorkerMode
	repositoryPath: string
	baseRef: string
	startedAt: string
	completedAt: string
	durationMs: number
	workerSummary: string
	changedFiles: Array<string>
	patchPath: string | null
	patchSha256: string | null
	reportPath: string
	commandResults: Array<CommandResult>
	acceptanceCriteria: Array<AcceptanceCriterionResult>
	policyViolations: Array<string>
	warnings: Array<string>
	workflowProvenance?: WorkflowTaskProvenance | null
	evaluation?: EvaluationSummary
	policy?: ResolvedPolicy
	provider: {
		workerId?: string
		adapter?: WorkerAdapter
		profile?: {
			backingWorkerId: string
			role: WorkerMode
			maxIterations: number
			evaluationPolicy: 'default' | 'strict'
		}
		baseUrl: string
		model: string
		requestCount: number
		inputTokens?: number
		outputTokens?: number
		totalTokens?: number
		totalLatencyMs?: number
		estimatedCostUsd?: number | null
	}
	routing?: WorkerRoutingMetadata
}

export type TaskSummary = {
	schemaVersion: 1
	taskId: string
	objective: string
	mode: WorkerMode
	repositoryPath: string
	baseCommit: string
	createdAt: string
	updatedAt: string
	status: TaskStatus
	attemptCount: number
	latestRunId: string | null
	workerIds: Array<string>
	eventCount: number
	latestEventSha256: string
	patchApplicationStatus: PatchApplicationStatus
	policySha256: string | null
}

export type TaskEventBase = {
	schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7
	eventId: string
	taskId: string
	sequence: number
	occurredAt: string
	previousEventSha256: string | null
}

export type TaskCreatedEvent = TaskEventBase & {
	type: 'TaskCreated'
	data: {
		objective: string
		mode: WorkerMode
		repositoryPath: string
		baseCommit: string
		executionStartedAt?: string
		policySha256?: string
		policySourceCount?: number
		workflowProvenance?: WorkflowTaskProvenance | null
	}
}

export type RouteSelectedEvent = TaskEventBase & {
	type: 'RouteSelected'
	data: {
		strategy: RoutingStrategy
		candidateWorkerIds: Array<string>
		maxAttempts: number
		startedAt?: string
		completedAt?: string
		durationMs?: number
		evidenceSha256?: string
		evidenceTaskCount?: number
		evidenceAttemptCount?: number
		decisionSha256?: string
	}
}

export type WorkerStartedEvent = TaskEventBase & {
	type: 'WorkerStarted'
	data: {
		runId: string
		workerId: string
		attemptNumber: number
	}
}

export type ToolCalledEvent = TaskEventBase & {
	type: 'ToolCalled'
	data: {
		runId: string
		toolName: string
		iteration: number
		outcome: 'succeeded' | 'failed'
		inputBytes: number
		outputBytes: number
		durationMs: number
		startedAt?: string
		completedAt?: string
	}
}

export type ModelTurnCompletedEvent = TaskEventBase & {
	type: 'ModelTurnCompleted'
	data: {
		runId: string
		iteration: number
		outcome: 'succeeded' | 'failed'
		toolCallCount: number
		startedAt: string
		completedAt: string
		durationMs: number
	}
}

export type WorkerCompletedEvent = TaskEventBase & {
	type: 'WorkerCompleted'
	data: {
		runId: string
		outcome: 'succeeded' | 'failed'
		failureCode: string | null
		requestCount: number
	}
}

export type PatchProducedEvent = TaskEventBase & {
	type: 'PatchProduced'
	data: {
		runId: string
		patchSha256: string
		patchBytes: number
		changedFileCount: number
	}
}

export type ValidationCompletedEvent = TaskEventBase & {
	type: 'ValidationCompleted'
	data: {
		runId: string
		outcome: 'passed' | 'failed' | 'skipped'
		commandCount: number
		startedAt?: string
		completedAt?: string
		durationMs?: number
	}
}

export type EvaluationCompletedEvent = TaskEventBase & {
	type: 'EvaluationCompleted'
	data: {
		runId: string
		evaluatorIds: Array<string>
		outcome: EvaluationOutcome
		evaluationPolicy?: 'default' | 'strict'
		failedDimensions: Array<EvaluationDimensionId>
		unknownDimensions: Array<EvaluationDimensionId>
		startedAt?: string
		completedAt?: string
		durationMs?: number
	}
}

export type AttemptCompletedEvent = TaskEventBase & {
	type: 'AttemptCompleted'
	data: {
		runId: string
		status: RunStatus
		failureCode: string | null
		startedAt?: string
		completedAt?: string
		durationMs?: number
		providerLatencyMs?: number
		totalTokens?: number
		estimatedCostMicroUsd?: number | null
	}
}

export type TaskCompletedEvent = TaskEventBase & {
	type: 'TaskCompleted'
	data: {
		runId: string | null
		status: RunStatus
		completedAt?: string
		durationMs?: number
	}
}

export type PatchApplicationRequestedEvent = TaskEventBase & {
	type: 'PatchApplicationRequested'
	data: { runId: string }
}

export type PatchApprovedEvent = TaskEventBase & {
	type: 'PatchApproved'
	data: {
		runId: string
		source: 'mcp_call'
	}
}

export type PatchAppliedEvent = TaskEventBase & {
	type: 'PatchApplied'
	data: {
		runId: string
		changedFileCount: number
	}
}

export type PatchApplicationRejectedEvent = TaskEventBase & {
	type: 'PatchApplicationRejected'
	data: {
		runId: string
		failureCode: string
	}
}

export type TaskEvent =
	| TaskCreatedEvent
	| RouteSelectedEvent
	| WorkerStartedEvent
	| ModelTurnCompletedEvent
	| ToolCalledEvent
	| WorkerCompletedEvent
	| PatchProducedEvent
	| ValidationCompletedEvent
	| EvaluationCompletedEvent
	| AttemptCompletedEvent
	| TaskCompletedEvent
	| PatchApplicationRequestedEvent
	| PatchApprovedEvent
	| PatchAppliedEvent
	| PatchApplicationRejectedEvent

export type TaskEventInput = TaskEvent extends infer Event
	? Event extends TaskEvent
		? Omit<Event, keyof TaskEventBase>
		: never
	: never

export type TaskTimeline = {
	task: TaskSummary
	events: Array<TaskEvent>
	incomplete: boolean
}

export type TaskListQuery = {
	limit: number
	cursor: string | null
	status: TaskStatus | null
	mode: WorkerMode | null
	workerId: string | null
}

export type TaskPage = {
	tasks: Array<TaskSummary>
	nextCursor: string | null
}

export type ProviderMessage = {
	role: 'system' | 'user' | 'assistant' | 'tool'
	content: string | null
	toolCallId?: string
	toolCalls?: Array<ProviderToolCall>
}

export type ProviderToolCall = {
	id: string
	type: 'function'
	function: {
		name: string
		arguments: string
	}
}

export type ProviderToolDefinition = {
	type: 'function'
	function: {
		name: string
		description: string
		parameters: Record<string, unknown>
	}
}

export type ProviderCompletion = {
	content: string | null
	toolCalls: Array<ProviderToolCall>
}

export type ProviderRequest = {
	messages: Array<ProviderMessage>
	tools: Array<ProviderToolDefinition>
	signal: AbortSignal
}

export interface WorkerProvider {
	complete(request: ProviderRequest): Promise<ProviderCompletion>
	getUsage?(): ProviderUsage
	getRequestCount?(): number
}

export type ToolExecutionResult = {
	content: string
	isError: boolean
}

export type JsonObject = Record<string, unknown>
