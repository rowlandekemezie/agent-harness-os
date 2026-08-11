import type {
	ProviderMessage,
	WorkerProvider,
	WorkerTask,
} from '../domain/types.js'
import { HarnessError } from '../lib/errors.js'
import type { WorkerToolExecutor } from './tool-executor.js'
import { buildInitialUserPrompt, buildSystemPrompt } from './prompts.js'

export type AgentLoopResult = {
	finalResponse: string
	transcript: string
	iterations: number
}

export type AgentLoopLimits = {
	maxTotalToolCalls: number
	maxContextBytes: number
	maxAssistantContentBytes: number
}

export type ToolCallObservation = {
	toolName: string
	iteration: number
	outcome: 'succeeded' | 'failed'
	inputBytes: number
	outputBytes: number
	durationMs: number
}

export type ObserveToolCall = (
	observation: ToolCallObservation,
) => Promise<void>

export async function runAgentLoop(
	task: WorkerTask,
	provider: WorkerProvider,
	toolExecutor: WorkerToolExecutor,
	limits: AgentLoopLimits,
	signal: AbortSignal,
	observeToolCall?: ObserveToolCall,
): Promise<AgentLoopResult> {
	const messages: Array<ProviderMessage> = [
		{ role: 'system', content: buildSystemPrompt(task) },
		{ role: 'user', content: buildInitialUserPrompt(task) },
	]
	const transcript: Array<string> = []
	const tools = toolExecutor.getDefinitions()
	let totalToolCalls = 0

	for (let iteration = 1; iteration <= task.maxIterations; iteration += 1) {
		const contextBytes = Buffer.byteLength(
			JSON.stringify({ messages, tools }),
			'utf8',
		)

		if (contextBytes > limits.maxContextBytes) {
			throw new HarnessError(
				'WORKER_CONTEXT_LIMIT',
				`Worker context exceeded the ${limits.maxContextBytes}-byte limit`,
			)
		}

		const completion = await provider.complete({ messages, tools, signal })

		if (
			completion.content !== null &&
			Buffer.byteLength(completion.content, 'utf8') >
				limits.maxAssistantContentBytes
		) {
			throw new HarnessError(
				'WORKER_ASSISTANT_CONTENT_LIMIT',
				`Worker assistant content exceeded the ${limits.maxAssistantContentBytes}-byte limit`,
			)
		}

		totalToolCalls += completion.toolCalls.length

		if (totalToolCalls > limits.maxTotalToolCalls) {
			throw new HarnessError(
				'WORKER_TOOL_CALL_LIMIT',
				`Worker exceeded the ${limits.maxTotalToolCalls}-tool-call run limit`,
			)
		}

		messages.push({
			role: 'assistant',
			content: completion.content,
			...(completion.toolCalls.length === 0
				? {}
				: { toolCalls: completion.toolCalls }),
		})

		if (completion.content !== null && completion.content.trim() !== '') {
			transcript.push(`assistant[${iteration}]: ${completion.content}`)
		}

		if (completion.toolCalls.length === 0) {
			if (completion.content === null || completion.content.trim() === '') {
				throw new HarnessError(
					'WORKER_EMPTY_RESPONSE',
					'Worker returned neither tool calls nor a final response',
				)
			}

			return {
				finalResponse: completion.content,
				transcript: transcript.join('\n\n'),
				iterations: iteration,
			}
		}

		for (const toolCall of completion.toolCalls) {
			let parsedArguments: unknown = {}
			const toolStartedAt = Date.now()

			try {
				parsedArguments = JSON.parse(toolCall.function.arguments)
			} catch {
				parsedArguments = {
					_invalidJson: toolCall.function.arguments,
				}
			}

			transcript.push(
				`tool-call[${iteration}]: ${toolCall.function.name} ${limitTranscriptValue(toolCall.function.arguments, 8_000)}`,
			)
			const result = await toolExecutor.execute(
				toolCall.function.name,
				parsedArguments,
			)

			if (observeToolCall !== undefined) {
				await observeToolCall({
					toolName: toolCall.function.name,
					iteration,
					outcome: result.isError ? 'failed' : 'succeeded',
					inputBytes: Buffer.byteLength(
						toolCall.function.arguments,
						'utf8',
					),
					outputBytes: Buffer.byteLength(result.content, 'utf8'),
					durationMs: Date.now() - toolStartedAt,
				})
			}
			const resultForTranscript = limitTranscriptValue(result.content, 8_000)
			transcript.push(
				`tool-result[${iteration}]: ${toolCall.function.name} error=${result.isError}\n${resultForTranscript}`,
			)
			messages.push({
				role: 'tool',
				content: result.content,
				toolCallId: toolCall.id,
			})
		}
	}

	throw new HarnessError(
		'WORKER_ITERATION_LIMIT',
		`Worker exceeded the maximum of ${task.maxIterations} iterations`,
	)
}

function limitTranscriptValue(value: string, maxCharacters: number): string {
	return value.length <= maxCharacters
		? value
		: `${value.slice(0, maxCharacters)}\n[TRANSCRIPT VALUE TRUNCATED]`
}
