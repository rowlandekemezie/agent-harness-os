import path from 'node:path'
import type {
	CommandSpec,
	RoutingStrategy,
	WorkerCapability,
	WorkerCostTier,
	WorkerLatencyTier,
	WorkerMode,
	WorkerRoutingPolicy,
	WorkerTask,
} from '../domain/types.js'
import type { HarnessConfig } from '../config.js'
import {
	getConfiguredWorkers,
	isWorkerConfigured,
	resolveArtifactRoot,
} from '../config.js'
import { HarnessError } from '../lib/errors.js'
import {
	isRecord,
	optionalBoolean,
	optionalInteger,
	optionalString,
	requireRecord,
	requireString,
} from '../lib/json.js'
import { createSanitizedEnvironment, runProcess } from '../lib/process.js'
import { WorkerRegistry } from '../provider/registry.js'
import type { WorkerRoute } from '../provider/router.js'
import { Logger } from '../lib/logger.js'
import { WorkerService } from '../worker/service.js'

export type McpToolDefinition = {
	name: string
	description: string
	inputSchema: Record<string, unknown>
	annotations: {
		title: string
		readOnlyHint: boolean
		destructiveHint: boolean
		idempotentHint: boolean
		openWorldHint: boolean
	}
}

export type McpToolResult = {
	content: Array<{ type: 'text'; text: string }>
	structuredContent?: Record<string, unknown>
	isError?: boolean
}

const toolDefinitions: Array<McpToolDefinition> = [
	{
		name: 'health_check',
		description: 'Inspect harness configuration and runtime dependencies without making changes.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: annotation('Harness health check', true, false, true),
	},
	{
		name: 'list_workers',
		description: 'List configured workers, adapters, capabilities, routing metadata, and configuration issues without exposing secrets.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: annotation('List worker registry', true, false, true),
	},
	{
		name: 'route_worker',
		description: 'Preview deterministic worker routing for a task without invoking a model or changing a repository.',
		inputSchema: {
			type: 'object',
			properties: {
				mode: { enum: ['research', 'implementation', 'testing', 'review'] },
				routing: routingSchema(),
			},
			additionalProperties: false,
		},
		annotations: annotation('Preview worker route', true, false, true),
	},
	{
		name: 'delegate_to_worker',
		description: 'Run one bounded task in an isolated Git worktree and return an auditable patch artifact. This never changes the caller\'s checkout.',
		inputSchema: {
			type: 'object',
			properties: {
				objective: { type: 'string', minLength: 1, maxLength: 4000 },
				repositoryPath: { type: 'string', minLength: 1, maxLength: 4096 },
				mode: { enum: ['research', 'implementation', 'testing', 'review'] },
				allowedPaths: {
					type: 'array',
					items: { type: 'string', minLength: 1, maxLength: 1024 },
					minItems: 1,
					maxItems: 100,
				},
				prohibitedPaths: {
					type: 'array',
					items: { type: 'string', minLength: 1, maxLength: 1024 },
					maxItems: 100,
				},
				acceptanceCriteria: {
					type: 'array',
					items: { type: 'string', minLength: 1, maxLength: 2000 },
					maxItems: 100,
				},
				requiredCommands: {
					type: 'array',
					maxItems: 20,
					items: {
						type: 'object',
						properties: {
							command: { type: 'string' },
							args: {
								type: 'array',
								items: { type: 'string', maxLength: 2000 },
								maxItems: 100,
							},
							timeoutMs: { type: 'integer', minimum: 1000, maximum: 900000 },
						},
						required: ['command', 'args'],
						additionalProperties: false,
					},
				},
				baseRef: { type: 'string', minLength: 1, maxLength: 1024 },
				maxIterations: { type: 'integer', minimum: 1, maximum: 64 },
				timeoutSeconds: { type: 'integer', minimum: 30, maximum: 3600 },
				allowNetwork: { type: 'boolean' },
				routing: routingSchema(),
			},
			required: ['objective', 'repositoryPath', 'allowedPaths'],
			additionalProperties: false,
		},
		annotations: annotation(
			'Delegate bounded worker task',
			false,
			false,
			false,
			true,
		),
	},
	{
		name: 'get_worker_run',
		description: 'Load the persisted report for a previous worker run.',
		inputSchema: {
			type: 'object',
			properties: {
				repositoryPath: { type: 'string', minLength: 1, maxLength: 4096 },
				runId: { type: 'string', minLength: 36, maxLength: 36 },
			},
			required: ['repositoryPath', 'runId'],
			additionalProperties: false,
		},
		annotations: annotation('Read worker run', true, false, true),
	},
	{
		name: 'list_tasks',
		description: 'List durable task history for one repository with bounded filters and cursor pagination.',
		inputSchema: {
			type: 'object',
			properties: {
				repositoryPath: { type: 'string', minLength: 1, maxLength: 4096 },
				limit: { type: 'integer', minimum: 1, maximum: 100 },
				cursor: { type: 'string', minLength: 36, maxLength: 36 },
				status: {
					enum: [
						'in_progress',
						'completed',
						'failed',
						'blocked',
						'policy_violation',
						'timed_out',
						'cancelled',
					],
				},
				mode: { enum: ['research', 'implementation', 'testing', 'review'] },
				workerId: { type: 'string', minLength: 1, maxLength: 64 },
			},
			required: ['repositoryPath'],
			additionalProperties: false,
		},
		annotations: annotation('List task history', true, false, true),
	},
	{
		name: 'get_task_timeline',
		description: 'Load a task summary and its validated append-only event timeline.',
		inputSchema: {
			type: 'object',
			properties: {
				repositoryPath: { type: 'string', minLength: 1, maxLength: 4096 },
				taskId: { type: 'string', minLength: 36, maxLength: 36 },
			},
			required: ['repositoryPath', 'taskId'],
			additionalProperties: false,
		},
		annotations: annotation('Read task timeline', true, false, true),
	},
	{
		name: 'apply_worker_patch',
		description: 'Apply a completed worker patch to a clean checkout after integrity, base-commit, and git-apply checks.',
		inputSchema: {
			type: 'object',
			properties: {
				repositoryPath: { type: 'string', minLength: 1, maxLength: 4096 },
				runId: { type: 'string', minLength: 36, maxLength: 36 },
			},
			required: ['repositoryPath', 'runId'],
			additionalProperties: false,
		},
		annotations: annotation('Apply worker patch', false, true, false),
	},
]

export class McpTools {
	private readonly config: HarnessConfig
	private readonly workerRegistry: WorkerRegistry
	private readonly workerService: WorkerService

	constructor(config: HarnessConfig) {
		this.config = config
		this.workerRegistry = new WorkerRegistry(
			config,
			new Logger('worker-registry', config.logLevel),
		)
		this.workerService = new WorkerService(config)
	}

	list(): Array<McpToolDefinition> {
		return toolDefinitions
	}

	async call(
		name: string,
		rawArguments: unknown,
		signal?: AbortSignal,
	): Promise<McpToolResult> {
		try {
			switch (name) {
				case 'health_check':
					return result(await this.healthCheck())
				case 'list_workers':
					return result({ workers: this.workerRegistry.list() })
				case 'route_worker': {
					const argumentsRecord = requireRecord(rawArguments, 'arguments')
					const mode = parseMode(argumentsRecord['mode'])
					const routing = parseRoutingPolicy(
						argumentsRecord['routing'],
						this.config,
					)
					return result(
						serializeRoute(this.workerRegistry.route(mode, routing)),
					)
				}
				case 'delegate_to_worker':
					return result(
						await this.workerService.delegate(
							parseWorkerTask(rawArguments, this.config),
							signal,
						),
					)
				case 'get_worker_run': {
					const argumentsRecord = requireRecord(rawArguments, 'arguments')
					return result(
						await this.workerService.getRun(
							requireString(argumentsRecord['repositoryPath'], 'repositoryPath', { minLength: 1, maxLength: 4_096 }),
							requireString(argumentsRecord['runId'], 'runId', { minLength: 36, maxLength: 36 }),
						),
					)
				}
				case 'list_tasks': {
					const argumentsRecord = requireRecord(rawArguments, 'arguments')
					return result(
						await this.workerService.listTasks(
							requireString(argumentsRecord['repositoryPath'], 'repositoryPath', { minLength: 1, maxLength: 4_096 }),
							{
								limit: optionalInteger(
									argumentsRecord['limit'],
									'limit',
									50,
									{ min: 1, max: 100 },
								),
								cursor: argumentsRecord['cursor'] === undefined
									? null
									: requireString(argumentsRecord['cursor'], 'cursor', { minLength: 36, maxLength: 36 }),
								status: parseTaskStatus(argumentsRecord['status']),
								mode: parseOptionalMode(argumentsRecord['mode']),
								workerId: argumentsRecord['workerId'] === undefined
									? null
									: requireString(argumentsRecord['workerId'], 'workerId', { minLength: 1, maxLength: 64 }),
							},
						),
					)
				}
				case 'get_task_timeline': {
					const argumentsRecord = requireRecord(rawArguments, 'arguments')
					return result(
						await this.workerService.getTaskTimeline(
							requireString(argumentsRecord['repositoryPath'], 'repositoryPath', { minLength: 1, maxLength: 4_096 }),
							requireString(argumentsRecord['taskId'], 'taskId', { minLength: 36, maxLength: 36 }),
						),
					)
				}
				case 'apply_worker_patch': {
					const argumentsRecord = requireRecord(rawArguments, 'arguments')
					return result(
						await this.workerService.applyRun(
							requireString(argumentsRecord['repositoryPath'], 'repositoryPath', { minLength: 1, maxLength: 4_096 }),
							requireString(argumentsRecord['runId'], 'runId', { minLength: 36, maxLength: 36 }),
						),
					)
				}
				default:
					throw new HarnessError('UNKNOWN_MCP_TOOL', `Unknown MCP tool: ${name}`)
			}
		} catch (error) {
			const payload = error instanceof HarnessError
				? { error: error.code, message: error.message, details: error.details }
				: { error: 'TOOL_FAILED', message: error instanceof Error ? error.message : String(error) }

			return {
				content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
				structuredContent: payload,
				isError: true,
			}
		}
	}

	private async healthCheck(): Promise<Record<string, unknown>> {
		const git = await checkCommand('git', ['--version'])
		const docker = await checkCommand('docker', ['--version'])

		const configuredWorkers = getConfiguredWorkers(this.config)
		const workersConfigured = configuredWorkers.length > 0
		const dockerImagePinned = isPinnedDockerImage(
			this.config.execution.dockerImage,
		)
		const defaultWorker = this.config.routing.defaultWorkerId === null
			? null
			: this.config.workers.find(
				worker => worker.id === this.config.routing.defaultWorkerId,
			) ?? null
		const executionReady = this.config.execution.backend === 'docker'
			? docker.available && (
				dockerImagePinned ||
				!this.config.execution.requirePinnedDockerImage
			)
			: this.config.execution.allowUnsandboxedLocal

		return {
			status: !git.available || !workersConfigured
				? 'needs_configuration'
				: executionReady
					? 'ready'
					: 'limited',
			workersConfigured,
			configuredWorkerCount: configuredWorkers.length,
			defaultWorkerId: this.config.routing.defaultWorkerId,
			defaultRoutingStrategy: this.config.routing.defaultStrategy,
			workers: this.workerRegistry.list(),
			executionBackend: this.config.execution.backend,
			localExecutionEnabled: this.config.execution.allowUnsandboxedLocal,
			dockerImagePinned,
			git,
			docker,
			artifactRootExample: resolveArtifactRoot(process.cwd(), this.config),
			limits: this.config.limits,
			warnings: [
				...(defaultWorker !== null && !isWorkerConfigured(defaultWorker)
					? [`Default worker ${defaultWorker.id} is not fully configured and will not receive routing preference.`]
					: []),
				...(this.config.workers.some(worker => worker.allowInsecureHttp)
					? ['One or more workers explicitly allow insecure HTTP. Provider credentials and source context may cross the network without transport encryption.']
					: []),
				...(this.config.execution.backend === 'local' && !this.config.execution.allowUnsandboxedLocal
					? ['Deterministic validation commands are disabled until Docker is selected or unsandboxed local execution is explicitly enabled. Worker file tools still work.']
					: []),
				...(
					this.config.execution.backend === 'local' &&
					this.config.execution.allowUnsandboxedLocal
						? ['Local validation is unsandboxed and requires task allowNetwork=true because local network isolation cannot be enforced.']
						: []
				),
				...(this.config.execution.backend === 'docker' && !docker.available
					? ['Docker backend is selected but Docker is unavailable.']
					: []),
				...(
					this.config.execution.backend === 'docker' &&
					this.config.execution.requirePinnedDockerImage &&
					!dockerImagePinned
						? ['Docker image must be pinned with @sha256:<digest>.']
						: []
				),
			],
		}
	}
}

function parseWorkerTask(value: unknown, config: HarnessConfig): WorkerTask {
	const input = requireRecord(value, 'arguments')
	const repositoryPath = path.resolve(
		requireString(input['repositoryPath'], 'repositoryPath', {
			minLength: 1,
			maxLength: 4_096,
		}),
	)
	const mode = parseMode(input['mode'])
	const requiredCommands = parseCommandSpecs(input['requiredCommands'])

	if (
		(mode === 'research' || mode === 'review') &&
		requiredCommands.length > 0
	) {
		throw new HarnessError(
			'INVALID_ARGUMENT',
			`${mode} tasks are read-only and cannot execute validation commands`,
		)
	}

	return {
		objective: requireString(input['objective'], 'objective', { minLength: 1, maxLength: 4000 }),
		repositoryPath,
		mode,
		allowedPaths: parseBoundedStringArray(input['allowedPaths'], 'allowedPaths', {
			required: true,
			minItems: 1,
			maxItems: 100,
			maxItemLength: 1_024,
		}),
		prohibitedPaths: parseBoundedStringArray(
			input['prohibitedPaths'],
			'prohibitedPaths',
			{ maxItems: 100, maxItemLength: 1_024 },
		),
		acceptanceCriteria: parseBoundedStringArray(
			input['acceptanceCriteria'],
			'acceptanceCriteria',
			{ maxItems: 100, maxItemLength: 2_000 },
		),
		requiredCommands,
		baseRef: optionalString(input['baseRef'], 'baseRef', 'HEAD'),
		maxIterations: optionalInteger(input['maxIterations'], 'maxIterations', 24, { min: 1, max: 64 }),
		timeoutSeconds: optionalInteger(input['timeoutSeconds'], 'timeoutSeconds', 900, { min: 30, max: 3600 }),
		allowNetwork: optionalBoolean(input['allowNetwork'], 'allowNetwork', false),
		routing: parseRoutingPolicy(input['routing'], config),
	}
}

function parseMode(value: unknown): WorkerMode {
	if (value === undefined) {
		return 'implementation'
	}

	if (value === 'research' || value === 'implementation' || value === 'testing' || value === 'review') {
		return value
	}

	throw new HarnessError('INVALID_ARGUMENT', 'mode must be research, implementation, testing, or review')
}

function parseOptionalMode(value: unknown): WorkerMode | null {
	return value === undefined ? null : parseMode(value)
}

function parseTaskStatus(
	value: unknown,
): 'in_progress' | 'completed' | 'failed' | 'blocked' | 'policy_violation' | 'timed_out' | 'cancelled' | null {
	if (value === undefined) {
		return null
	}
	if (
		value === 'in_progress' ||
		value === 'completed' ||
		value === 'failed' ||
		value === 'blocked' ||
		value === 'policy_violation' ||
		value === 'timed_out' ||
		value === 'cancelled'
	) {
		return value
	}
	throw new HarnessError('INVALID_ARGUMENT', 'status is not a supported task status')
}

type BoundedStringArrayOptions = {
	required?: boolean
	minItems?: number
	maxItems: number
	maxItemLength: number
}

function parseBoundedStringArray(
	value: unknown,
	fieldName: string,
	options: BoundedStringArrayOptions,
): Array<string> {
	if (value === undefined) {
		if (options.required === true) {
			throw new HarnessError(
				'INVALID_ARGUMENT',
				`${fieldName} is required`,
			)
		}

		return []
	}

	if (
		!Array.isArray(value) ||
		value.length < (options.minItems ?? 0) ||
		value.length > options.maxItems ||
		value.some(
			item =>
				typeof item !== 'string' ||
				item.length === 0 ||
				item.length > options.maxItemLength,
		)
	) {
		throw new HarnessError(
			'INVALID_ARGUMENT',
			`${fieldName} must contain between ${options.minItems ?? 0} and ${options.maxItems} non-empty strings of at most ${options.maxItemLength} characters`,
		)
	}

	return [...value] as Array<string>
}

function parseCommandSpecs(value: unknown): Array<CommandSpec> {
	if (value === undefined) {
		return []
	}

	if (!Array.isArray(value)) {
		throw new HarnessError('INVALID_ARGUMENT', 'requiredCommands must be an array')
	}

	if (value.length > 20) {
		throw new HarnessError(
			'INVALID_ARGUMENT',
			'requiredCommands may contain at most 20 commands',
		)
	}

	return value.map((item, index) => {
		const record = requireRecord(item, `requiredCommands[${index}]`)
		const rawArgs = record['args']

		if (
			!Array.isArray(rawArgs) ||
			rawArgs.length > 100 ||
			rawArgs.some(
				argument => typeof argument !== 'string' || argument.length > 2_000,
			)
		) {
			throw new HarnessError('INVALID_ARGUMENT', `requiredCommands[${index}].args must contain at most 100 strings of at most 2000 characters`)
		}

		return {
			command: requireString(record['command'], `requiredCommands[${index}].command`, { minLength: 1, maxLength: 100 }),
			args: rawArgs as Array<string>,
			...(record['timeoutMs'] === undefined
				? {}
				: {
					timeoutMs: optionalInteger(record['timeoutMs'], `requiredCommands[${index}].timeoutMs`, 120000, { min: 1000, max: 900000 }),
				}),
		}
	})
}


function routingSchema(): Record<string, unknown> {
	return {
		type: 'object',
		properties: {
			preferredWorkerId: { type: 'string', minLength: 1, maxLength: 64 },
			requiredCapabilities: {
				type: 'array',
				items: {
					enum: [
						'research',
						'implementation',
						'testing',
						'review',
						'tool-calling',
						'long-context',
						'private',
					],
				},
				maxItems: 16,
			},
			strategy: { enum: ['balanced', 'cost', 'latency', 'quality'] },
			maxCostTier: { enum: ['low', 'medium', 'high'] },
			maxLatencyTier: { enum: ['fast', 'standard', 'slow'] },
			allowFallback: { type: 'boolean' },
			maxAttempts: { type: 'integer', minimum: 1, maximum: 8 },
		},
		additionalProperties: false,
	}
}

function parseRoutingPolicy(
	value: unknown,
	config: HarnessConfig,
): WorkerRoutingPolicy {
	if (value === undefined) {
		return {
			preferredWorkerId: null,
			requiredCapabilities: [],
			strategy: config.routing.defaultStrategy,
			maxCostTier: null,
			maxLatencyTier: null,
			allowFallback: true,
			maxAttempts: config.routing.maxAttempts,
		}
	}

	const input = requireRecord(value, 'routing')
	return {
		preferredWorkerId: input['preferredWorkerId'] === undefined
			? null
			: requireString(input['preferredWorkerId'], 'routing.preferredWorkerId', {
				minLength: 1,
				maxLength: 64,
			}),
		requiredCapabilities: parseCapabilitiesArgument(
			input['requiredCapabilities'],
		),
		strategy: parseRoutingStrategyArgument(
			input['strategy'],
			config.routing.defaultStrategy,
		),
		maxCostTier: parseCostTierArgument(input['maxCostTier']),
		maxLatencyTier: parseLatencyTierArgument(input['maxLatencyTier']),
		allowFallback: optionalBoolean(
			input['allowFallback'],
			'routing.allowFallback',
			true,
		),
		maxAttempts: optionalInteger(
			input['maxAttempts'],
			'routing.maxAttempts',
			config.routing.maxAttempts,
			{ min: 1, max: 8 },
		),
	}
}

function parseCapabilitiesArgument(value: unknown): Array<WorkerCapability> {
	if (value === undefined) {
		return []
	}
	if (!Array.isArray(value) || value.length > 16) {
		throw new HarnessError(
			'INVALID_ARGUMENT',
			'routing.requiredCapabilities must contain at most 16 capabilities',
		)
	}

	return [...new Set(value.map(item => {
		if (!isWorkerCapability(item)) {
			throw new HarnessError(
				'INVALID_ARGUMENT',
				`Unsupported worker capability: ${String(item)}`,
			)
		}
		return item
	}))]
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

function parseRoutingStrategyArgument(
	value: unknown,
	fallback: RoutingStrategy,
): RoutingStrategy {
	if (value === undefined) {
		return fallback
	}
	if (
		value === 'balanced' ||
		value === 'cost' ||
		value === 'latency' ||
		value === 'quality'
	) {
		return value
	}
	throw new HarnessError(
		'INVALID_ARGUMENT',
		'routing.strategy must be balanced, cost, latency, or quality',
	)
}

function parseCostTierArgument(value: unknown): WorkerCostTier | null {
	if (value === undefined) {
		return null
	}
	if (value === 'low' || value === 'medium' || value === 'high') {
		return value
	}
	throw new HarnessError(
		'INVALID_ARGUMENT',
		'routing.maxCostTier must be low, medium, or high',
	)
}

function parseLatencyTierArgument(value: unknown): WorkerLatencyTier | null {
	if (value === undefined) {
		return null
	}
	if (value === 'fast' || value === 'standard' || value === 'slow') {
		return value
	}
	throw new HarnessError(
		'INVALID_ARGUMENT',
		'routing.maxLatencyTier must be fast, standard, or slow',
	)
}

function serializeRoute(route: WorkerRoute): Record<string, unknown> {
	return {
		strategy: route.strategy,
		requiredCapabilities: route.requiredCapabilities,
		maxAttempts: route.maxAttempts,
		fallbackEnabled: route.fallbackEnabled,
		candidates: route.candidates.map(candidate => ({
			workerId: candidate.worker.id,
			profile: candidate.worker.profile,
			adapter: candidate.worker.adapter,
			model: candidate.worker.model,
			capabilities: candidate.worker.capabilities,
			costTier: candidate.worker.costTier,
			latencyTier: candidate.worker.latencyTier,
			priority: candidate.worker.priority,
			score: candidate.score,
			reasons: candidate.reasons,
		})),
	}
}


function isPinnedDockerImage(image: string): boolean {
	return (
		/@sha256:[a-f0-9]{64}$/i.test(image) ||
		/^sha256:[a-f0-9]{64}$/i.test(image)
	)
}

function annotation(
	title: string,
	readOnlyHint: boolean,
	destructiveHint: boolean,
	idempotentHint: boolean,
	openWorldHint = false,
): McpToolDefinition['annotations'] {
	return { title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint }
}

function result(value: unknown): McpToolResult {
	const structuredContent = isRecord(value) ? value : { value }
	return {
		content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
		structuredContent,
	}
}

async function checkCommand(command: string, args: Array<string>): Promise<Record<string, unknown>> {
	try {
		const result = await runProcess(command, args, {
			cwd: process.cwd(),
			environment: createSanitizedEnvironment(),
			timeoutMs: 5000,
			maxOutputBytes: 4096,
		})
		return {
			available: result.exitCode === 0,
			version: result.exitCode === 0 ? result.stdout.trim() : null,
		}
	} catch {
		return { available: false, version: null }
	}
}
