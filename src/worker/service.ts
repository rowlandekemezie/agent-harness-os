import path from 'node:path'
import type {
	AcceptanceCriterionResult,
	CommandResult,
	ProviderUsage,
	RunStatus,
	WorkerAttemptSummary,
	WorkerProvider,
	WorkerRunReport,
	WorkerTask,
} from '../domain/types.js'
import type { HarnessConfig, WorkerConfig } from '../config.js'
import {
	assertArtifactRootOutsideRepository,
	assertWorkersConfigured,
	getWorkerSecrets,
	resolveArtifactRoot,
} from '../config.js'
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
import { WorkerRegistry } from '../provider/registry.js'
import type { WorkerRoute } from '../provider/router.js'
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
	private readonly workerRegistry: WorkerRegistry
	private readonly semaphore: Semaphore
	private readonly activeRepositories = new Set<string>()

	constructor(config: HarnessConfig) {
		this.config = config
		this.logger = new Logger('worker-service', config.logLevel)
		this.worktreeManager = new WorktreeManager(this.logger)
		const workerSecrets = getWorkerSecrets(config)
		this.artifactStore = new ArtifactStore(
			new Redactor(
				workerSecrets.namedSecrets,
				workerSecrets.additionalSecrets,
			),
		)
		this.workerRegistry = new WorkerRegistry(config, this.logger)
		this.semaphore = new Semaphore(config.limits.maxConcurrency)
	}

	async delegate(
		task: WorkerTask,
		externalSignal?: AbortSignal,
	): Promise<WorkerRunReport> {
		return await this.semaphore.use(async () => {
			throwIfAborted(externalSignal)
			assertWorkersConfigured(this.config)
			this.assertTaskContract(task)
			const route = this.workerRegistry.route(task.mode, task.routing)
			const repositoryPath = await resolveRepositoryRoot(task.repositoryPath)
			await assertSafeRepositoryConfiguration(repositoryPath)
			this.assertRepositoryAvailable(repositoryPath)
			const artifactRoot = await this.getArtifactRoot(repositoryPath)
			const lease = await acquireRepositoryLease(artifactRoot)
			const deadlineMs = Date.now() + task.timeoutSeconds * 1_000
			const previousAttempts: Array<WorkerAttemptSummary> = []
			this.activeRepositories.add(repositoryPath)

			try {
				let lastReport: WorkerRunReport | null = null

				for (let index = 0; index < route.maxAttempts; index += 1) {
					throwIfAborted(externalSignal)
					if (Date.now() >= deadlineMs) {
						break
					}

					const candidate = route.candidates[index]
					if (candidate === undefined) {
						break
					}

					const report = await this.executeInWorktree(
						{ ...task, repositoryPath },
						candidate.worker,
						route,
						index + 1,
						previousAttempts,
						deadlineMs,
						externalSignal,
					)
					lastReport = report

					if (!shouldFallback(report, route, index)) {
						return report
					}

					previousAttempts.push({
						runId: report.runId,
						workerId: candidate.worker.id,
						status: report.status,
						failureCode: report.failureCode ?? null,
					})
				}

				if (lastReport !== null) {
					return lastReport
				}

				throw new HarnessError(
					'WORKER_ROUTE_TIMED_OUT',
					'Worker routing deadline expired before an attempt could start',
				)
			} finally {
				this.activeRepositories.delete(repositoryPath)
				await lease.release()
			}
		}, externalSignal)
	}

	async getRun(repositoryPath: string, runId: string): Promise<WorkerRunReport> {
		const repositoryRoot = await resolveRepositoryRoot(repositoryPath)
		return await this.artifactStore.loadReport(
			await this.getArtifactRoot(repositoryRoot),
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
			await this.getArtifactRoot(repositoryRoot),
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
		const artifactRoot = await this.getArtifactRoot(repositoryRoot)
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

		if (!(await isWorkingTreeClean(repositoryRoot))) {
			throw new HarnessError(
				'WORKING_TREE_CHANGED_DURING_APPLY',
				'Working tree changed while the patch was being verified',
			)
		}

		const recheckedHead = await resolveCommit(repositoryRoot, 'HEAD')

		if (recheckedHead !== report.baseRef) {
			throw new HarnessError(
				'BASE_COMMIT_CHANGED_DURING_APPLY',
				'HEAD changed while the patch was being verified',
				{ expected: report.baseRef, actual: recheckedHead },
			)
		}

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
		worker: WorkerConfig,
		route: WorkerRoute,
		attemptNumber: number,
		previousAttempts: Array<WorkerAttemptSummary>,
		deadlineMs: number,
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
			Math.max(1, deadlineMs - Date.now()),
		)
		const sandboxHome = path.join(worktree.parentPath, 'home')
		let provider: WorkerProvider
		let commandRunner: ReturnType<typeof createCommandRunner>
		let toolExecutor: WorkerToolExecutor

		try {
			provider = this.workerRegistry.createProvider(worker)
			commandRunner = createCommandRunner(this.config)
			toolExecutor = new WorkerToolExecutor({
				task,
				worktreePath: worktree.path,
				config: this.config,
				baseCommit: worktree.baseCommit,
				policyViolations,
				signal,
			})
		} catch (error) {
			clearTimeout(timeout)
			await worktree.cleanup()
			throw error
		}
		let workerSummary = ''
		let transcript = ''
		let status: RunStatus = 'completed'
		let failureCode: string | null = null
		let patch = ''
		let changedFiles: Array<string> = []
		let preserveWorktree = false

		if (
			this.config.execution.backend === 'local' &&
			this.config.execution.allowUnsandboxedLocal &&
			task.requiredCommands.length > 0
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
					{
						maxTotalToolCalls: this.config.limits.maxTotalToolCalls,
						maxContextBytes: this.config.limits.maxProviderContextBytes,
						maxAssistantContentBytes:
							this.config.limits.maxToolOutputBytes,
					},
				signal,
			)
			workerSummary = loopResult.finalResponse
			transcript = loopResult.transcript
		} catch (error) {
			workerSummary = getErrorMessage(error)
			transcript = `${transcript}\n\nerror: ${workerSummary}`.trim()
			failureCode = getFailureCode(error)
			status = classifyRunError(
				error,
				externalSignal,
				timeoutController.signal,
			)
		}

		try {
			const candidate = await this.collectPatchCandidate(
				task,
				worktree.path,
				worktree.baseCommit,
			)
			changedFiles = candidate.changedFiles
			patch = candidate.patch
			policyViolations.push(...candidate.policyViolations)
		} catch (error) {
			status = 'failed'
			failureCode = failureCode ?? getFailureCode(error)
			warnings.push(`Patch collection failed: ${getErrorMessage(error)}`)
		}

		if (policyViolations.length > 0) {
			status = 'policy_violation'
			failureCode = failureCode ?? 'WORKER_POLICY_VIOLATION'
		}

		if (status === 'completed') {
			try {
				await this.runRequiredCommands(
					task,
					commandRunner,
					commandResults,
					worktree.path,
					sandboxHome,
					signal,
				)

				if (externalSignal?.aborted === true) {
					status = 'cancelled'
				} else if (timeoutController.signal.aborted) {
					status = 'timed_out'
				}
			} catch (error) {
				failureCode = failureCode ?? getFailureCode(error)
				status = classifyRunError(
					error,
					externalSignal,
					timeoutController.signal,
				)
				if (
					error instanceof HarnessError &&
					error.code === 'DOCKER_CONTAINER_CLEANUP_FAILED'
				) {
					preserveWorktree = true
					patch = ''
					warnings.push(
						`The isolated worktree was preserved at ${worktree.path} because Docker cleanup could not be confirmed. Remove the named container, then run git worktree prune.`,
					)
				}
				warnings.push(`Validation command failed: ${getErrorMessage(error)}`)
			}

			if (task.requiredCommands.length > 0 && !preserveWorktree) {
				try {
					await this.assertValidationPreservedCandidate(
						task,
						worktree.path,
						worktree.baseCommit,
						changedFiles,
						patch,
					)
				} catch (error) {
					status = 'failed'
					failureCode = failureCode ?? getFailureCode(error)
					warnings.push(
						`Validation integrity check failed: ${getErrorMessage(error)}`,
					)
				}
			}
		}

		clearTimeout(timeout)

		if (
			status === 'completed' &&
			commandResults.some(result => result.exitCode !== 0 || result.timedOut)
		) {
			status = 'failed'
			failureCode = failureCode ?? 'VALIDATION_COMMAND_FAILED'
		}

		if (
			task.mode === 'implementation' &&
			changedFiles.length === 0 &&
			status === 'completed'
		) {
			status = 'blocked'
			failureCode = failureCode ?? 'WORKER_NO_CHANGES'
			warnings.push('Implementation task completed without producing file changes.')
		}

		const completedAtMs = Date.now()
		const usage = getProviderUsage(provider)
		const initialReport: WorkerRunReport = {
			schemaVersion: 1,
			runId: worktree.runId,
			status,
			failureCode,
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
				workerId: worker.id,
				adapter: worker.adapter,
				baseUrl: worker.endpointUrl ?? worker.baseUrl,
				model: worker.model,
				requestCount: usage.requestCount,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				totalTokens: usage.totalTokens,
				totalLatencyMs: usage.totalLatencyMs,
				estimatedCostUsd: usage.estimatedCostUsd,
			},
			routing: {
				strategy: route.strategy,
				requiredCapabilities: route.requiredCapabilities,
				candidateWorkerIds: route.candidates.map(candidate => candidate.worker.id),
				selectedWorkerId: worker.id,
				attemptNumber,
				maxAttempts: route.maxAttempts,
				fallbackEnabled: route.fallbackEnabled,
				previousAttempts: [...previousAttempts],
			},
		}

		try {
			return await this.artifactStore.persist({
				artifactRoot: await this.getArtifactRoot(task.repositoryPath),
				report: initialReport,
				patch,
				workerTranscript: transcript,
			})
		} finally {
			if (!preserveWorktree) {
				await worktree.cleanup()
			} else {
				this.logger.error(
					'Preserved worker worktree after unconfirmed Docker cleanup',
					undefined,
					{ runId: worktree.runId, worktreePath: worktree.path },
				)
			}
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

	private async collectPatchCandidate(
		task: WorkerTask,
		worktreePath: string,
		baseCommit: string,
	): Promise<{
		changedFiles: Array<string>
		patch: string
		policyViolations: Array<string>
	}> {
		const changedFiles = await getChangedFiles(worktreePath, baseCommit)

		if (changedFiles.length > this.config.limits.maxChangedFiles) {
			throw new HarnessError(
				'CHANGED_FILE_LIMIT',
				`Worker changed ${changedFiles.length} files, exceeding the limit of ${this.config.limits.maxChangedFiles}`,
			)
		}

		const policyViolations = await this.validateChangedPaths(
			task,
			worktreePath,
			changedFiles,
		)
		const patch = policyViolations.length === 0
			? await getBinaryPatch(worktreePath, baseCommit)
			: ''

		return { changedFiles, patch, policyViolations }
	}

	private async assertValidationPreservedCandidate(
		task: WorkerTask,
		worktreePath: string,
		baseCommit: string,
		expectedChangedFiles: Array<string>,
		expectedPatch: string,
	): Promise<void> {
		const currentHead = await resolveCommit(worktreePath, 'HEAD')

		if (currentHead !== baseCommit) {
			throw new HarnessError(
				'VALIDATION_CHANGED_HEAD',
				'Validation commands changed the worker worktree HEAD',
				{ expected: baseCommit, actual: currentHead },
			)
		}

		await assertSafeRepositoryConfiguration(worktreePath)
		const actual = await this.collectPatchCandidate(
			task,
			worktreePath,
			baseCommit,
		)

		if (actual.policyViolations.length > 0) {
			throw new HarnessError(
				'VALIDATION_CREATED_POLICY_VIOLATION',
				'Validation commands changed prohibited paths or file types',
				{ policyViolations: actual.policyViolations },
			)
		}

		if (
			!arraysEqual(expectedChangedFiles, actual.changedFiles) ||
			sha256(expectedPatch) !== sha256(actual.patch)
		) {
			throw new HarnessError(
				'VALIDATION_MUTATED_WORKTREE',
				'Validation commands changed tracked or untracked patch content',
				{
					expectedChangedFiles,
					actualChangedFiles: actual.changedFiles,
				},
			)
		}
	}

	private async validateChangedPaths(
		task: WorkerTask,
		worktreePath: string,
		changedFiles: Array<string>,
	): Promise<Array<string>> {
		const policy = new PathPolicy(
			worktreePath,
			task.allowedPaths,
			task.prohibitedPaths,
		)
		const policyViolations: Array<string> = []

		for (const changedFile of changedFiles) {
			try {
				await policy.assertSafeChangedPath(changedFile)
			} catch (error) {
				policyViolations.push(getErrorMessage(error))
			}
		}

		return policyViolations
	}

	private async getArtifactRoot(repositoryPath: string): Promise<string> {
		const artifactRoot = resolveArtifactRoot(repositoryPath, this.config)
		await assertArtifactRootOutsideRepository(repositoryPath, artifactRoot)
		return artifactRoot
	}

	private assertTaskContract(task: WorkerTask): void {
		if (task.allowedPaths.length === 0) {
			throw new HarnessError(
				'EMPTY_PATH_ALLOWLIST',
				'Worker tasks require at least one explicit allowed path pattern',
			)
		}

		if (
			(task.mode === 'research' || task.mode === 'review') &&
			task.requiredCommands.length > 0
		) {
			throw new HarnessError(
				'READ_ONLY_TASK',
				`${task.mode} tasks cannot execute validation commands`,
			)
		}

		const commandPolicy = new CommandPolicy(
			this.config.execution.allowedCommands,
		)

		for (const specification of task.requiredCommands) {
			commandPolicy.assertAllowed(specification)
		}

		if (
			task.requiredCommands.length > 0 &&
			this.config.execution.backend === 'docker' &&
			this.config.execution.requirePinnedDockerImage &&
			!isPinnedDockerImage(this.config.execution.dockerImage)
		) {
			throw new HarnessError(
				'UNPINNED_DOCKER_IMAGE',
				'Validation requires AGENT_HARNESS_DOCKER_IMAGE to use an immutable sha256 digest',
			)
		}

		if (
			task.requiredCommands.length > 0 &&
			this.config.execution.backend === 'local'
		) {
			if (!this.config.execution.allowUnsandboxedLocal) {
				throw new HarnessError(
					'LOCAL_EXECUTION_DISABLED',
					'Validation commands require Docker or explicit unsandboxed local execution.',
				)
			}

			if (!task.allowNetwork) {
				throw new HarnessError(
					'LOCAL_NETWORK_ISOLATION_UNAVAILABLE',
					'Local validation cannot enforce allowNetwork=false. Use Docker or explicitly allow network access for this trusted task.',
				)
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
		if (status !== 'completed') {
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

function classifyRunError(
	error: unknown,
	externalSignal: AbortSignal | undefined,
	timeoutSignal: AbortSignal,
): RunStatus {
	if (externalSignal?.aborted === true) {
		return 'cancelled'
	}

	if (timeoutSignal.aborted) {
		return 'timed_out'
	}

	if (error instanceof HarnessError && isPolicyCode(error.code)) {
		return 'policy_violation'
	}

	return 'failed'
}

function arraysEqual(left: Array<string>, right: Array<string>): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) {
		throw new DOMException('Worker delegation aborted', 'AbortError')
	}
}

function shouldFallback(
	report: WorkerRunReport,
	route: WorkerRoute,
	candidateIndex: number,
): boolean {
	return (
		route.fallbackEnabled &&
		candidateIndex + 1 < route.maxAttempts &&
		report.status === 'failed' &&
		isFallbackEligibleCode(report.failureCode ?? null)
	)
}

function isFallbackEligibleCode(code: string | null): boolean {
	return (
		code !== null &&
		(code.startsWith('PROVIDER_') ||
			code === 'WORKER_EMPTY_RESPONSE' ||
			code === 'WORKER_ITERATION_LIMIT')
	)
}

function getFailureCode(error: unknown): string {
	if (error instanceof HarnessError) {
		return error.code
	}
	if (error instanceof DOMException && error.name === 'AbortError') {
		return 'WORKER_ABORTED'
	}
	return 'WORKER_FAILED'
}


function isPinnedDockerImage(image: string): boolean {
	return (
		/@sha256:[a-f0-9]{64}$/i.test(image) ||
		/^sha256:[a-f0-9]{64}$/i.test(image)
	)
}

function getProviderUsage(provider: WorkerProvider): ProviderUsage {
	if (provider.getUsage !== undefined) {
		return provider.getUsage()
	}

	const requestCount = provider.getRequestCount?.() ?? 0
	return {
		requestCount,
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		totalLatencyMs: 0,
		estimatedCostUsd: null,
	}
}
