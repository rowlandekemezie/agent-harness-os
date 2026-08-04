import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isIP } from 'node:net'
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
		allowInsecureHttp: boolean
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
		maxMcpMessageBytes: number
		maxMcpInFlight: number
		maxChangedFiles: number
		maxSearchBytes: number
		maxTraversalEntries: number
		maxTotalToolCalls: number
		maxProviderContextBytes: number
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
	const allowInsecureHttp = parseBoolean(
		environment['QWEN_ALLOW_INSECURE_HTTP'],
		false,
	)
	const baseUrl = normalizeBaseUrl(
		environment['QWEN_BASE_URL'] ?? '',
		allowInsecureHttp,
	)
	const chatCompletionsUrl = normalizeChatCompletionsUrl(
		environment['QWEN_CHAT_COMPLETIONS_URL'] ?? '',
		allowInsecureHttp,
	)

	return {
		provider: {
			baseUrl,
			chatCompletionsUrl,
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
			allowInsecureHttp,
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
			maxMcpMessageBytes: parseInteger(
				environment['AGENT_HARNESS_MAX_MCP_MESSAGE_BYTES'],
				1_048_576,
				1_024,
				16_777_216,
			),
			maxMcpInFlight: parseInteger(
				environment['AGENT_HARNESS_MAX_MCP_IN_FLIGHT'],
				64,
				1,
				1_024,
			),
			maxChangedFiles: parseInteger(
				environment['AGENT_HARNESS_MAX_CHANGED_FILES'],
				200,
				1,
				10_000,
			),
			maxSearchBytes: parseInteger(
				environment['AGENT_HARNESS_MAX_SEARCH_BYTES'],
				33_554_432,
				1_048_576,
				536_870_912,
			),
			maxTraversalEntries: parseInteger(
				environment['AGENT_HARNESS_MAX_TRAVERSAL_ENTRIES'],
				10_000,
				100,
				1_000_000,
			),
			maxTotalToolCalls: parseInteger(
				environment['AGENT_HARNESS_MAX_TOTAL_TOOL_CALLS'],
				128,
				1,
				1_024,
			),
			maxProviderContextBytes: parseInteger(
				environment['AGENT_HARNESS_MAX_PROVIDER_CONTEXT_BYTES'],
				8_388_608,
				65_536,
				134_217_728,
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

export async function assertArtifactRootOutsideRepository(
	repositoryPath: string,
	artifactRoot: string,
): Promise<void> {
	const repositoryRoot = await realpath(path.resolve(repositoryPath))
	const resolvedArtifactRoot = path.resolve(artifactRoot)
	const existingParent = await findExistingParent(resolvedArtifactRoot)
	const resolvedParent = await realpath(existingParent)
	const effectiveArtifactRoot = path.resolve(
		resolvedParent,
		path.relative(existingParent, resolvedArtifactRoot),
	)
	const relative = path.relative(repositoryRoot, effectiveArtifactRoot)

	if (
		relative === '' ||
		(!relative.startsWith('..') && !path.isAbsolute(relative))
	) {
		throw new HarnessError(
			'ARTIFACT_ROOT_INSIDE_REPOSITORY',
			'Artifact storage must be outside the target repository',
			{ repositoryPath: repositoryRoot, artifactRoot: effectiveArtifactRoot },
		)
	}
}

function repositoryKey(repositoryPath: string): string {
	return createHash('sha256')
		.update(path.resolve(repositoryPath))
		.digest('hex')
		.slice(0, 24)
}

function normalizeBaseUrl(value: string, allowInsecureHttp: boolean): string {
	const trimmed = value.trim().replace(/\/+$/, '')

	if (trimmed === '') {
		return ''
	}

	const parsed = validateProviderUrl(
		trimmed,
		'QWEN_BASE_URL',
		allowInsecureHttp,
	)

	if (parsed.search !== '') {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			'QWEN_BASE_URL may not contain a query string; use QWEN_CHAT_COMPLETIONS_URL for a full endpoint',
		)
	}

	return trimmed
}

function normalizeChatCompletionsUrl(
	value: string,
	allowInsecureHttp: boolean,
): string | null {
	const trimmed = value.trim()

	if (trimmed === '') {
		return null
	}

	validateProviderUrl(
		trimmed,
		'QWEN_CHAT_COMPLETIONS_URL',
		allowInsecureHttp,
	)
	return trimmed
}

function validateProviderUrl(
	value: string,
	fieldName: string,
	allowInsecureHttp: boolean,
): URL {
	let parsed: URL

	try {
		parsed = new URL(value)
	} catch {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`${fieldName} must be an absolute HTTP or HTTPS URL`,
		)
	}

	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`${fieldName} must use HTTP or HTTPS`,
		)
	}

	if (parsed.username !== '' || parsed.password !== '') {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`${fieldName} may not contain embedded credentials`,
		)
	}

	if (parsed.hash !== '') {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`${fieldName} may not contain a URL fragment`,
		)
	}

	if (
		parsed.protocol === 'http:' &&
		!allowInsecureHttp &&
		!isLoopbackHostname(parsed.hostname)
	) {
		throw new HarnessError(
			'INSECURE_PROVIDER_URL',
			`${fieldName} must use HTTPS unless it targets loopback or QWEN_ALLOW_INSECURE_HTTP=true is explicitly set`,
		)
	}

	return parsed
}

function isLoopbackHostname(value: string): boolean {
	const hostname = value.toLowerCase().replace(/^\[|\]$/g, '')
	const addressFamily = isIP(hostname)

	if (addressFamily === 4) {
		return hostname.split('.')[0] === '127'
	}

	if (addressFamily === 6) {
		return hostname === '::1'
	}

	return hostname === 'localhost' || hostname.endsWith('.localhost')
}

async function findExistingParent(candidatePath: string): Promise<string> {
	let current = candidatePath

	while (true) {
		try {
			await lstat(current)
			return current
		} catch (error) {
			if (!isMissingFileError(error)) {
				throw error
			}
		}

		const parent = path.dirname(current)

		if (parent === current) {
			throw new HarnessError(
				'ARTIFACT_PATH_RESOLUTION_FAILED',
				`Unable to resolve an existing parent for ${candidatePath}`,
			)
		}

		current = parent
	}
}

function isMissingFileError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === 'ENOENT'
	)
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

	const normalized = value.trim()

	if (!/^-?\d+$/.test(normalized)) {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`Expected an integer between ${min} and ${max}, received ${value}`,
		)
	}

	const parsed = Number(normalized)

	if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
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
