import path from 'node:path'
import type {
	AcceptanceCriterionResult,
	CommandResult,
	RunStatus,
	WorkerRunReport,
	WorkerTask,
} from '../domain/types.js'
import type { HarnessConfig } from '../config.js'
import { assertProviderConfigured, resolveArtifactRoot } from '../config.js'
import { ArtifactStore, sha256 } from '../artifacts/store.js'
import {
	applyPatch,
	assertSafeRepositoryConfiguration,
	checkPatch,
	getBinaryPatch,
	getChangedFiles,
	isWorkingTreeClean,
	resolveCommit,
	resolveRepositoryRoot,
} from '../git/repository.js'
import { WorktreeManager } from '../git/worktree.js'
import { HarnessError, getErrorMessage } from '../lib/errors.js'
import { Logger } from '../lib/logger.js'
import { Redactor } from '../lib/redaction.js'
import { acquireRepositoryLease } from '../lib/repository-lock.js'
import { Semaphore } from '../lib/semaphore.js'
import { OpenAiCompatibleProvider } from '../provider/openai-compatible.js'
import { CommandPolicy } from '../security/command-policy.js'
import { PathPolicy } from '../security/path-policy.js'
import { runAgentLoop } from './agent-loop.js'
import { createCommandRunner } from './command-runner.js'
import { WorkerToolExecutor } from './tool-executor.js'

export type ApplyPatchResult = {
	runId: string
	repositoryPath: string
	changedFiles: Array<string>
	applied: true
}

export class WorkerService {
	private readonly config: HarnessConfig
	private readonly logger: Logger
	private readonly worktreeManager: WorktreeManager
	private readonly artifactStore: ArtifactStore
	private readonly semaphore: Semaphore
	private readonly activeRepositories = new Set<string>()

	constructor(config: HarnessConfig) {
		this.config = config
		this.logger = new Logger('worker-service', config.logLevel)
		this.worktreeManager = new WorktreeManager(this.logger)
		this.artifactStore = new ArtifactStore(
			new Redactor(
				{ QWEN_API_KEY: config.provider.apiKey },
				Object.values(config.provider.headers),
			),
		)
		this.semaphore = new Semaphore(config.limits.maxConcurrency)
	}

	async delegate(
		task: WorkerTask,
		externalSignal?: AbortSignal,
	): Promise<WorkerRunReport> {
		return await this.semaphore.use(async () => {
			assertProviderConfigured(this.config)
			const repositoryPath = await resolveRepositoryRoot(task.repositoryPath)
			await assertSafeRepositoryConfiguration(repositoryPath)
			this.assertRepositoryAvailable(repositoryPath)
			const lease = await acquireRepositoryLease(
				resolveArtifactRoot(repositoryPath, this.config),
			)
			this.activeRepositories.add(repositoryPath)

			try {
				return await this.executeInWorktree(
					{ ...task, repositoryPath },
					externalSignal,
				)
			} finally {
				this.activeRepositories.delete(repositoryPath)
				await lease.release()
			}
		})
	}

	async getRun(repositoryPath: string, runId: string): Promise<WorkerRunReport> {
		const repositoryRoot = await resolveRepositoryRoot(repositoryPath)
		return await this.artifactStore.loadReport(
			resolveArtifactRoot(repositoryRoot, this.config),
			runId,
		)
	}

	async applyRun(
		repositoryPath: string,
		runId: string,
	): Promise<ApplyPatchResult> {
		const repositoryRoot = await resolveRepositoryRoot(repositoryPath)
		await assertSafeRepositoryConfiguration(repositoryRoot)
		const lease = await acquireRepositoryLease(
			resolveArtifactRoot(repositoryRoot, this.config),
		)

		try {
			return await this.applyRunWithLease(repositoryRoot, runId)
		} finally {
			await lease.release()
		}
	}

	private async applyRunWithLease(
		repositoryRoot: string,
		runId: string,
	): Promise<ApplyPatchResult> {
		const artifactRoot = resolveArtifactRoot(repositoryRoot, this.config)
		const report = await this.artifactStore.loadReport(artifactRoot, runId)

		if (path.resolve(report.repositoryPath) !== repositoryRoot) {
			throw new HarnessError(
				'RUN_REPOSITORY_MISMATCH',
				'Worker run belongs to a different repository',
			)
		}

		if (report.status !== 'completed') {
			throw new HarnessError(
				'RUN_NOT_APPLICABLE',
				`Only completed worker runs can be applied; status is ${report.status}`,
			)
		}

		if (
			report.patchPath === null ||
			report.patchSha256 === null ||
			report.changedFiles.length === 0
		) {
			throw new HarnessError(
				'RUN_HAS_NO_PATCH',
				'Worker run does not contain a patch',
			)
		}


		if (!(await isWorkingTreeClean(repositoryRoot))) {
			throw new HarnessError(
				'DIRTY_WORKING_TREE',
				'Working tree must be clean before applying a worker patch',
			)
		}

		const currentHead = await resolveCommit(repositoryRoot, 'HEAD')

		if (currentHead !== report.baseRef) {
			throw new HarnessError(
				'BASE_COMMIT_CHANGED',
				'Current HEAD differs from the commit used by the worker. Re-run the task against the current branch.',
				{ expected: report.baseRef, actual: currentHead },
			)
		}

		const patchContents = await this.artifactStore.loadPatch(
			artifactRoot,
			report,
		)

		if (patchContents.length === 0) {
			throw new HarnessError('EMPTY_PATCH', 'Worker patch is empty')
		}

		if (sha256(patchContents) !== report.patchSha256) {
			throw new HarnessError(
				'PATCH_INTEGRITY_FAILED',
				'Worker patch does not match the recorded SHA-256 digest',
			)
		}

		await checkPatch(repositoryRoot, patchContents)
		await applyPatch(repositoryRoot, patchContents)
		this.logger.info('Applied worker patch', { runId, repositoryRoot })

		return {
			runId,
			repositoryPath: repositoryRoot,
			changedFiles: report.changedFiles,
			applied: true,
		}
	}

	private async executeInWorktree(
		task: WorkerTask,
		externalSignal?: AbortSignal,
	): Promise<WorkerRunReport> {
		const startedAtMs = Date.now()
		const startedAt = new Date(startedAtMs).toISOString()
		const worktree = await this.worktreeManager.create(
			task.repositoryPath,
			task.baseRef,
		)
		const commandResults: Array<CommandResult> = []
		const policyViolations: Array<string> = []
		const warnings: Array<string> = []
		const timeoutController = new AbortController()
		const signal = externalSignal === undefined
			? timeoutController.signal
			: AbortSignal.any([externalSignal, timeoutController.signal])
		const timeout = setTimeout(
			() => timeoutController.abort(),
			task.timeoutSeconds * 1_000,
		)
		const sandboxHome = path.join(worktree.parentPath, 'home')
		const provider = new OpenAiCompatibleProvider(
			this.config.provider,
			new Logger('qwen-provider', this.config.logLevel),
		)
		const commandRunner = createCommandRunner(this.config)
		const toolExecutor = new WorkerToolExecutor({
			task,
			worktreePath: worktree.path,
			repositoryPath: task.repositoryPath,
			sandboxHome,
			config: this.config,
			commandRunner,
			commandResults,
			policyViolations,
			signal,
		})
		let workerSummary = ''
		let transcript = ''
		let status: RunStatus = 'completed'

		if (
			this.config.execution.backend === 'local' &&
			this.config.execution.allowUnsandboxedLocal
		) {
			warnings.push(
				'Commands ran locally without OS-level isolation. Use the Docker backend for untrusted repositories.',
			)
		}

		try {
			const loopResult = await runAgentLoop(
				task,
				provider,
				toolExecutor,
				signal,
			)
			workerSummary = loopResult.finalResponse
			transcript = loopResult.transcript
			await this.runRequiredCommands(
				task,
				commandRunner,
				commandResults,
				worktree.path,
				sandboxHome,
				signal,
			)
		} catch (error) {
			workerSummary = getErrorMessage(error)
			transcript = `${transcript}\n\nerror: ${workerSummary}`.trim()
			status = externalSignal?.aborted === true
				? 'cancelled'
				: timeoutController.signal.aborted
					? 'timed_out'
					: error instanceof HarnessError && isPolicyCode(error.code)
						? 'policy_violation'
						: 'failed'
		} finally {
			clearTimeout(timeout)
		}

		let patch = ''
		let changedFiles: Array<string> = []

		try {
			patch = await getBinaryPatch(worktree.path)
			changedFiles = await getChangedFiles(worktree.path)
			this.validateChangedPaths(task, worktree.path, changedFiles, policyViolations)
		} catch (error) {
			status = 'failed'
			warnings.push(`Patch collection failed: ${getErrorMessage(error)}`)
		}

		if (policyViolations.length > 0) {
			status = 'policy_violation'
		}

		if (commandResults.some(result => result.exitCode !== 0 || result.timedOut)) {
			status = 'failed'
		}

		if (
			task.mode === 'implementation' &&
			changedFiles.length === 0 &&
			status === 'completed'
		) {
			status = 'blocked'
			warnings.push('Implementation task completed without producing file changes.')
		}

		const completedAtMs = Date.now()
		const initialReport: WorkerRunReport = {
			schemaVersion: 1,
			runId: worktree.runId,
			status,
			objective: task.objective,
			mode: task.mode,
			repositoryPath: task.repositoryPath,
			baseRef: worktree.baseCommit,
			startedAt,
			completedAt: new Date(completedAtMs).toISOString(),
			durationMs: completedAtMs - startedAtMs,
			workerSummary,
			changedFiles,
			patchPath: null,
			patchSha256: null,
			reportPath: '',
			commandResults,
			acceptanceCriteria: buildAcceptanceResults(
				task.acceptanceCriteria,
				commandResults,
				status,
			),
			policyViolations,
			warnings,
			provider: {
				baseUrl: this.config.provider.baseUrl,
				model: this.config.provider.model,
				requestCount: provider.getRequestCount(),
			},
		}

		try {
			return await this.artifactStore.persist({
				artifactRoot: resolveArtifactRoot(task.repositoryPath, this.config),
				report: initialReport,
				patch,
				workerTranscript: transcript,
			})
		} finally {
			await worktree.cleanup()
		}
	}

	private async runRequiredCommands(
		task: WorkerTask,
		commandRunner: ReturnType<typeof createCommandRunner>,
		commandResults: Array<CommandResult>,
		worktreePath: string,
		sandboxHome: string,
		signal: AbortSignal,
	): Promise<void> {
		const policy = new CommandPolicy(this.config.execution.allowedCommands)

		for (const specification of task.requiredCommands) {
			policy.assertAllowed(specification)
			const result = await commandRunner.run(specification, {
				worktreePath,
				repositoryPath: task.repositoryPath,
				sandboxHome,
				task,
				signal,
			})
			commandResults.push(result)
		}
	}

	private validateChangedPaths(
		task: WorkerTask,
		worktreePath: string,
		changedFiles: Array<string>,
		policyViolations: Array<string>,
	): void {
		const policy = new PathPolicy(
			worktreePath,
			task.allowedPaths,
			task.prohibitedPaths,
		)

		for (const changedFile of changedFiles) {
			try {
				policy.assertAllowed(changedFile)
			} catch (error) {
				policyViolations.push(getErrorMessage(error))
			}
		}
	}

	private assertRepositoryAvailable(repositoryPath: string): void {
		if (this.activeRepositories.has(repositoryPath)) {
			throw new HarnessError(
				'REPOSITORY_BUSY',
				'Another worker task is already running for this repository',
			)
		}
	}
}

function buildAcceptanceResults(
	criteria: Array<string>,
	commandResults: Array<CommandResult>,
	status: RunStatus,
): Array<AcceptanceCriterionResult> {
	const failedCommands = commandResults.filter(
		result => result.exitCode !== 0 || result.timedOut,
	)

	return criteria.map(criterion => {
		if (
			status === 'policy_violation' ||
			status === 'timed_out' ||
			status === 'cancelled'
		) {
			return {
				criterion,
				status: 'failed',
				evidence: [`Run ended with status ${status}`],
			}
		}

		if (failedCommands.length > 0) {
			return {
				criterion,
				status: 'failed',
				evidence: failedCommands.map(
					result =>
						`${result.command} ${result.args.join(' ')} exited ${result.exitCode ?? result.signal}`,
				),
			}
		}

		return {
			criterion,
			status: 'unknown',
			evidence:
				commandResults.length === 0
					? ['No deterministic validation command was provided.']
					: commandResults.map(
						result =>
							`${result.command} ${result.args.join(' ')} exited ${result.exitCode}`,
					),
		}
	})
}

function isPolicyCode(code: string): boolean {
	return (
		code.includes('DENIED') ||
		code.includes('NOT_ALLOWED') ||
		code === 'READ_ONLY_TASK'
	)
}
