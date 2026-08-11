import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isIP } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type {
	ExecutionBackend,
	RoutingStrategy,
	WorkerAdapter,
	WorkerCapability,
	WorkerCostTier,
	WorkerLatencyTier,
	WorkerMode,
} from './domain/types.js'
import { HarnessError } from './lib/errors.js'
import { isRecord, parseJsonObject } from './lib/json.js'
import type { LogLevel } from './lib/logger.js'

export type WorkerAuth = 'bearer' | 'api-key' | 'none'

export type CodexAuthMode = 'chatgpt' | 'any'

export type OpenAiMaxOutputTokensParameter =
	| 'max_tokens'
	| 'max_completion_tokens'
	| 'none'

export type WorkerPricing = {
	inputPerMillion: number | null
	outputPerMillion: number | null
}

export type WorkerEvaluationPolicy = 'default' | 'strict'

export type WorkerProfile = {
	backingWorkerId: string
	role: WorkerMode
	maxIterations: number
	evaluationPolicy: WorkerEvaluationPolicy
}

export type WorkerConfig = {
	id: string
	enabled: boolean
	adapter: WorkerAdapter
	model: string
	baseUrl: string
	endpointUrl: string | null
	apiKeyEnv: string | null
	apiKey: string
	auth: WorkerAuth
	headers: Record<string, string>
	headerEnvNames: Array<string>
	capabilities: Array<WorkerCapability>
	priority: number
	costTier: WorkerCostTier
	latencyTier: WorkerLatencyTier
	timeoutMs: number
	maxRetries: number
	maxResponseBytes: number
	maxOutputTokens: number
	maxOutputTokensParameter: OpenAiMaxOutputTokensParameter
	temperature: number | null
	allowInsecureHttp: boolean
	anthropicVersion: string
	pricing: WorkerPricing
	codexCommand: string | null
	codexAuthMode: CodexAuthMode | null
	configurationIssues: Array<string>
	profile: WorkerProfile | null
}

export type WorkerSecrets = {
	namedSecrets: Record<string, string>
	additionalSecrets: Array<string>
}

export type HarnessConfig = {
	workers: Array<WorkerConfig>
	redactionSecrets: WorkerSecrets
	workerSecretEnvironmentNames: Array<string>
	routing: {
		defaultWorkerId: string | null
		defaultStrategy: RoutingStrategy
		maxAttempts: number
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
	const backend = parseExecutionBackend(
		environment['AGENT_HARNESS_EXECUTION_BACKEND'] ?? 'local',
	)
	const backingWorkers = loadWorkers(environment)
	const workers = loadWorkerProfiles(environment, backingWorkers)
	const requestedDefaultWorkerId =
		environment['AGENT_OS_DEFAULT_WORKER']?.trim() || null

	if (
		requestedDefaultWorkerId !== null &&
		!workers.some(worker => worker.id === requestedDefaultWorkerId)
	) {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`AGENT_OS_DEFAULT_WORKER references an unknown worker: ${requestedDefaultWorkerId}`,
		)
	}

	return {
		workers,
		redactionSecrets: collectWorkerSecrets(backingWorkers),
		workerSecretEnvironmentNames:
			collectWorkerSecretEnvironmentNames(backingWorkers),
		routing: {
			defaultWorkerId: requestedDefaultWorkerId,
			defaultStrategy: parseRoutingStrategy(
				environment['AGENT_OS_ROUTING_STRATEGY'] ?? 'balanced',
			),
			maxAttempts: parseInteger(
				environment['AGENT_OS_MAX_WORKER_ATTEMPTS'],
				3,
				1,
				8,
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

export function assertWorkersConfigured(config: HarnessConfig): void {
	const configuredWorkers = config.workers.filter(isWorkerConfigured)

	if (configuredWorkers.length === 0) {
		const issues = config.workers.flatMap(worker =>
			worker.configurationIssues.map(issue => `${worker.id}: ${issue}`),
		)
		throw new HarnessError(
			'WORKERS_NOT_CONFIGURED',
			issues.length === 0
				? 'No workers are configured. Set AGENT_OS_WORKERS_JSON or the legacy QWEN_* variables.'
				: `No usable workers are configured: ${issues.join('; ')}`,
		)
	}
}

export function isWorkerConfigured(worker: WorkerConfig): boolean {
	return worker.enabled && worker.configurationIssues.length === 0
}

export function getConfiguredWorkers(config: HarnessConfig): Array<WorkerConfig> {
	return config.workers.filter(isWorkerConfigured)
}

export function getWorkerSecrets(config: HarnessConfig): WorkerSecrets {
	return {
		namedSecrets: { ...config.redactionSecrets.namedSecrets },
		additionalSecrets: [...config.redactionSecrets.additionalSecrets],
	}
}

export function getWorkerSecretEnvironmentNames(
	config: HarnessConfig,
): Array<string> {
	return [...config.workerSecretEnvironmentNames]
}

function collectWorkerSecrets(workers: Array<WorkerConfig>): WorkerSecrets {
	const namedSecrets: Record<string, string> = {}
	const additionalSecrets: Array<string> = []

	for (const worker of workers) {
		if (worker.apiKey !== '') {
			namedSecrets[worker.apiKeyEnv ?? `${worker.id.toUpperCase()}_API_KEY`] =
				worker.apiKey
		}
		additionalSecrets.push(...Object.values(worker.headers))
	}

	return { namedSecrets, additionalSecrets }
}

function collectWorkerSecretEnvironmentNames(
	workers: Array<WorkerConfig>,
): Array<string> {
	return [...new Set(workers.flatMap(worker => [
		...(worker.apiKeyEnv === null ? [] : [worker.apiKeyEnv]),
		...worker.headerEnvNames,
	]))]
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

function loadWorkers(environment: NodeJS.ProcessEnv): Array<WorkerConfig> {
	const workersJson = environment['AGENT_OS_WORKERS_JSON']?.trim()
	const workers = workersJson === undefined || workersJson === ''
		? [parseLegacyQwenWorker(environment)]
		: parseWorkerDefinitions(workersJson, environment)
	const ids = new Set<string>()

	for (const worker of workers) {
		if (ids.has(worker.id)) {
			throw new HarnessError(
				'INVALID_CONFIGURATION',
				`Worker IDs must be unique: ${worker.id}`,
			)
		}
		ids.add(worker.id)
	}

	return workers
}

function parseLegacyQwenWorker(environment: NodeJS.ProcessEnv): WorkerConfig {
	const allowInsecureHttp = parseBoolean(
		environment['QWEN_ALLOW_INSECURE_HTTP'],
		false,
	)
	const baseUrl = normalizeBaseUrl(
		environment['QWEN_BASE_URL'] ?? '',
		allowInsecureHttp,
		'QWEN_BASE_URL',
	)
	const endpointUrl = normalizeEndpointUrl(
		environment['QWEN_CHAT_COMPLETIONS_URL'] ?? '',
		allowInsecureHttp,
		'QWEN_CHAT_COMPLETIONS_URL',
	)
	const apiKey = environment['QWEN_API_KEY']?.trim() ?? ''
	const model = environment['QWEN_MODEL']?.trim() ?? ''
	const issues: Array<string> = []

	if (baseUrl === '' && endpointUrl === null) {
		issues.push('QWEN_BASE_URL or QWEN_CHAT_COMPLETIONS_URL is missing')
	}
	if (apiKey === '') {
		issues.push('QWEN_API_KEY is missing')
	}
	if (model === '') {
		issues.push('QWEN_MODEL is missing')
	}

	return {
		id: 'qwen',
		enabled: true,
		adapter: 'openai-compatible',
		model,
		baseUrl,
		endpointUrl,
		apiKeyEnv: 'QWEN_API_KEY',
		apiKey,
		auth: 'bearer',
		headers: parseStringHeaders(
			environment['QWEN_HEADERS_JSON'] ?? '{}',
			'QWEN_HEADERS_JSON',
		),
		headerEnvNames: [],
		capabilities: [
			'research',
			'implementation',
			'testing',
			'review',
			'tool-calling',
		],
		priority: 50,
		costTier: 'low',
		latencyTier: 'standard',
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
		maxOutputTokens: 8_192,
		maxOutputTokensParameter: 'max_tokens',
		temperature: 0.1,
		allowInsecureHttp,
		anthropicVersion: '2023-06-01',
		pricing: { inputPerMillion: null, outputPerMillion: null },
		codexCommand: null,
		codexAuthMode: null,
		configurationIssues: issues,
		profile: null,
	}
}

function parseWorkerDefinitions(
	value: string,
	environment: NodeJS.ProcessEnv,
): Array<WorkerConfig> {
	let parsed: unknown

	try {
		parsed = JSON.parse(value)
	} catch {
		throw new HarnessError(
			'INVALID_JSON',
			'AGENT_OS_WORKERS_JSON must contain valid JSON',
		)
	}

	if (Buffer.byteLength(value, 'utf8') > 1_048_576) {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			'AGENT_OS_WORKERS_JSON may not exceed 1 MiB',
		)
	}

	if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 32) {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			'AGENT_OS_WORKERS_JSON must be an array containing 1 to 32 workers',
		)
	}

	return parsed.map((entry, index) =>
		parseWorkerDefinition(entry, index, environment),
	)
}

function parseWorkerDefinition(
	value: unknown,
	index: number,
	environment: NodeJS.ProcessEnv,
): WorkerConfig {
	if (!isRecord(value)) {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`AGENT_OS_WORKERS_JSON[${index}] must be an object`,
		)
	}

	const prefix = `AGENT_OS_WORKERS_JSON[${index}]`
	const id = requireConfigString(value['id'], `${prefix}.id`)

	if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`${prefix}.id must contain only lowercase letters, digits, dots, underscores, and hyphens`,
		)
	}

	const adapter = parseWorkerAdapter(value['adapter'], `${prefix}.adapter`)

	if (adapter === 'codex') {
		return parseCodexWorkerDefinition(value, prefix, id)
	}
	const allowInsecureHttp = parseOptionalBoolean(
		value['allowInsecureHttp'],
		false,
		`${prefix}.allowInsecureHttp`,
	)
	const baseUrl = normalizeBaseUrl(
		optionalConfigString(value['baseUrl'], ''),
		allowInsecureHttp,
		`${prefix}.baseUrl`,
	)
	const endpointUrl = normalizeEndpointUrl(
		optionalConfigString(value['endpointUrl'], ''),
		allowInsecureHttp,
		`${prefix}.endpointUrl`,
	)
	const apiKeyEnv = optionalNullableConfigString(value['apiKeyEnv'])
	if (apiKeyEnv !== null) {
		assertEnvironmentVariableName(apiKeyEnv, `${prefix}.apiKeyEnv`)
	}
	const apiKey = apiKeyEnv === null
		? ''
		: environment[apiKeyEnv]?.trim() ?? ''
	const auth = parseWorkerAuth(value['auth'], adapter)
	const staticHeaders = parseHeadersRecord(value['headers'], `${prefix}.headers`)
	const environmentHeaderResult = parseEnvironmentHeaders(
		value['headerEnv'],
		`${prefix}.headerEnv`,
		environment,
	)
	const model = requireConfigString(value['model'], `${prefix}.model`)
	if (model.length > 512) {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`${prefix}.model may not exceed 512 characters`,
		)
	}
	const capabilities = parseCapabilities(
		value['capabilities'],
		`${prefix}.capabilities`,
	)
	const issues: Array<string> = [
		...environmentHeaderResult.missingEnvironmentNames.map(
			(name: string) => `${name} is missing`,
		),
	]

	if (baseUrl === '' && endpointUrl === null) {
		issues.push('baseUrl or endpointUrl is missing')
	}
	if (auth !== 'none' && apiKey === '') {
		issues.push(
			apiKeyEnv === null
				? 'apiKeyEnv is required for authenticated workers'
				: `${apiKeyEnv} is missing`,
		)
	}
	if (!capabilities.includes('tool-calling')) {
		issues.push('tool-calling capability is required by this harness')
	}

	return {
		id,
		enabled: parseOptionalBoolean(
			value['enabled'],
			true,
			`${prefix}.enabled`,
		),
		adapter,
		model,
		baseUrl,
		endpointUrl,
		apiKeyEnv,
		apiKey,
		auth,
		headers: { ...staticHeaders, ...environmentHeaderResult.headers },
		headerEnvNames: environmentHeaderResult.environmentNames,
		capabilities,
		priority: parseOptionalInteger(
			value['priority'],
			50,
			0,
			100,
			`${prefix}.priority`,
		),
		costTier: parseCostTier(value['costTier'], `${prefix}.costTier`),
		latencyTier: parseLatencyTier(
			value['latencyTier'],
			`${prefix}.latencyTier`,
		),
		timeoutMs: parseOptionalInteger(
			value['timeoutMs'],
			120_000,
			1_000,
			900_000,
			`${prefix}.timeoutMs`,
		),
		maxRetries: parseOptionalInteger(
			value['maxRetries'],
			3,
			0,
			8,
			`${prefix}.maxRetries`,
		),
		maxResponseBytes: parseOptionalInteger(
			value['maxResponseBytes'],
			4_194_304,
			65_536,
			20_971_520,
			`${prefix}.maxResponseBytes`,
		),
		maxOutputTokens: parseOptionalInteger(
			value['maxOutputTokens'],
			8_192,
			256,
			131_072,
			`${prefix}.maxOutputTokens`,
		),
		maxOutputTokensParameter: parseMaxOutputTokensParameter(
			value['maxOutputTokensParameter'],
			adapter,
			`${prefix}.maxOutputTokensParameter`,
		),
		temperature: parseOptionalNullableNumberInRange(
			value['temperature'],
			`${prefix}.temperature`,
			0,
			2,
		),
		allowInsecureHttp,
		anthropicVersion: boundedOptionalConfigString(
			value['anthropicVersion'],
			'2023-06-01',
			`${prefix}.anthropicVersion`,
			64,
		),
		pricing: parsePricing(value['pricing'], `${prefix}.pricing`),
		codexCommand: null,
		codexAuthMode: null,
		configurationIssues: issues,
		profile: null,
	}
}

function parseCodexWorkerDefinition(
	value: Record<string, unknown>,
	prefix: string,
	id: string,
): WorkerConfig {
	const unsupportedFields = [
		'baseUrl',
		'endpointUrl',
		'apiKeyEnv',
		'auth',
		'headers',
		'headerEnv',
		'allowInsecureHttp',
		'anthropicVersion',
		'pricing',
		'maxRetries',
		'maxOutputTokens',
		'maxOutputTokensParameter',
		'temperature',
	]
	const suppliedUnsupportedFields = unsupportedFields.filter(
		field => value[field] !== undefined,
	)

	if (suppliedUnsupportedFields.length > 0) {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`${prefix} uses provider fields that are not valid for the codex adapter: ${suppliedUnsupportedFields.join(', ')}`,
		)
	}

	const capabilities = parseCapabilities(
		value['capabilities'],
		`${prefix}.capabilities`,
	)
	const issues: Array<string> = []

	if (!capabilities.includes('tool-calling')) {
		issues.push('tool-calling capability is required by this harness')
	}

	return {
		id,
		enabled: parseOptionalBoolean(
			value['enabled'],
			true,
			`${prefix}.enabled`,
		),
		adapter: 'codex',
		model: boundedOptionalConfigString(
			value['model'],
			'',
			`${prefix}.model`,
			512,
		),
		baseUrl: '',
		endpointUrl: null,
		apiKeyEnv: null,
		apiKey: '',
		auth: 'none',
		headers: {},
		headerEnvNames: [],
		capabilities,
		priority: parseOptionalInteger(
			value['priority'],
			90,
			0,
			100,
			`${prefix}.priority`,
		),
		costTier: parseCostTier(value['costTier'] ?? 'low', `${prefix}.costTier`),
		latencyTier: parseLatencyTier(
			value['latencyTier'],
			`${prefix}.latencyTier`,
		),
		timeoutMs: parseOptionalInteger(
			value['timeoutMs'],
			180_000,
			1_000,
			900_000,
			`${prefix}.timeoutMs`,
		),
		maxRetries: 0,
		maxResponseBytes: parseOptionalInteger(
			value['maxResponseBytes'],
			1_048_576,
			65_536,
			20_971_520,
			`${prefix}.maxResponseBytes`,
		),
		maxOutputTokens: 8_192,
		maxOutputTokensParameter: 'none',
		temperature: null,
		allowInsecureHttp: false,
		anthropicVersion: '2023-06-01',
		pricing: { inputPerMillion: null, outputPerMillion: null },
		codexCommand: boundedOptionalConfigString(
			value['command'],
			'codex',
			`${prefix}.command`,
			4_096,
		),
		codexAuthMode: parseCodexAuthMode(
			value['authMode'],
			`${prefix}.authMode`,
		),
		configurationIssues: issues,
		profile: null,
	}
}

function loadWorkerProfiles(
	environment: NodeJS.ProcessEnv,
	backingWorkers: Array<WorkerConfig>,
): Array<WorkerConfig> {
	const profilesJson = environment['AGENT_OS_WORKER_PROFILES_JSON']?.trim()

	if (profilesJson === undefined || profilesJson === '') {
		return backingWorkers
	}
	if (Buffer.byteLength(profilesJson, 'utf8') > 1_048_576) {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			'AGENT_OS_WORKER_PROFILES_JSON may not exceed 1 MiB',
		)
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(profilesJson)
	} catch {
		throw new HarnessError(
			'INVALID_JSON',
			'AGENT_OS_WORKER_PROFILES_JSON must contain valid JSON',
		)
	}
	if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 64) {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			'AGENT_OS_WORKER_PROFILES_JSON must be an array containing 1 to 64 profiles',
		)
	}

	const workerById = new Map(
		backingWorkers.map(worker => [worker.id, worker]),
	)
	const profileIds = new Set<string>()

	return parsed.map((value, index) => {
		const prefix = `AGENT_OS_WORKER_PROFILES_JSON[${index}]`
		if (!isRecord(value)) {
			throw new HarnessError(
				'INVALID_CONFIGURATION',
				`${prefix} must be an object`,
			)
		}
		assertProfileFields(value, prefix)
		const id = requireConfigString(value['id'], `${prefix}.id`)
		assertWorkerId(id, `${prefix}.id`)
		if (profileIds.has(id)) {
			throw new HarnessError(
				'INVALID_CONFIGURATION',
				`Worker profile IDs must be unique: ${id}`,
			)
		}
		profileIds.add(id)

		const backingWorkerId = requireConfigString(
			value['worker'],
			`${prefix}.worker`,
		)
		const backingWorker = workerById.get(backingWorkerId)
		if (backingWorker === undefined) {
			throw new HarnessError(
				'INVALID_CONFIGURATION',
				`${prefix}.worker references an unknown worker: ${backingWorkerId}`,
			)
		}
		const role = parseWorkerMode(value['role'], `${prefix}.role`)
		const allowedCapabilities = parseCapabilities(
			value['allowedCapabilities'],
			`${prefix}.allowedCapabilities`,
		)
		if (!allowedCapabilities.includes(role)) {
			throw new HarnessError(
				'INVALID_CONFIGURATION',
				`${prefix}.allowedCapabilities must include the profile role ${role}`,
			)
		}
		if (!allowedCapabilities.includes('tool-calling')) {
			throw new HarnessError(
				'INVALID_CONFIGURATION',
				`${prefix}.allowedCapabilities must include tool-calling`,
			)
		}
		const excessiveCapabilities = allowedCapabilities.filter(
			capability => !backingWorker.capabilities.includes(capability),
		)
		if (excessiveCapabilities.length > 0) {
			throw new HarnessError(
				'INVALID_CONFIGURATION',
				`${prefix}.allowedCapabilities exceeds worker ${backingWorkerId}: ${excessiveCapabilities.join(', ')}`,
			)
		}

		return {
			...backingWorker,
			id,
			enabled: backingWorker.enabled && parseOptionalBoolean(
				value['enabled'],
				true,
				`${prefix}.enabled`,
			),
			capabilities: allowedCapabilities,
			profile: {
				backingWorkerId,
				role,
				maxIterations: parseOptionalInteger(
					value['maxIterations'],
					20,
					1,
					64,
					`${prefix}.maxIterations`,
				),
				evaluationPolicy: parseEvaluationPolicy(
					value['evaluationPolicy'],
					`${prefix}.evaluationPolicy`,
				),
			},
		}
	})
}

function assertProfileFields(
	value: Record<string, unknown>,
	prefix: string,
): void {
	const allowedFields = new Set([
		'id',
		'worker',
		'role',
		'enabled',
		'maxIterations',
		'allowedCapabilities',
		'evaluationPolicy',
	])
	const unknownFields = Object.keys(value).filter(
		field => !allowedFields.has(field),
	)
	if (unknownFields.length > 0) {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`${prefix} contains unsupported fields: ${unknownFields.join(', ')}`,
		)
	}
}

function assertWorkerId(value: string, fieldName: string): void {
	if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`${fieldName} must contain only lowercase letters, digits, dots, underscores, and hyphens`,
		)
	}
}

function parseWorkerMode(value: unknown, fieldName: string): WorkerMode {
	if (
		value === 'research' ||
		value === 'implementation' ||
		value === 'testing' ||
		value === 'review'
	) {
		return value
	}
	throw new HarnessError(
		'INVALID_CONFIGURATION',
		`${fieldName} must be research, implementation, testing, or review`,
	)
}

function parseEvaluationPolicy(
	value: unknown,
	fieldName: string,
): WorkerEvaluationPolicy {
	if (value === undefined || value === 'default') {
		return 'default'
	}
	if (value === 'strict') {
		return 'strict'
	}
	throw new HarnessError(
		'INVALID_CONFIGURATION',
		`${fieldName} must be default or strict`,
	)
}

function repositoryKey(repositoryPath: string): string {
	return createHash('sha256')
		.update(path.resolve(repositoryPath))
		.digest('hex')
		.slice(0, 24)
}

function normalizeBaseUrl(
	value: string,
	allowInsecureHttp: boolean,
	fieldName: string,
): string {
	const trimmed = value.trim().replace(/\/+$/, '')

	if (Buffer.byteLength(trimmed, 'utf8') > 4_096) {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`${fieldName} may not exceed 4096 bytes`,
		)
	}

	if (trimmed === '') {
		return ''
	}

	const parsed = validateProviderUrl(trimmed, fieldName, allowInsecureHttp)

	if (parsed.search !== '') {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`${fieldName} may not contain a query string; use endpointUrl for a full endpoint`,
		)
	}

	return trimmed
}

function normalizeEndpointUrl(
	value: string,
	allowInsecureHttp: boolean,
	fieldName: string,
): string | null {
	const trimmed = value.trim()

	if (Buffer.byteLength(trimmed, 'utf8') > 4_096) {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`${fieldName} may not exceed 4096 bytes`,
		)
	}

	if (trimmed === '') {
		return null
	}

	validateProviderUrl(trimmed, fieldName, allowInsecureHttp)
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

	for (const key of parsed.searchParams.keys()) {
		if (isSensitiveCredentialName(key)) {
			throw new HarnessError(
				'INVALID_CONFIGURATION',
				`${fieldName} may not contain credentials in query parameters; use apiKeyEnv or headerEnv`,
			)
		}
	}

	if (
		parsed.protocol === 'http:' &&
		!allowInsecureHttp &&
		!isLoopbackHostname(parsed.hostname)
	) {
		throw new HarnessError(
			'INSECURE_PROVIDER_URL',
			`${fieldName} must use HTTPS unless it targets loopback or allowInsecureHttp=true is explicitly set`,
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

function parseWorkerAdapter(value: unknown, fieldName: string): WorkerAdapter {
	if (
		value === 'openai-compatible' ||
		value === 'anthropic' ||
		value === 'codex'
	) {
		return value
	}

	throw new HarnessError(
		'INVALID_CONFIGURATION',
		`${fieldName} must be openai-compatible, anthropic, or codex`,
	)
}

function parseMaxOutputTokensParameter(
	value: unknown,
	adapter: WorkerAdapter,
	fieldName: string,
): OpenAiMaxOutputTokensParameter {
	if (adapter === 'anthropic' || adapter === 'codex') {
		return 'none'
	}
	if (value === undefined) {
		return 'max_tokens'
	}
	if (
		value === 'max_tokens' ||
		value === 'max_completion_tokens' ||
		value === 'none'
	) {
		return value
	}
	throw new HarnessError(
		'INVALID_CONFIGURATION',
		`${fieldName} must be max_tokens, max_completion_tokens, or none`,
	)
}

function parseWorkerAuth(value: unknown, adapter: WorkerAdapter): WorkerAuth {
	if (adapter === 'codex') {
		if (value === undefined || value === 'none') {
			return 'none'
		}
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			'Codex workers reuse Codex CLI authentication and must use auth none',
		)
	}

	if (adapter === 'anthropic') {
		if (value === undefined || value === 'api-key') {
			return 'api-key'
		}
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			'Anthropic workers must use api-key authentication',
		)
	}

	if (value === undefined) {
		return 'bearer'
	}

	if (value === 'bearer' || value === 'none') {
		return value
	}

	throw new HarnessError(
		'INVALID_CONFIGURATION',
		'OpenAI-compatible worker auth must be bearer or none',
	)
}

function parseCodexAuthMode(value: unknown, fieldName: string): CodexAuthMode {
	if (value === undefined || value === 'chatgpt') {
		return 'chatgpt'
	}
	if (value === 'any') {
		return 'any'
	}
	throw new HarnessError(
		'INVALID_CONFIGURATION',
		`${fieldName} must be chatgpt or any`,
	)
}

function parseCapabilities(
	value: unknown,
	fieldName: string,
): Array<WorkerCapability> {
	if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`${fieldName} must contain 1 to 16 capabilities`,
		)
	}

	const capabilities = value.map(item => {
		if (!isWorkerCapability(item)) {
			throw new HarnessError(
				'INVALID_CONFIGURATION',
				`${fieldName} contains an unsupported capability: ${String(item)}`,
			)
		}
		return item
	})

	return [...new Set(capabilities)]
}

function isWorkerCapability(value: unknown): value is WorkerCapability {
	return (
		value === 'research' ||
		value === 'implementation' ||
		value === 'testing' ||
		value === 'review' ||
		value === 'tool-calling' ||
		value === 'long-context' ||
		value === 'private'
	)
}

function parseCostTier(value: unknown, fieldName: string): WorkerCostTier {
	if (value === undefined) {
		return 'medium'
	}
	if (value === 'low' || value === 'medium' || value === 'high') {
		return value
	}
	throw new HarnessError(
		'INVALID_CONFIGURATION',
		`${fieldName} must be low, medium, or high`,
	)
}

function parseLatencyTier(
	value: unknown,
	fieldName: string,
): WorkerLatencyTier {
	if (value === undefined) {
		return 'standard'
	}
	if (value === 'fast' || value === 'standard' || value === 'slow') {
		return value
	}
	throw new HarnessError(
		'INVALID_CONFIGURATION',
		`${fieldName} must be fast, standard, or slow`,
	)
}

function parseRoutingStrategy(value: string): RoutingStrategy {
	if (
		value === 'balanced' ||
		value === 'cost' ||
		value === 'latency' ||
		value === 'quality'
	) {
		return value
	}

	throw new HarnessError(
		'INVALID_CONFIGURATION',
		'AGENT_OS_ROUTING_STRATEGY must be balanced, cost, latency, or quality',
	)
}

function parsePricing(value: unknown, fieldName: string): WorkerPricing {
	if (value === undefined) {
		return { inputPerMillion: null, outputPerMillion: null }
	}
	if (!isRecord(value)) {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`${fieldName} must be an object`,
		)
	}

	return {
		inputPerMillion: parseOptionalNullableNumber(
			value['inputPerMillion'],
			`${fieldName}.inputPerMillion`,
		),
		outputPerMillion: parseOptionalNullableNumber(
			value['outputPerMillion'],
			`${fieldName}.outputPerMillion`,
		),
	}
}

function parseOptionalNullableNumberInRange(
	value: unknown,
	fieldName: string,
	min: number,
	max: number,
): number | null {
	if (value === undefined || value === null) {
		return null
	}
	if (
		typeof value !== 'number' ||
		!Number.isFinite(value) ||
		value < min ||
		value > max
	) {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`${fieldName} must be a number between ${min} and ${max}, or null`,
		)
	}
	return value
}

function parseOptionalNullableNumber(
	value: unknown,
	fieldName: string,
): number | null {
	if (value === undefined || value === null) {
		return null
	}
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`${fieldName} must be a non-negative number or null`,
		)
	}
	return value
}

function parseHeadersRecord(
	value: unknown,
	fieldName: string,
): Record<string, string> {
	if (value === undefined) {
		return {}
	}
	if (!isRecord(value)) {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`${fieldName} must be an object`,
		)
	}

	const entries = Object.entries(value)
	if (entries.length > 32) {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`${fieldName} may contain at most 32 headers`,
		)
	}

	const headers: Record<string, string> = {}
	for (const [key, headerValue] of entries) {
		if (
			typeof headerValue !== 'string' ||
			key.length === 0 ||
			key.length > 128 ||
			Buffer.byteLength(headerValue, 'utf8') > 4_096
		) {
			throw new HarnessError(
				'INVALID_CONFIGURATION',
				`${fieldName}.${key} must use a non-empty header name of at most 128 characters and a string value of at most 4096 bytes`,
			)
		}
		if (isSensitiveCredentialName(key)) {
			throw new HarnessError(
				'INVALID_CONFIGURATION',
				`${fieldName}.${key} must be sourced through apiKeyEnv or headerEnv rather than embedded in AGENT_OS_WORKERS_JSON`,
			)
		}
		headers[key] = headerValue
	}
	return headers
}

function parseEnvironmentHeaders(
	value: unknown,
	fieldName: string,
	environment: NodeJS.ProcessEnv,
): {
	headers: Record<string, string>
	missingEnvironmentNames: Array<string>
	environmentNames: Array<string>
} {
	if (value === undefined) {
		return { headers: {}, missingEnvironmentNames: [], environmentNames: [] }
	}
	if (!isRecord(value)) {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`${fieldName} must be an object mapping header names to environment variable names`,
		)
	}

	const entries = Object.entries(value)
	if (entries.length > 32) {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`${fieldName} may contain at most 32 headers`,
		)
	}

	const headers: Record<string, string> = {}
	const missingEnvironmentNames: Array<string> = []
	const environmentNames: Array<string> = []
	for (const [headerName, environmentName] of entries) {
		if (headerName.length === 0 || headerName.length > 128) {
			throw new HarnessError(
				'INVALID_CONFIGURATION',
				`${fieldName} header names must contain 1 to 128 characters`,
			)
		}
		if (typeof environmentName !== 'string') {
			throw new HarnessError(
				'INVALID_CONFIGURATION',
				`${fieldName}.${headerName} must name an environment variable`,
			)
		}
		assertEnvironmentVariableName(
			environmentName,
			`${fieldName}.${headerName}`,
		)
		environmentNames.push(environmentName)
		const headerValue = environment[environmentName]?.trim()
		if (headerValue === undefined || headerValue === '') {
			missingEnvironmentNames.push(environmentName)
			continue
		}
		if (Buffer.byteLength(headerValue, 'utf8') > 4_096) {
			throw new HarnessError(
				'INVALID_CONFIGURATION',
				`${environmentName} may not exceed 4096 bytes`,
			)
		}
		headers[headerName] = headerValue
	}
	return { headers, missingEnvironmentNames, environmentNames }
}

function assertEnvironmentVariableName(
	value: string,
	fieldName: string,
): void {
	if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`${fieldName} must be a valid environment-variable name of at most 128 characters`,
		)
	}
}

function isSensitiveCredentialName(value: string): boolean {
	const normalized = value.toLowerCase().replaceAll('_', '-').trim()
	return (
		normalized === 'key' ||
		/(?:authorization|credential|secret|token|password|cookie|signature|api-?key)/.test(
			normalized,
		)
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

function parseOptionalInteger(
	value: unknown,
	fallback: number,
	min: number,
	max: number,
	fieldName: string,
): number {
	if (value === undefined) {
		return fallback
	}
	if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`${fieldName} must be an integer between ${min} and ${max}`,
		)
	}
	return value as number
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

function parseOptionalBoolean(
	value: unknown,
	fallback: boolean,
	fieldName: string,
): boolean {
	if (value === undefined) {
		return fallback
	}
	if (typeof value !== 'boolean') {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`${fieldName} must be true or false`,
		)
	}
	return value
}

function parseCsv(value: string): Array<string> {
	return value
		.split(',')
		.map(item => item.trim())
		.filter(item => item.length > 0)
}

function parseStringHeaders(
	value: string,
	fieldName: string,
): Record<string, string> {
	const parsed = parseJsonObject(value, fieldName)
	return parseHeadersRecord(parsed, fieldName)
}

function requireConfigString(value: unknown, fieldName: string): string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`${fieldName} must be a non-empty string`,
		)
	}
	return value.trim()
}

function optionalConfigString(value: unknown, fallback: string): string {
	if (value === undefined) {
		return fallback
	}
	if (typeof value !== 'string') {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			'Optional worker string fields must be strings',
		)
	}
	return value.trim()
}

function boundedOptionalConfigString(
	value: unknown,
	fallback: string,
	fieldName: string,
	maxLength: number,
): string {
	const parsed = optionalConfigString(value, fallback)
	if (parsed.length > maxLength) {
		throw new HarnessError(
			'INVALID_CONFIGURATION',
			`${fieldName} may not exceed ${maxLength} characters`,
		)
	}
	return parsed
}

function optionalNullableConfigString(value: unknown): string | null {
	const parsed = optionalConfigString(value, '')
	return parsed === '' ? null : parsed
}

function parseLogLevel(value: string): LogLevel {
	if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') {
		return value
	}

	throw new HarnessError(
		'INVALID_CONFIGURATION',
		'AGENT_HARNESS_LOG_LEVEL must be debug, info, warn, or error',
	)
}
