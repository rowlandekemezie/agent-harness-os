import path from 'node:path'
import type { CommandSpec, WorkerMode, WorkerTask } from '../domain/types.js'
import type { HarnessConfig } from '../config.js'
import { isProviderConfigured, resolveArtifactRoot } from '../config.js'
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
	private readonly workerService: WorkerService

	constructor(config: HarnessConfig) {
		this.config = config
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
				case 'delegate_to_worker':
					return result(
						await this.workerService.delegate(
							parseWorkerTask(rawArguments),
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

		const providerConfigured = isProviderConfigured(this.config)
		const dockerImagePinned = isPinnedDockerImage(
			this.config.execution.dockerImage,
		)
		const executionReady = this.config.execution.backend === 'docker'
			? docker.available && (
				dockerImagePinned ||
				!this.config.execution.requirePinnedDockerImage
			)
			: this.config.execution.allowUnsandboxedLocal

		return {
			status: !git.available || !providerConfigured
				? 'needs_configuration'
				: executionReady
					? 'ready'
					: 'limited',
			providerConfigured,
			providerModel: this.config.provider.model || null,
			executionBackend: this.config.execution.backend,
			localExecutionEnabled: this.config.execution.allowUnsandboxedLocal,
			dockerImagePinned,
			git,
			docker,
			artifactRootExample: resolveArtifactRoot(process.cwd(), this.config),
			limits: this.config.limits,
			warnings: [
				...(this.config.provider.allowInsecureHttp
					? ['Insecure HTTP provider endpoints are explicitly enabled. Provider credentials and source context may cross the network without transport encryption.']
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

function parseWorkerTask(value: unknown): WorkerTask {
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
