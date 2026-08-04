import type {
	ProviderCompletion,
	ProviderMessage,
	ProviderRequest,
	ProviderToolCall,
	WorkerProvider,
} from '../domain/types.js'
import type { HarnessConfig } from '../config.js'
import { HarnessError, getErrorMessage, isAbortError } from '../lib/errors.js'
import { requireRecord } from '../lib/json.js'
import { Logger } from '../lib/logger.js'
import { Redactor } from '../lib/redaction.js'

export class OpenAiCompatibleProvider implements WorkerProvider {
	private requestCount = 0
	private readonly config: HarnessConfig['provider']
	private readonly logger: Logger
	private readonly redactor: Redactor

	constructor(config: HarnessConfig['provider'], logger: Logger) {
		this.config = config
		this.logger = logger
		this.redactor = new Redactor(
			{ QWEN_API_KEY: config.apiKey },
			[
				...Object.values(config.headers),
				config.chatCompletionsUrl ?? config.baseUrl,
			],
		)
	}

	getRequestCount(): number {
		return this.requestCount
	}

	async complete(request: ProviderRequest): Promise<ProviderCompletion> {
		const url = this.getCompletionsUrl()
		for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
			if (request.signal.aborted) {
				throw new DOMException('Provider request aborted', 'AbortError')
			}

			try {
				this.requestCount += 1
				const response = await fetchWithTimeout(
					url,
					{
						method: 'POST',
						headers: {
							'content-type': 'application/json',
							authorization: `Bearer ${this.config.apiKey}`,
							...this.config.headers,
						},
						redirect: 'manual',
						body: JSON.stringify({
							model: this.config.model,
							messages: request.messages.map(serializeMessage),
							tools: request.tools,
							tool_choice: 'auto',
							temperature: 0.1,
						}),
						signal: request.signal,
					},
					this.config.timeoutMs,
				)

				const responseText = await readResponseText(
					response,
					this.config.maxResponseBytes,
				)

				if (!response.ok) {
					const retryable = response.status === 429 || response.status >= 500
					const error = new HarnessError(
						'PROVIDER_HTTP_ERROR',
						`Provider returned HTTP ${response.status}`,
						{
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

				return parseCompletion(responseText, this.redactor)
			} catch (error) {
				if (isAbortError(error) || request.signal.aborted) {
					throw error
				}

				const retryable = isRetryableProviderError(error)

				if (!retryable || attempt === this.config.maxRetries) {
					if (error instanceof HarnessError) {
						throw error
					}

					throw new HarnessError(
						'PROVIDER_REQUEST_FAILED',
						`Provider request failed after retries: ${this.redactor.redact(getErrorMessage(error))}`,
					)
				}

				this.logger.warn('Provider request failed; retrying', {
					attempt: attempt + 1,
					error: this.redactor.redact(getErrorMessage(error)),
				})
				await sleepWithJitter(attempt, request.signal)
			}
		}

		throw new HarnessError(
			'PROVIDER_REQUEST_FAILED',
			'Provider request exhausted its retry loop unexpectedly',
		)
	}

	private getCompletionsUrl(): string {
		if (this.config.chatCompletionsUrl !== null) {
			return this.config.chatCompletionsUrl
		}

		return `${this.config.baseUrl}/chat/completions`
	}
}


function isRetryableProviderError(error: unknown): boolean {
	return !(error instanceof HarnessError) || error.code === 'PROVIDER_TIMEOUT'
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
): ProviderCompletion {
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

	return { content, toolCalls }
}

function parseToolCall(value: unknown): ProviderToolCall {
	const record = requireRecord(value, 'tool call')
	const functionRecord = requireRecord(record.function, 'tool call function')

	if (
		typeof record.id !== 'string' ||
		typeof functionRecord.name !== 'string' ||
		typeof functionRecord.arguments !== 'string'
	) {
		throw new HarnessError(
			'PROVIDER_INVALID_TOOL_CALL',
			'Provider returned a malformed tool call',
		)
	}

	return {
		id: record.id,
		type: 'function',
		function: {
			name: functionRecord.name,
			arguments: functionRecord.arguments,
		},
	}
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const timeoutController = new AbortController()
	const timer = setTimeout(() => timeoutController.abort(), timeoutMs)
	const signal = combineSignals(init.signal, timeoutController.signal)

	try {
		return await fetch(url, { ...init, signal })
	} catch (error) {
		if (
			timeoutController.signal.aborted &&
			init.signal?.aborted !== true
		) {
			throw new HarnessError(
				'PROVIDER_TIMEOUT',
				`Provider request exceeded ${timeoutMs}ms`,
			)
		}

		throw error
	} finally {
		clearTimeout(timer)
	}
}

async function readResponseText(
	response: Response,
	maxBytes: number,
): Promise<string> {
	const declaredLength = Number.parseInt(
		response.headers.get('content-length') ?? '',
		10,
	)

	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		await response.body?.cancel()
		throw new HarnessError(
			'PROVIDER_RESPONSE_TOO_LARGE',
			`Provider response exceeded ${maxBytes} bytes`,
		)
	}

	if (response.body === null) {
		return ''
	}

	const reader = response.body.getReader()
	const chunks: Array<Uint8Array> = []
	let totalBytes = 0

	while (true) {
		const { done, value } = await reader.read()

		if (done) {
			break
		}

		totalBytes += value.byteLength

		if (totalBytes > maxBytes) {
			await reader.cancel()
			throw new HarnessError(
				'PROVIDER_RESPONSE_TOO_LARGE',
				`Provider response exceeded ${maxBytes} bytes`,
			)
		}

		chunks.push(value)
	}

	return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
}

function combineSignals(
	first: AbortSignal | null | undefined,
	second: AbortSignal,
): AbortSignal {
	if (first === undefined || first === null) {
		return second
	}

	return AbortSignal.any([first, second])
}

async function sleepWithJitter(
	attempt: number,
	signal: AbortSignal,
): Promise<void> {
	if (signal.aborted) {
		throw new DOMException('Retry delay aborted', 'AbortError')
	}

	const baseDelay = Math.min(8_000, 500 * 2 ** attempt)
	const delay = baseDelay + Math.floor(Math.random() * 250)

	await new Promise<void>((resolve, reject) => {
		function cleanup(): void {
			signal.removeEventListener('abort', abort)
		}

		const timer = setTimeout(() => {
			cleanup()
			resolve()
		}, delay)

		function abort(): void {
			clearTimeout(timer)
			cleanup()
			reject(new DOMException('Retry delay aborted', 'AbortError'))
		}

		signal.addEventListener('abort', abort, { once: true })
	})
}
