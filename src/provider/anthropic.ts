import type { WorkerConfig } from '../config.js'
import type {
	ProviderCompletion,
	ProviderMessage,
	ProviderRequest,
	ProviderToolCall,
	ProviderToolDefinition,
	ProviderUsage,
	WorkerProvider,
} from '../domain/types.js'
import { HarnessError, getErrorMessage, isAbortError } from '../lib/errors.js'
import { isRecord, requireRecord } from '../lib/json.js'
import { Logger } from '../lib/logger.js'
import { Redactor } from '../lib/redaction.js'
import {
	fetchProviderResponse,
	isRetryableProviderFailure,
	readProviderResponseText,
	sleepWithJitter,
} from './http.js'
import { ProviderTelemetry } from './telemetry.js'

export class AnthropicProvider implements WorkerProvider {
	private readonly config: WorkerConfig
	private readonly logger: Logger
	private readonly redactor: Redactor
	private readonly telemetry: ProviderTelemetry

	constructor(config: WorkerConfig, logger: Logger) {
		this.config = config
		this.logger = logger
		this.redactor = new Redactor(
			config.apiKey === ''
				? {}
				: { [config.apiKeyEnv ?? `${config.id}_api_key`]: config.apiKey },
			[
				...Object.values(config.headers),
				config.endpointUrl ?? config.baseUrl,
			],
		)
		this.telemetry = new ProviderTelemetry(config.pricing)
	}

	getUsage(): ProviderUsage {
		return this.telemetry.getUsage()
	}

	async complete(request: ProviderRequest): Promise<ProviderCompletion> {
		const url = this.getMessagesUrl()
		const serialized = serializeAnthropicConversation(request.messages)

		for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
			if (request.signal.aborted) {
				throw new DOMException('Provider request aborted', 'AbortError')
			}

			const startedAt = Date.now()
			try {
				const response = await fetchProviderResponse(
					url,
					{
						method: 'POST',
						headers: {
							'content-type': 'application/json',
							'x-api-key': this.config.apiKey,
							'anthropic-version': this.config.anthropicVersion,
							...this.config.headers,
						},
						redirect: 'manual',
						body: JSON.stringify({
							model: this.config.model,
							max_tokens: this.config.maxOutputTokens,
							system: serialized.system,
							messages: serialized.messages,
							tools: request.tools.map(serializeAnthropicTool),
							tool_choice: { type: 'auto' },
							...(this.config.temperature === null
								? {}
								: { temperature: this.config.temperature }),
						}),
						signal: request.signal,
					},
					this.config.timeoutMs,
				)
				const responseText = await readProviderResponseText(
					response,
					this.config.maxResponseBytes,
				)

				if (!response.ok) {
					this.telemetry.recordRequest({ durationMs: Date.now() - startedAt })
					const retryable = response.status === 429 || response.status >= 500
					const error = new HarnessError(
						'PROVIDER_HTTP_ERROR',
						`Worker ${this.config.id} returned HTTP ${response.status}`,
						{
							workerId: this.config.id,
							status: response.status,
							body: this.redactor.redact(responseText.slice(0, 4_000)),
						},
					)

					if (!retryable || attempt === this.config.maxRetries) {
						throw error
					}

					await sleepWithJitter(attempt, request.signal)
					continue
				}

				const parsed = parseAnthropicCompletion(responseText, this.redactor)
				this.telemetry.recordRequest({
					...(parsed.inputTokens === undefined
						? {}
						: { inputTokens: parsed.inputTokens }),
					...(parsed.outputTokens === undefined
						? {}
						: { outputTokens: parsed.outputTokens }),
					durationMs: Date.now() - startedAt,
				})
				return parsed.completion
			} catch (error) {
				if (isAbortError(error) || request.signal.aborted) {
					throw error
				}

				if (!(error instanceof HarnessError && error.code === 'PROVIDER_HTTP_ERROR')) {
					this.telemetry.recordRequest({ durationMs: Date.now() - startedAt })
				}

				const retryable = isRetryableProviderFailure(error)

				if (!retryable || attempt === this.config.maxRetries) {
					if (error instanceof HarnessError) {
						throw error
					}

					throw new HarnessError(
						'PROVIDER_REQUEST_FAILED',
						`Worker ${this.config.id} request failed after retries: ${this.redactor.redact(getErrorMessage(error))}`,
						{ workerId: this.config.id },
					)
				}

				this.logger.warn('Anthropic worker request failed; retrying', {
					workerId: this.config.id,
					attempt: attempt + 1,
					error: this.redactor.redact(getErrorMessage(error)),
				})
				await sleepWithJitter(attempt, request.signal)
			}
		}

		throw new HarnessError(
			'PROVIDER_REQUEST_FAILED',
			`Worker ${this.config.id} exhausted its retry loop unexpectedly`,
		)
	}

	private getMessagesUrl(): string {
		if (this.config.endpointUrl !== null) {
			return this.config.endpointUrl
		}

		return `${this.config.baseUrl}/messages`
	}
}

type AnthropicConversation = {
	system: string
	messages: Array<Record<string, unknown>>
}

type ParsedAnthropicCompletion = {
	completion: ProviderCompletion
	inputTokens: number | undefined
	outputTokens: number | undefined
}

function serializeAnthropicConversation(
	messages: Array<ProviderMessage>,
): AnthropicConversation {
	const system = messages
		.filter(message => message.role === 'system')
		.map(message => message.content ?? '')
		.filter(content => content !== '')
		.join('\n\n')
	const serialized: Array<Record<string, unknown>> = []

	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index]

		if (message === undefined || message.role === 'system') {
			continue
		}

		if (message.role === 'tool') {
			const toolResults: Array<Record<string, unknown>> = []
			let cursor = index

			while (cursor < messages.length) {
				const candidate = messages[cursor]
				if (candidate?.role !== 'tool') {
					break
				}
				toolResults.push({
					type: 'tool_result',
					tool_use_id: candidate.toolCallId,
					content: candidate.content ?? '',
				})
				cursor += 1
			}

			serialized.push({ role: 'user', content: toolResults })
			index = cursor - 1
			continue
		}

		if (message.role === 'user') {
			serialized.push({ role: 'user', content: message.content ?? '' })
			continue
		}

		const contentBlocks: Array<Record<string, unknown>> = []
		if (message.content !== null && message.content !== '') {
			contentBlocks.push({ type: 'text', text: message.content })
		}
		for (const toolCall of message.toolCalls ?? []) {
			contentBlocks.push({
				type: 'tool_use',
				id: toolCall.id,
				name: toolCall.function.name,
				input: parseToolArguments(toolCall.function.arguments),
			})
		}
		serialized.push({ role: 'assistant', content: contentBlocks })
	}

	return { system, messages: serialized }
}

function serializeAnthropicTool(
	tool: ProviderToolDefinition,
): Record<string, unknown> {
	return {
		name: tool.function.name,
		description: tool.function.description,
		input_schema: tool.function.parameters,
	}
}

function parseAnthropicCompletion(
	responseText: string,
	redactor: Redactor,
): ParsedAnthropicCompletion {
	let parsed: unknown

	try {
		parsed = JSON.parse(responseText)
	} catch {
		throw new HarnessError(
			'PROVIDER_INVALID_JSON',
			'Anthropic response was not valid JSON',
			{ body: redactor.redact(responseText.slice(0, 4_000)) },
		)
	}

	const root = requireRecord(parsed, 'Anthropic response')
	const content = root.content

	if (!Array.isArray(content)) {
		throw new HarnessError(
			'PROVIDER_INVALID_RESPONSE',
			'Anthropic response did not contain content blocks',
		)
	}

	const text: Array<string> = []
	const toolCalls: Array<ProviderToolCall> = []

	for (const blockValue of content) {
		const block = requireRecord(blockValue, 'Anthropic content block')
		if (block.type === 'text' && typeof block.text === 'string') {
			text.push(block.text)
			continue
		}
		if (block.type === 'tool_use') {
			if (
				typeof block.id !== 'string' ||
				typeof block.name !== 'string' ||
				!isRecord(block.input)
			) {
				throw new HarnessError(
					'PROVIDER_INVALID_TOOL_CALL',
					'Anthropic returned a malformed tool_use block',
				)
			}
			toolCalls.push({
				id: block.id,
				type: 'function',
				function: {
					name: block.name,
					arguments: JSON.stringify(block.input),
				},
			})
		}
	}

	if (toolCalls.length > 32) {
		throw new HarnessError(
			'PROVIDER_TOOL_CALL_LIMIT',
			'Anthropic returned more than 32 tool calls in one response',
		)
	}

	if (root.stop_reason === 'max_tokens' && toolCalls.length === 0) {
		throw new HarnessError(
			'PROVIDER_TRUNCATED_RESPONSE',
			'Anthropic response reached max_tokens before completing the turn',
		)
	}

	const usage = isRecord(root.usage) ? root.usage : null

	return {
		completion: {
			content: text.length === 0 ? null : text.join('\n'),
			toolCalls,
		},
		inputTokens: usage === null ? undefined : readTokenCount(usage.input_tokens),
		outputTokens: usage === null ? undefined : readTokenCount(usage.output_tokens),
	}
}

function parseToolArguments(value: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(value)
		return isRecord(parsed) ? parsed : { value: parsed }
	} catch {
		return { _invalidJson: value }
	}
}

function readTokenCount(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined
}
