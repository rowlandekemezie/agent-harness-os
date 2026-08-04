import type { WorkerConfig } from '../config.js'
import type {
	ProviderCompletion,
	ProviderMessage,
	ProviderRequest,
	ProviderToolCall,
	ProviderUsage,
	WorkerProvider,
} from '../domain/types.js'
import { HarnessError, getErrorMessage, isAbortError } from '../lib/errors.js'
import { requireRecord } from '../lib/json.js'
import { Logger } from '../lib/logger.js'
import { Redactor } from '../lib/redaction.js'
import {
	fetchProviderResponse,
	isRetryableProviderFailure,
	readProviderResponseText,
	sleepWithJitter,
} from './http.js'
import { ProviderTelemetry } from './telemetry.js'

export class OpenAiCompatibleProvider implements WorkerProvider {
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
		const url = this.getCompletionsUrl()
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
						headers: this.buildHeaders(),
						redirect: 'manual',
						body: JSON.stringify({
							model: this.config.model,
							messages: request.messages.map(serializeMessage),
							tools: request.tools,
							tool_choice: 'auto',
							...this.buildGenerationOptions(),
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

				const parsed = parseCompletion(responseText, this.redactor)
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

				this.logger.warn('Worker provider request failed; retrying', {
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

	private buildGenerationOptions(): Record<string, number> {
		const options: Record<string, number> = {}
		if (this.config.maxOutputTokensParameter !== 'none') {
			options[this.config.maxOutputTokensParameter] =
				this.config.maxOutputTokens
		}
		if (this.config.temperature !== null) {
			options.temperature = this.config.temperature
		}
		return options
	}

	private buildHeaders(): Record<string, string> {
		return {
			'content-type': 'application/json',
			...(this.config.auth === 'bearer'
				? { authorization: `Bearer ${this.config.apiKey}` }
				: {}),
			...this.config.headers,
		}
	}

	private getCompletionsUrl(): string {
		if (this.config.endpointUrl !== null) {
			return this.config.endpointUrl
		}

		return `${this.config.baseUrl}/chat/completions`
	}
}

type ParsedCompletion = {
	completion: ProviderCompletion
	inputTokens: number | undefined
	outputTokens: number | undefined
}

function serializeMessage(message: ProviderMessage): Record<string, unknown> {
	const serialized: Record<string, unknown> = {
		role: message.role,
		content: message.content,
	}

	if (message.toolCallId !== undefined) {
		serialized.tool_call_id = message.toolCallId
	}

	if (message.toolCalls !== undefined) {
		serialized.tool_calls = message.toolCalls
	}

	return serialized
}

function parseCompletion(
	responseText: string,
	redactor: Redactor,
): ParsedCompletion {
	let parsed: unknown

	try {
		parsed = JSON.parse(responseText)
	} catch {
		throw new HarnessError(
			'PROVIDER_INVALID_JSON',
			'Provider response was not valid JSON',
			{ body: redactor.redact(responseText.slice(0, 4_000)) },
		)
	}

	const root = requireRecord(parsed, 'provider response')
	const choices = root.choices

	if (!Array.isArray(choices) || choices.length === 0) {
		throw new HarnessError(
			'PROVIDER_INVALID_RESPONSE',
			'Provider response did not contain choices',
		)
	}

	const choice = requireRecord(choices[0], 'provider choice')
	const message = requireRecord(choice.message, 'provider message')
	const content = typeof message.content === 'string' ? message.content : null
	const rawToolCalls = message.tool_calls

	if (Array.isArray(rawToolCalls) && rawToolCalls.length > 32) {
		throw new HarnessError(
			'PROVIDER_TOOL_CALL_LIMIT',
			'Provider returned more than 32 tool calls in one response',
		)
	}

	const toolCalls = Array.isArray(rawToolCalls)
		? rawToolCalls.map(parseToolCall)
		: []
	const usage = isUsageRecord(root.usage) ? root.usage : null

	return {
		completion: { content, toolCalls },
		inputTokens: usage === null
			? undefined
			: readTokenCount(usage.prompt_tokens ?? usage.input_tokens),
		outputTokens: usage === null
			? undefined
			: readTokenCount(usage.completion_tokens ?? usage.output_tokens),
	}
}

function parseToolCall(value: unknown, index: number): ProviderToolCall {
	const record = requireRecord(value, 'tool call')
	const functionRecord = requireRecord(record.function, 'tool call function')
	const rawArguments = functionRecord.arguments

	if (
		typeof functionRecord.name !== 'string' ||
		(typeof rawArguments !== 'string' &&
			typeof rawArguments !== 'object')
	) {
		throw new HarnessError(
			'PROVIDER_INVALID_TOOL_CALL',
			'Provider returned a malformed tool call',
		)
	}

	return {
		id: typeof record.id === 'string' && record.id !== ''
			? record.id
			: `call-${index}`,
		type: 'function',
		function: {
			name: functionRecord.name,
			arguments: typeof rawArguments === 'string'
				? rawArguments
				: JSON.stringify(rawArguments),
		},
	}
}

function isUsageRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readTokenCount(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined
}
