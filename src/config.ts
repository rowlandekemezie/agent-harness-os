import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { ExecutionBackend } from './domain/types.js'
import { HarnessError } from './lib/errors.js'
import { parseJsonObject } from './lib/json.js'
import type { LogLevel } from './lib/logger.js'

export type HarnessConfig = {
	provider: {
		baseUrl: string
		chatCompletionsUrl: string | null
		apiKey: string
		model: string
		headers: Record<string, string>
		timeoutMs: number
		maxRetries: number
		maxResponseBytes: number
	}
	execution: {
		backend: ExecutionBackend
		allowUnsandboxedLocal: boolean
		dockerImage: string
		dockerNetwork: string
		requirePinnedDockerImage: boolean
		allowedCommands: Array<string>
		commandTimeoutMs: number
	}
	limits: {
		maxConcurrency: number
		maxFileBytes: number
		maxToolOutputBytes: number
	}
	artifactRootOverride: string | null
	logLevel: LogLevel
}

export function loadConfig(
	environment: NodeJS.ProcessEnv = process.env,
): HarnessConfig {
	const headers = parseStringHeaders(environment['QWEN_HEADERS_JSON'] ?? '{}')
	const backend = parseExecutionBackend(
		environment['AGENT_HARNESS_EXECUTION_BACKEND'] ?? 'local',
	)

	return {
		provider: {
			baseUrl: normalizeBaseUrl(environment['QWEN_BASE_URL'] ?? ''),
			chatCompletionsUrl:
				environment['QWEN_CHAT_COMPLETIONS_URL']?.trim() || null,
			apiKey: environment['QWEN_API_KEY']?.trim() ?? '',
			model: environment['QWEN_MODEL']?.trim() ?? '',
			headers,
			timeoutMs: parseInteger(
				environment['QWEN_TIMEOUT_MS'],
				120_000,
				1_000,
				900_000,
			),
			maxRetries: parseInteger(
				environment['QWEN_MAX_RETRIES'],
				3,
				0,
				8,
			),
			maxResponseBytes: parseInteger(
				environment['QWEN_MAX_RESPONSE_BYTES'],
				4_194_304,
				65_536,
				20_971_520,
			),
		},
		execution: {
			backend,
			allowUnsandboxedLocal: parseBoolean(
				environment['AGENT_HARNESS_ALLOW_UNSANDBOXED_LOCAL'],
				false,
			),
			dockerImage:
				environment['AGENT_HARNESS_DOCKER_IMAGE']?.trim() ||
				'node:22-bookworm-slim',
			dockerNetwork:
				environment['AGENT_HARNESS_DOCKER_NETWORK']?.trim() || 'none',
			requirePinnedDockerImage: parseBoolean(
				environment['AGENT_HARNESS_REQUIRE_PINNED_DOCKER_IMAGE'],
				true,
			),
			allowedCommands: parseCsv(
				environment['AGENT_HARNESS_ALLOWED_COMMANDS'] ??
					'npm,pnpm,yarn,bun,tsc,vitest,jest,eslint,prettier,biome',
			),
			commandTimeoutMs: parseInteger(
				environment['AGENT_HARNESS_COMMAND_TIMEOUT_MS'],
				120_000,
				1_000,
				900_000,
			),
		},
		limits: {
			maxConcurrency: parseInteger(
				environment['AGENT_HARNESS_MAX_CONCURRENCY'],
				1,
				1,
				8,
			),
			maxFileBytes: parseInteger(
				environment['AGENT_HARNESS_MAX_FILE_BYTES'],
				1_048_576,
				1_024,
				20_971_520,
			),
			maxToolOutputBytes: parseInteger(
				environment['AGENT_HARNESS_MAX_TOOL_OUTPUT_BYTES'],
				65_536,
				1_024,
				1_048_576,
			),
		},
		artifactRootOverride:
			environment['AGENT_HARNESS_ARTIFACT_ROOT']?.trim() || null,
		logLevel: parseLogLevel(
			environment['AGENT_HARNESS_LOG_LEVEL'] ?? 'info',
		),
	}
}

export function assertProviderConfigured(config: HarnessConfig): void {
	const missing = [
		config.provider.baseUrl === '' && config.provider.chatCompletionsUrl === null
			? 'QWEN_BASE_URL or QWEN_CHAT_COMPLETIONS_URL'
			: null,
		config.provider.apiKey === '' ? 'QWEN_API_KEY' : null,
		config.provider.model === '' ? 'QWEN_MODEL' : null,
	].filter((value): value is string => value !== null)

	if (missing.length > 0) {
		throw new HarnessError(
			'PROVIDER_NOT_CONFIGURED',
			`Missing provider configuration: ${missing.join(', ')}`,
		)
	}
}

export function isProviderConfigured(config: HarnessConfig): boolean {
	try {
		assertProviderConfigured(config)
		return true
	} catch {
		return false
	}
}

export function resolveArtifactRoot(
	repositoryPath: string,
	config: HarnessConfig,
): string {
	if (config.artifactRootOverride !== null) {
		return path.resolve(config.artifactRootOverride, repositoryKey(repositoryPath))
	}

	return path.join(
		os.homedir(),
		'.agent-harness-os',
		'runs',
		repositoryKey(repositoryPath),
	)
}

function repositoryKey(repositoryPath: string): string {
	return createHash('sha256')
		.update(path.resolve(repositoryPath))
		.digest('hex')
		.slice(0, 24)
}

function normalizeBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/, '')
}

function parseExecutionBackend(value: string): ExecutionBackend {
	if (value === 'local' || value === 'docker') {
		return value
	}

	throw new HarnessError(
		'INVALID_CONFIGURATION',
		'AGENT_HARNESS_EXECUTION_BACKEND must be local or docker',
	)
}

function parseInteger(
	value: string | undefined,
	fallback: number,
	min: number,
	max: number,
): number {
	if (value === undefined || value.trim() === '') {
		return fallback
	}

	const parsed = Number.parseInt(value, 10)

	if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`Expected an integer between ${min} and ${max}, received ${value}`,
		)
	}

	return parsed
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined || value.trim() === '') {
		return fallback
	}

	if (value === 'true') {
		return true
	}

	if (value === 'false') {
		return false
	}

	throw new HarnessError(
		'INVALID_CONFIGURATION',
		`Expected true or false, received ${value}`,
	)
}

function parseCsv(value: string): Array<string> {
	return value
		.split(',')
		.map(item => item.trim())
		.filter(item => item.length > 0)
}

function parseStringHeaders(value: string): Record<string, string> {
	const parsed = parseJsonObject(value, 'QWEN_HEADERS_JSON')
	const headers: Record<string, string> = {}

	for (const [key, headerValue] of Object.entries(parsed)) {
		if (typeof headerValue !== 'string') {
			throw new HarnessError(
				'INVALID_CONFIGURATION',
				'QWEN_HEADERS_JSON values must all be strings',
			)
		}

		headers[key] = headerValue
	}

	return headers
}

function parseLogLevel(value: string): LogLevel {
	if (
		value === 'debug' ||
		value === 'info' ||
		value === 'warn' ||
		value === 'error'
	) {
		return value
	}

	throw new HarnessError(
		'INVALID_CONFIGURATION',
		'AGENT_HARNESS_LOG_LEVEL must be debug, info, warn, or error',
	)
}
