import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { WorkerConfig } from '../config.js'
import type {
	CommandResult,
	ProviderCompletion,
	ProviderRequest,
	ProviderToolCall,
	ProviderUsage,
	WorkerProvider,
} from '../domain/types.js'
import { HarnessError, getErrorMessage } from '../lib/errors.js'
import { Logger } from '../lib/logger.js'
import {
	createSanitizedEnvironment,
	runProcess,
} from '../lib/process.js'
import { ProviderTelemetry } from './telemetry.js'

const loginStatusTimeoutMs = 15_000
const maxToolCalls = 32

export class CodexCliProvider implements WorkerProvider {
	private readonly config: WorkerConfig
	private readonly logger: Logger
	private readonly telemetry: ProviderTelemetry
	private authenticationChecked = false

	constructor(config: WorkerConfig, logger: Logger) {
		if (
			config.adapter !== 'codex' ||
			config.codexCommand === null ||
			config.codexAuthMode === null
		) {
			throw new HarnessError(
				'INVALID_CONFIGURATION',
				'CodexCliProvider requires a codex worker configuration',
			)
		}

		this.config = config
		this.logger = logger
		this.telemetry = new ProviderTelemetry(config.pricing)
	}

	getUsage(): ProviderUsage {
		return this.telemetry.getUsage()
	}

	async complete(request: ProviderRequest): Promise<ProviderCompletion> {
		await this.assertAuthenticated(request.signal)

		const scratchDirectory = await mkdtemp(
			path.join(os.tmpdir(), 'agent-os-codex-'),
		)
		const schemaPath = path.join(scratchDirectory, 'completion.schema.json')
		const outputPath = path.join(scratchDirectory, 'completion.json')
		const command = this.config.codexCommand ?? 'codex'

		try {
			await writeFile(
				schemaPath,
				`${JSON.stringify(completionSchema, null, 2)}\n`,
				{ mode: 0o600 },
			)

			const args = [
				'exec',
				'--cd',
				scratchDirectory,
				'--ephemeral',
				'--sandbox',
				'read-only',
				'--ask-for-approval',
				'never',
				'--ignore-user-config',
				'--ignore-rules',
				'--skip-git-repo-check',
				'--output-schema',
				schemaPath,
				'--output-last-message',
				outputPath,
				'--color',
				'never',
				...(this.config.model === ''
					? []
					: ['--model', this.config.model]),
				'-',
			]

			let result: CommandResult
			try {
				result = await runProcess(command, args, {
					cwd: scratchDirectory,
					environment: createCodexEnvironment(),
					timeoutMs: this.config.timeoutMs,
					maxOutputBytes: this.config.maxResponseBytes,
					signal: request.signal,
					input: buildCodexPrompt(request),
				})
			} catch (error) {
				throw wrapCodexSpawnError(error, command)
			}

			if (request.signal.aborted) {
				throw new DOMException('Codex worker request aborted', 'AbortError')
			}

			this.telemetry.recordRequest({ durationMs: result.durationMs })

			if (result.timedOut) {
				throw new HarnessError(
					'PROVIDER_CODEX_TIMEOUT',
					`Codex worker exceeded ${this.config.timeoutMs}ms`,
				)
			}

			if (result.exitCode !== 0) {
				throw new HarnessError(
					'PROVIDER_CODEX_EXEC_FAILED',
					'Codex worker exited unsuccessfully',
					{
						exitCode: result.exitCode,
						signal: result.signal,
						stderr: result.stderr.slice(0, 4_000),
						stdout: result.stdout.slice(0, 4_000),
					},
				)
			}

			const output = await readBoundedOutput(
				outputPath,
				this.config.maxResponseBytes,
			)
			return parseCodexCompletion(output, request)
		} finally {
			await rm(scratchDirectory, { recursive: true, force: true })
		}
	}

	private async assertAuthenticated(signal: AbortSignal): Promise<void> {
		if (this.authenticationChecked) {
			return
		}

		const command = this.config.codexCommand ?? 'codex'
		let result: CommandResult
		try {
			result = await runProcess(command, ['login', 'status'], {
				cwd: os.tmpdir(),
				environment: createCodexEnvironment(),
				timeoutMs: loginStatusTimeoutMs,
				maxOutputBytes: 16_384,
				signal,
			})
		} catch (error) {
			throw wrapCodexSpawnError(error, command)
		}

		if (signal.aborted) {
			throw new DOMException('Codex authentication check aborted', 'AbortError')
		}

		if (result.exitCode !== 0 || result.timedOut) {
			throw new HarnessError(
				'PROVIDER_CODEX_NOT_LOGGED_IN',
				'Codex CLI is not logged in. Run `codex login` and complete ChatGPT sign-in.',
				{
					exitCode: result.exitCode,
					stderr: result.stderr.slice(0, 2_000),
				},
			)
		}

		const status = `${result.stdout}\n${result.stderr}`.trim()
		if (
			this.config.codexAuthMode === 'chatgpt' &&
			!/logged in using chatgpt/i.test(status)
		) {
			throw new HarnessError(
				'PROVIDER_CODEX_CHATGPT_AUTH_REQUIRED',
				'Codex worker requires ChatGPT subscription authentication. `codex login status` did not report ChatGPT authentication.',
				{ authenticationStatus: status.slice(0, 1_000) },
			)
		}

		this.logger.debug('Codex CLI authentication verified', {
			authMode: this.config.codexAuthMode,
		})
		this.authenticationChecked = true
	}
}

const completionSchema: Record<string, unknown> = {
	type: 'object',
	additionalProperties: false,
	properties: {
		content: {
			anyOf: [{ type: 'string' }, { type: 'null' }],
		},
		toolCalls: {
			type: 'array',
			maxItems: maxToolCalls,
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					id: { type: 'string', minLength: 1, maxLength: 256 },
					name: { type: 'string', minLength: 1, maxLength: 256 },
					arguments: { type: 'object' },
				},
				required: ['id', 'name', 'arguments'],
			},
		},
	},
	required: ['content', 'toolCalls'],
}

function buildCodexPrompt(request: ProviderRequest): string {
	return [
		'You are a bounded model backend inside Agent Harness OS.',
		'Decide only the next assistant response for the supplied conversation.',
		'Do not inspect local files, execute shell commands, browse the web, use MCP, use plugins, or use any local context. The scratch working directory is intentionally irrelevant.',
		'All repository access must happen through the tool definitions supplied below. If more repository information or a file change is required, return a tool call instead of attempting the action yourself.',
		'When returning a tool call, use an arguments JSON object that conforms to the selected tool schema.',
		'When no tool call is needed, return an empty toolCalls array and put the assistant response in content.',
		'',
		'CONVERSATION_JSON',
		JSON.stringify(request.messages),
		'',
		'TOOL_DEFINITIONS_JSON',
		JSON.stringify(request.tools),
	].join('\n')
}

function parseCodexCompletion(
	value: string,
	request: ProviderRequest,
): ProviderCompletion {
	let parsed: unknown
	try {
		parsed = JSON.parse(value)
	} catch {
		throw new HarnessError(
			'PROVIDER_CODEX_INVALID_RESPONSE',
			'Codex worker final response was not valid JSON',
			{ response: value.slice(0, 4_000) },
		)
	}

	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new HarnessError(
			'PROVIDER_CODEX_INVALID_RESPONSE',
			'Codex worker final response must be an object',
		)
	}

	const record = parsed as Record<string, unknown>
	const content = record['content']
	const rawToolCalls = record['toolCalls']

	if (content !== null && typeof content !== 'string') {
		throw new HarnessError(
			'PROVIDER_CODEX_INVALID_RESPONSE',
			'Codex worker content must be a string or null',
		)
	}
	if (!Array.isArray(rawToolCalls) || rawToolCalls.length > maxToolCalls) {
		throw new HarnessError(
			'PROVIDER_CODEX_INVALID_RESPONSE',
			`Codex worker toolCalls must be an array with at most ${maxToolCalls} items`,
		)
	}

	const allowedToolNames = new Set(
		request.tools.map(tool => tool.function.name),
	)
	const toolCalls = rawToolCalls.map((toolCall, index) =>
		parseCodexToolCall(toolCall, index, allowedToolNames),
	)

	return {
		content: content as string | null,
		toolCalls,
	}
}

function parseCodexToolCall(
	value: unknown,
	index: number,
	allowedToolNames: Set<string>,
): ProviderToolCall {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw invalidToolCall(index)
	}

	const record = value as Record<string, unknown>
	const id = record['id']
	const name = record['name']
	const argumentsValue = record['arguments']

	if (
		typeof id !== 'string' ||
		id.length === 0 ||
		typeof name !== 'string' ||
		name.length === 0 ||
		typeof argumentsValue !== 'object' ||
		argumentsValue === null ||
		Array.isArray(argumentsValue)
	) {
		throw invalidToolCall(index)
	}

	if (!allowedToolNames.has(name)) {
		throw new HarnessError(
			'PROVIDER_CODEX_UNKNOWN_TOOL',
			`Codex worker requested an unknown tool: ${name}`,
		)
	}

	return {
		id,
		type: 'function',
		function: {
			name,
			arguments: JSON.stringify(argumentsValue),
		},
	}
}

function invalidToolCall(index: number): HarnessError {
	return new HarnessError(
		'PROVIDER_CODEX_INVALID_RESPONSE',
		`Codex worker returned a malformed tool call at index ${index}`,
	)
}

async function readBoundedOutput(
	outputPath: string,
	maxBytes: number,
): Promise<string> {
	let metadata
	try {
		metadata = await lstat(outputPath)
	} catch (error) {
		throw new HarnessError(
			'PROVIDER_CODEX_INVALID_RESPONSE',
			'Codex worker did not write its final response file',
			{ error: getErrorMessage(error) },
		)
	}

	if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
		throw new HarnessError(
			'PROVIDER_CODEX_INVALID_RESPONSE',
			'Codex worker response path is not a private regular file',
		)
	}
	if (metadata.size > maxBytes) {
		throw new HarnessError(
			'PROVIDER_CODEX_RESPONSE_TOO_LARGE',
			`Codex worker response exceeded ${maxBytes} bytes`,
		)
	}

	return await readFile(outputPath, 'utf8')
}

function createCodexEnvironment(): NodeJS.ProcessEnv {
	const environment = createSanitizedEnvironment()
	const authAndNetworkNames = [
		'HOME',
		'USERPROFILE',
		'CODEX_HOME',
		'XDG_CONFIG_HOME',
		'XDG_DATA_HOME',
		'XDG_RUNTIME_DIR',
		'APPDATA',
		'LOCALAPPDATA',
		'HTTPS_PROXY',
		'HTTP_PROXY',
		'ALL_PROXY',
		'NO_PROXY',
		'SSL_CERT_FILE',
		'SSL_CERT_DIR',
	]

	for (const name of authAndNetworkNames) {
		const value = process.env[name]
		if (value !== undefined) {
			environment[name] = value
		}
	}

	delete environment['OPENAI_API_KEY']
	delete environment['OPENAI_ORG_ID']
	delete environment['OPENAI_PROJECT_ID']

	return environment
}

function wrapCodexSpawnError(error: unknown, command: string): HarnessError {
	return new HarnessError(
		'PROVIDER_CODEX_CLI_UNAVAILABLE',
		`Unable to execute Codex CLI command: ${command}`,
		{ error: getErrorMessage(error) },
	)
}
