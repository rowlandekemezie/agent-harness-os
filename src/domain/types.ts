export type WorkerMode = 'research' | 'implementation' | 'testing' | 'review'

export type ExecutionBackend = 'local' | 'docker'

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
}

export type WorkerRunReport = {
	schemaVersion: 1
	runId: string
	status: RunStatus
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
		baseUrl: string
		model: string
		requestCount: number
	}
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
	getRequestCount(): number
}

export type ToolExecutionResult = {
	content: string
	isError: boolean
}

export type JsonObject = Record<string, unknown>
