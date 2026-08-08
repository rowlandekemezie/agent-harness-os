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

export type RunStatus =
	| 'completed'
	| 'failed'
	| 'blocked'
	| 'policy_violation'
	| 'timed_out'
	| 'cancelled'

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

export type WorkerRoutingMetadata = {
	strategy: RoutingStrategy
	requiredCapabilities: Array<WorkerCapability>
	candidateWorkerIds: Array<string>
	selectedWorkerId: string
	attemptNumber: number
	maxAttempts: number
	fallbackEnabled: boolean
	previousAttempts: Array<WorkerAttemptSummary>
}

export type WorkerRunReport = {
	schemaVersion: 1
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
	provider: {
		workerId?: string
		adapter?: WorkerAdapter
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
