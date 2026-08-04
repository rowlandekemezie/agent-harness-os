import { access, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { CommandResult, CommandSpec, WorkerTask } from '../domain/types.js'
import type { HarnessConfig } from '../config.js'
import { HarnessError } from '../lib/errors.js'
import { createSanitizedEnvironment, runProcess } from '../lib/process.js'

export type CommandRunnerContext = {
	worktreePath: string
	repositoryPath: string
	sandboxHome: string
	task: WorkerTask
	signal: AbortSignal
}

export interface CommandRunner {
	run(
		specification: CommandSpec,
		context: CommandRunnerContext,
	): Promise<CommandResult>
}

export function createCommandRunner(config: HarnessConfig): CommandRunner {
	return config.execution.backend === 'docker'
		? new DockerCommandRunner(config)
		: new LocalCommandRunner(config)
}

class LocalCommandRunner implements CommandRunner {
	private readonly config: HarnessConfig

	constructor(config: HarnessConfig) {
		this.config = config
	}

	async run(
		specification: CommandSpec,
		context: CommandRunnerContext,
	): Promise<CommandResult> {
		if (!this.config.execution.allowUnsandboxedLocal) {
			throw new HarnessError(
				'LOCAL_EXECUTION_DISABLED',
				'Local command execution is disabled. Use Docker or explicitly set AGENT_HARNESS_ALLOW_UNSANDBOXED_LOCAL=true for trusted repositories.',
			)
		}

		await mkdir(context.sandboxHome, { recursive: true, mode: 0o700 })
		const environment = createSanitizedEnvironment({
			HOME: context.sandboxHome,
			USERPROFILE: context.sandboxHome,
		})

		return await runProcess(specification.command, specification.args, {
			cwd: context.worktreePath,
			environment,
			timeoutMs:
				specification.timeoutMs ?? this.config.execution.commandTimeoutMs,
			maxOutputBytes: this.config.limits.maxToolOutputBytes,
			signal: context.signal,
		})
	}
}

class DockerCommandRunner implements CommandRunner {
	private readonly config: HarnessConfig

	constructor(config: HarnessConfig) {
		this.config = config
	}

	async run(
		specification: CommandSpec,
		context: CommandRunnerContext,
	): Promise<CommandResult> {
		await assertCommandAvailable('docker')

		if (
			this.config.execution.requirePinnedDockerImage &&
			!isPinnedDockerImage(this.config.execution.dockerImage)
		) {
			throw new HarnessError(
				'UNPINNED_DOCKER_IMAGE',
				'AGENT_HARNESS_DOCKER_IMAGE must use an immutable sha256 digest',
			)
		}
		const network = context.task.allowNetwork
			? this.config.execution.dockerNetwork
			: 'none'
		const args = [
			'run',
			'--rm',
			'--init',
			'--read-only',
			'--cap-drop',
			'ALL',
			'--security-opt',
			'no-new-privileges',
			'--pids-limit',
			'256',
			'--memory',
			'2g',
			'--cpus',
			'2',
			'--network',
			network,
			'--tmpfs',
			'/tmp:rw,noexec,nosuid,size=256m',
			'--mount',
			`type=bind,source=${context.worktreePath},target=/workspace`,
			'--workdir',
			'/workspace',
			'--env',
			'CI=true',
			'--env',
			'NO_COLOR=1',
			'--env',
			'HOME=/tmp',
		]

		if (process.platform !== 'win32' && typeof process.getuid === 'function') {
			args.push('--user', `${process.getuid()}:${process.getgid?.() ?? process.getuid()}`)
		}

		const nodeModulesPath = path.join(context.repositoryPath, 'node_modules')

		if (await pathExists(nodeModulesPath)) {
			args.push(
				'--mount',
				`type=bind,source=${nodeModulesPath},target=/workspace/node_modules,readonly`,
			)
		}

		args.push(
			this.config.execution.dockerImage,
			specification.command,
			...specification.args,
		)

		return await runProcess('docker', args, {
			cwd: context.repositoryPath,
			environment: createSanitizedEnvironment(),
			timeoutMs:
				specification.timeoutMs ?? this.config.execution.commandTimeoutMs,
			maxOutputBytes: this.config.limits.maxToolOutputBytes,
			signal: context.signal,
		})
	}
}

async function assertCommandAvailable(command: string): Promise<void> {
	const pathEntries = (process.env.PATH ?? '').split(path.delimiter)
	const candidates = process.platform === 'win32'
		? [`${command}.exe`, `${command}.cmd`, command]
		: [command]

	for (const directory of pathEntries) {
		for (const candidate of candidates) {
			try {
				await access(path.join(directory, candidate))
				return
			} catch {
				// Continue searching the PATH.
			}
		}
	}

	throw new HarnessError(
		'COMMAND_UNAVAILABLE',
		`Required command is not available: ${command}`,
	)
}

async function pathExists(candidatePath: string): Promise<boolean> {
	try {
		await access(candidatePath)
		return true
	} catch {
		return false
	}
}

function isPinnedDockerImage(image: string): boolean {
	return (
		/@sha256:[a-f0-9]{64}$/i.test(image) ||
		/^sha256:[a-f0-9]{64}$/i.test(image)
	)
}
