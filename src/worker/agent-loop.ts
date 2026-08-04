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

export async function runAgentLoop(
	task: WorkerTask,
	provider: WorkerProvider,
	toolExecutor: WorkerToolExecutor,
	signal: AbortSignal,
): Promise<AgentLoopResult> {
	const messages: Array<ProviderMessage> = [
		{ role: 'system', content: buildSystemPrompt(task) },
		{ role: 'user', content: buildInitialUserPrompt(task) },
	]
	const transcript: Array<string> = []
	const tools = toolExecutor.getDefinitions()

	for (let iteration = 1; iteration <= task.maxIterations; iteration += 1) {
		const completion = await provider.complete({ messages, tools, signal })
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

			try {
				parsedArguments = JSON.parse(toolCall.function.arguments)
			} catch {
				parsedArguments = {
					_invalidJson: toolCall.function.arguments,
				}
			}

			transcript.push(
				`tool-call[${iteration}]: ${toolCall.function.name} ${toolCall.function.arguments}`,
			)
			const result = await toolExecutor.execute(
				toolCall.function.name,
				parsedArguments,
			)
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
