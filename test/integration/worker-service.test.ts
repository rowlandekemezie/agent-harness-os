import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { access, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadConfig } from '../../src/config.js'
import { TaskJournal } from '../../src/artifacts/task-journal.js'
import { WorkerService } from '../../src/worker/service.js'
import type {
	EvaluationInput,
	EvaluationResult,
} from '../../src/domain/types.js'
import type { Evaluator } from '../../src/evaluation/evaluator.js'
import { createTestRepository, runGit } from '../helpers/git.js'

async function startFakeProvider(
	paths: Array<string> = ['src/generated.ts'],
): Promise<{
	baseUrl: string
	requestCount(): number
	close(): Promise<void>
}> {
	let requestCount = 0
	const server = createServer((request, response) => {
		request.resume()
		request.on('end', () => {
			requestCount += 1
			response.setHeader('content-type', 'application/json')

			if (requestCount === 1) {
				response.end(JSON.stringify({
					choices: [{
						message: {
							role: 'assistant',
							content: null,
							tool_calls: paths.map((filePath, index) => ({
								id: `call-write-${index}`,
								type: 'function',
								function: {
									name: 'write_file',
									arguments: JSON.stringify({
										path: filePath,
										content: "export function generated(): string {\n\treturn 'ready'\n}\n",
									}),
								},
							})),
						},
					}],
				}))
				return
			}

			response.end(JSON.stringify({
				choices: [{
					message: {
						role: 'assistant',
						content: 'Completed the bounded implementation.',
					},
				}],
			}))
		})
	})

	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()

	if (address === null || typeof address === 'string') {
		throw new Error('Fake provider did not bind to a TCP port')
	}

	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		requestCount: () => requestCount,
		close: async () => await new Promise<void>((resolve, reject) => {
			server.close(error => error === undefined ? resolve() : reject(error))
		}),
	}
}

async function startLoopingProvider(): Promise<{
	baseUrl: string
	requestCount(): number
	close(): Promise<void>
}> {
	let requestCount = 0
	const server = createServer((request, response) => {
		request.resume()
		request.on('end', () => {
			requestCount += 1
			response.setHeader('content-type', 'application/json')
			response.end(JSON.stringify({
				choices: [{
					message: {
						role: 'assistant',
						content: null,
						tool_calls: [{
							id: `call-read-${requestCount}`,
							type: 'function',
							function: {
								name: 'read_file',
								arguments: JSON.stringify({ path: 'README.md' }),
							},
						}],
					},
				}],
			}))
		})
	})

	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	if (address === null || typeof address === 'string') {
		throw new Error('Looping provider did not bind to a TCP port')
	}
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		requestCount: () => requestCount,
		close: async () => await new Promise<void>((resolve, reject) => {
			server.close(error => error === undefined ? resolve() : reject(error))
		}),
	}
}

function createBlockingEvaluator(): {
	evaluator: Evaluator
	started: Promise<void>
	release(): void
} {
	let markStarted: (() => void) | undefined
	let release: (() => void) | undefined
	const started = new Promise<void>(resolve => {
		markStarted = resolve
	})
	const blocked = new Promise<void>(resolve => {
		release = resolve
	})
	return {
		evaluator: {
			id: 'blocking-reviewer',
			async evaluate(
				input: EvaluationInput,
				signal: AbortSignal,
			): Promise<EvaluationResult> {
				assert.equal(input.objective.length > 0, true)
				assert.equal(input.candidatePatch.includes('src/generated.ts'), true)
				assert.equal(Number.isFinite(input.deadlineMs), true)
				markStarted?.()
				await blocked
				signal.throwIfAborted()
				return {
					schemaVersion: 1,
					evaluatorId: this.id,
					evaluatorKind: 'model',
					evaluatedAt: new Date().toISOString(),
					outcome: 'passed',
					dimensions: [{
						id: 'correctness',
						status: 'passed',
						summary: 'Review completed',
						evidence: [`Reviewed ${input.baseCommit}`],
					}],
				}
			},
		},
		started,
		release: () => release?.(),
	}
}

function blockTaskEventPublication(
	service: WorkerService,
	eventType: Parameters<TaskJournal['append']>[2]['type'],
): {
	started: Promise<void>
	aborted: Promise<void>
	release(): void
} {
	const journal = (service as unknown as { taskJournal: TaskJournal }).taskJournal
	const originalAppend = journal.append.bind(journal)
	let markStarted: (() => void) | undefined
	let markAborted: (() => void) | undefined
	let release: (() => void) | undefined
	const started = new Promise<void>(resolve => {
		markStarted = resolve
	})
	const aborted = new Promise<void>(resolve => {
		markAborted = resolve
	})
	const blocked = new Promise<void>(resolve => {
		release = resolve
	})
	journal.append = async function (
		artifactRoot: string,
		taskId: string,
		input: Parameters<TaskJournal['append']>[2],
		signal?: AbortSignal,
	) {
		if (input.type === eventType) {
			markStarted?.()
			if (signal?.aborted === true) {
				markAborted?.()
			} else {
				signal?.addEventListener('abort', () => markAborted?.(), { once: true })
			}
			await blocked
		}
		return await originalAppend(artifactRoot, taskId, input, signal)
	}
	return {
		started,
		aborted,
		release: () => release?.(),
	}
}

function hasHarnessCode(code: string): (error: unknown) => boolean {
	return error => typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

test('delegates in a worktree, protects patch integrity, rejects stale bases, and applies separately', async function () {
	const repositoryPath = await createTestRepository()
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-artifacts-'))
	const provider = await startFakeProvider()

	try {
		const config = loadConfig({
			QWEN_BASE_URL: provider.baseUrl,
			QWEN_API_KEY: 'test-api-key-123456',
			QWEN_MODEL: 'fake-qwen',
			AGENT_HARNESS_ARTIFACT_ROOT: artifactRoot,
			AGENT_HARNESS_EXECUTION_BACKEND: 'local',
			AGENT_HARNESS_ALLOW_UNSANDBOXED_LOCAL: 'false',
		})
		const service = new WorkerService(config)
		const report = await service.delegate({
			objective: 'Create a generated TypeScript function.',
			repositoryPath,
			mode: 'implementation',
			allowedPaths: ['src/**'],
			prohibitedPaths: [],
			acceptanceCriteria: ['src/generated.ts exports generated'],
			requiredCommands: [],
			baseRef: 'HEAD',
			maxIterations: 4,
			timeoutSeconds: 60,
			allowNetwork: false,
		})

		assert.equal(report.status, 'completed')
		assert.equal(report.schemaVersion, 3)
		assert.equal(report.evaluation?.outcome, 'inconclusive')
		assert.ok(report.taskId)
		assert.deepEqual(report.changedFiles, ['src/generated.ts'])
		assert.ok(report.patchPath)
		const originalPatch = await readFile(report.patchPath, 'utf8')
		await writeFile(report.patchPath, `${originalPatch}\n# tampered\n`)
		await assert.rejects(
			service.applyRun(repositoryPath, report.runId),
			hasHarnessCode('PATCH_INTEGRITY_FAILED'),
		)
		await writeFile(report.patchPath, originalPatch)

		await writeFile(path.join(repositoryPath, 'NEXT.md'), 'new head\n')
		await runGit(repositoryPath, ['add', 'NEXT.md'])
		await runGit(repositoryPath, ['commit', '-m', 'Advance base'])
		await assert.rejects(
			service.applyRun(repositoryPath, report.runId),
			hasHarnessCode('BASE_COMMIT_CHANGED'),
		)
		await runGit(repositoryPath, ['reset', '--hard', 'HEAD^'])

		const application = await service.applyRun(repositoryPath, report.runId)
		assert.equal(application.applied, true)
		assert.equal(application.historyRecorded, true)
		assert.equal(
			await readFile(path.join(repositoryPath, 'src/generated.ts'), 'utf8'),
			"export function generated(): string {\n\treturn 'ready'\n}\n",
		)

		const timeline = await service.getTaskTimeline(
			repositoryPath,
			report.taskId,
		)
		assert.equal(timeline.task.status, 'completed')
		assert.equal(timeline.task.patchApplicationStatus, 'applied')
		assert.deepEqual(
			timeline.events.map(event => event.type),
			[
				'TaskCreated',
				'RouteSelected',
				'WorkerStarted',
				'ToolCalled',
				'WorkerCompleted',
				'PatchProduced',
				'ValidationCompleted',
				'EvaluationCompleted',
				'AttemptCompleted',
				'TaskCompleted',
				'PatchApplicationRequested',
				'PatchApplicationRejected',
				'PatchApplicationRequested',
				'PatchApplicationRejected',
				'PatchApplicationRequested',
				'PatchApproved',
				'PatchApplied',
			],
		)
	} finally {
		await provider.close()
	}
})

test('enforces profile iteration and strict-evaluation bounds', async function () {
	const iterationRepository = await createTestRepository()
	const strictRepository = await createTestRepository()
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-profiles-'))
	const loopingProvider = await startLoopingProvider()
	const successfulProvider = await startFakeProvider()

	try {
		const iterationConfig = loadConfig({
			QWEN_BASE_URL: loopingProvider.baseUrl,
			QWEN_API_KEY: 'profile-test-key',
			QWEN_MODEL: 'profile-test-model',
			AGENT_HARNESS_ARTIFACT_ROOT: artifactRoot,
			AGENT_OS_WORKER_PROFILES_JSON: JSON.stringify([{
				id: 'qwen-bounded-implementation',
				worker: 'qwen',
				role: 'implementation',
				maxIterations: 1,
				allowedCapabilities: ['implementation', 'tool-calling'],
			}]),
		})
		const iterationReport = await new WorkerService(iterationConfig).delegate({
			objective: 'Inspect the repository before implementing.',
			repositoryPath: iterationRepository,
			mode: 'implementation',
			allowedPaths: ['README.md'],
			prohibitedPaths: [],
			acceptanceCriteria: [],
			requiredCommands: [],
			baseRef: 'HEAD',
			maxIterations: 8,
			timeoutSeconds: 60,
			allowNetwork: false,
		})

		assert.equal(loopingProvider.requestCount(), 1)
		assert.equal(iterationReport.status, 'failed')
		assert.equal(iterationReport.failureCode, 'WORKER_ITERATION_LIMIT')
		assert.deepEqual(iterationReport.provider.profile, {
			backingWorkerId: 'qwen',
			role: 'implementation',
			maxIterations: 1,
			evaluationPolicy: 'default',
		})

		const strictConfig = loadConfig({
			QWEN_BASE_URL: successfulProvider.baseUrl,
			QWEN_API_KEY: 'profile-test-key',
			QWEN_MODEL: 'profile-test-model',
			AGENT_HARNESS_ARTIFACT_ROOT: artifactRoot,
			AGENT_OS_WORKER_PROFILES_JSON: JSON.stringify([{
				id: 'qwen-strict-implementation',
				worker: 'qwen',
				role: 'implementation',
				maxIterations: 4,
				allowedCapabilities: ['implementation', 'tool-calling'],
				evaluationPolicy: 'strict',
			}]),
		})
		const strictReport = await new WorkerService(strictConfig).delegate({
			objective: 'Create a generated TypeScript function.',
			repositoryPath: strictRepository,
			mode: 'implementation',
			allowedPaths: ['src/**'],
			prohibitedPaths: [],
			acceptanceCriteria: ['src/generated.ts exports generated'],
			requiredCommands: [],
			baseRef: 'HEAD',
			maxIterations: 8,
			timeoutSeconds: 60,
			allowNetwork: false,
		})

		assert.equal(strictReport.evaluation?.outcome, 'inconclusive')
		assert.equal(strictReport.status, 'failed')
		assert.equal(strictReport.failureCode, 'EVALUATION_INCONCLUSIVE')
		assert.ok(strictReport.patchPath)
		assert.ok(strictReport.taskId)
		const strictTimeline = await new WorkerService(strictConfig)
			.getTaskTimeline(strictRepository, strictReport.taskId)
		const strictEvaluation = strictTimeline.events.find(
			event => event.type === 'EvaluationCompleted',
		)
		assert.equal(
			strictEvaluation?.type === 'EvaluationCompleted'
				? strictEvaluation.data.evaluationPolicy
				: null,
			'strict',
		)
	} finally {
		await loopingProvider.close()
		await successfulProvider.close()
	}
})

test('binds independent-review evidence and rejects report schema downgrades', async function () {
	const repositoryPath = await createTestRepository()
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-reviewer-'))
	const provider = await startFakeProvider()
	const reviewer: Evaluator = {
		id: 'independent-reviewer',
		async evaluate(input: EvaluationInput): Promise<EvaluationResult> {
			return {
				schemaVersion: 1,
				evaluatorId: this.id,
				evaluatorKind: 'model',
				evaluatedAt: new Date().toISOString(),
				outcome: 'failed',
				dimensions: [
					{
						id: 'correctness',
						status: 'failed',
						summary: 'Independent review found a defect',
						evidence: [`Reviewed harness run ${input.runId}`],
					},
					{
						id: 'patch_size',
						status: 'failed',
						summary: 'Untrusted reviewer disputed patch size',
						evidence: ['Model claims cannot control patch retention.'],
					},
				],
			}
		},
	}

	try {
		const config = loadConfig({
			QWEN_BASE_URL: provider.baseUrl,
			QWEN_API_KEY: 'test-api-key-123456',
			QWEN_MODEL: 'fake-qwen',
			AGENT_HARNESS_ARTIFACT_ROOT: artifactRoot,
			AGENT_HARNESS_EXECUTION_BACKEND: 'local',
			AGENT_HARNESS_ALLOW_UNSANDBOXED_LOCAL: 'false',
		})
		const service = new WorkerService(config, { evaluators: [reviewer] })
		const report = await service.delegate({
			objective: 'Create a generated TypeScript function.',
			repositoryPath,
			mode: 'implementation',
			allowedPaths: ['src/**'],
			prohibitedPaths: [],
			acceptanceCriteria: [],
			requiredCommands: [],
			baseRef: 'HEAD',
			maxIterations: 4,
			timeoutSeconds: 60,
			allowNetwork: false,
		})

		assert.equal(report.status, 'failed')
		assert.equal(report.failureCode, 'EVALUATION_FAILED')
		assert.equal(report.evaluation?.outcome, 'failed')
		assert.deepEqual(
			report.evaluation?.results.map(result => result.evaluatorId),
			['deterministic-v1', 'independent-reviewer'],
		)
		assert.ok(report.patchPath)
		await assert.rejects(
			service.applyRun(repositoryPath, report.runId),
			hasHarnessCode('RUN_NOT_APPLICABLE'),
		)
		const tampered = JSON.parse(await readFile(report.reportPath, 'utf8')) as {
			status: string
			failureCode: string | null
			evaluation: {
				outcome: string
				results: Array<{ evaluatorId: string }>
			}
		}
		tampered.status = 'completed'
		tampered.failureCode = null
		tampered.evaluation.outcome = 'passed'
		tampered.evaluation.results = tampered.evaluation.results.filter(
			result => result.evaluatorId === 'deterministic-v1',
		)
		await writeFile(report.reportPath, `${JSON.stringify(tampered)}\n`)
		await assert.rejects(
			service.applyRun(repositoryPath, report.runId),
			hasHarnessCode('EVALUATION_HISTORY_MISMATCH'),
		)
		const downgraded = tampered as unknown as Record<string, unknown>
		downgraded['schemaVersion'] = 2
		delete downgraded['evaluation']
		await writeFile(report.reportPath, `${JSON.stringify(downgraded)}\n`)
		await assert.rejects(
			service.applyRun(repositoryPath, report.runId),
			hasHarnessCode('LEGACY_RUN_NOT_APPLICABLE'),
		)
		downgraded['schemaVersion'] = 1
		delete downgraded['taskId']
		await writeFile(report.reportPath, `${JSON.stringify(downgraded)}\n`)
		await assert.rejects(
			service.applyRun(repositoryPath, report.runId),
			hasHarnessCode('LEGACY_RUN_NOT_APPLICABLE'),
		)
		assert.ok(report.taskId)
		const timeline = await service.getTaskTimeline(repositoryPath, report.taskId)
		const event = timeline.events.find(candidate =>
			candidate.type === 'EvaluationCompleted'
		)
		assert.deepEqual(
			event?.type === 'EvaluationCompleted' ? event.data.evaluatorIds : [],
			['deterministic-v1', 'independent-reviewer'],
		)
	} finally {
		await provider.close()
	}
})

test('records changed-file limits as evaluation evidence and prevents patch persistence', async function () {
	const repositoryPath = await createTestRepository()
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-scope-limit-'))
	const provider = await startFakeProvider([
		'src/generated.ts',
		'src/extra.ts',
	])

	try {
		const config = loadConfig({
			QWEN_BASE_URL: provider.baseUrl,
			QWEN_API_KEY: 'test-api-key-123456',
			QWEN_MODEL: 'fake-qwen',
			AGENT_HARNESS_ARTIFACT_ROOT: artifactRoot,
			AGENT_HARNESS_EXECUTION_BACKEND: 'local',
			AGENT_HARNESS_ALLOW_UNSANDBOXED_LOCAL: 'false',
			AGENT_HARNESS_MAX_CHANGED_FILES: '1',
		})
		const service = new WorkerService(config)
		const report = await service.delegate({
			objective: 'Create two generated TypeScript files.',
			repositoryPath,
			mode: 'implementation',
			allowedPaths: ['src/**'],
			prohibitedPaths: [],
			acceptanceCriteria: [],
			requiredCommands: [],
			baseRef: 'HEAD',
			maxIterations: 4,
			timeoutSeconds: 60,
			allowNetwork: false,
		})

		assert.equal(report.status, 'policy_violation')
		assert.equal(report.failureCode, 'WORKER_POLICY_VIOLATION')
		assert.deepEqual(report.changedFiles, ['src/extra.ts', 'src/generated.ts'])
		assert.equal(report.patchPath, null)
		assert.ok(report.policyViolations.some(violation =>
			violation.startsWith('CHANGED_FILE_LIMIT:'),
		))
		const deterministic = report.evaluation?.results.find(result =>
			result.evaluatorId === 'deterministic-v1'
		)
		assert.equal(
			deterministic?.dimensions.find(dimension =>
				dimension.id === 'changed_files_scope'
			)?.status,
			'failed',
		)
		await assert.rejects(
			service.applyRun(repositoryPath, report.runId),
			hasHarnessCode('RUN_NOT_APPLICABLE'),
		)
	} finally {
		await provider.close()
	}
})

test('cancels a blocked evaluator without returning an applicable run', async function () {
	const repositoryPath = await createTestRepository()
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-evaluator-cancel-'))
	const provider = await startFakeProvider()
	const blocking = createBlockingEvaluator()

	try {
		const config = loadConfig({
			QWEN_BASE_URL: provider.baseUrl,
			QWEN_API_KEY: 'test-api-key-123456',
			QWEN_MODEL: 'fake-qwen',
			AGENT_HARNESS_ARTIFACT_ROOT: artifactRoot,
		})
		const service = new WorkerService(config, {
			evaluators: [blocking.evaluator],
		})
		const controller = new AbortController()
		const operation = service.delegate({
			objective: 'Create a generated TypeScript function.',
			repositoryPath,
			mode: 'implementation',
			allowedPaths: ['src/**'],
			prohibitedPaths: [],
			acceptanceCriteria: [],
			requiredCommands: [],
			baseRef: 'HEAD',
			maxIterations: 4,
			timeoutSeconds: 60,
			allowNetwork: false,
		}, controller.signal)

		await blocking.started
		controller.abort()
		const report = await operation
		blocking.release()

		assert.equal(report.status, 'cancelled')
		assert.equal(report.failureCode, 'WORKER_ABORTED')
		assert.equal(report.evaluation?.results.length, 1)
		await assert.rejects(
			service.applyRun(repositoryPath, report.runId),
			hasHarnessCode('RUN_NOT_APPLICABLE'),
		)
	} finally {
		blocking.release()
		await provider.close()
	}
})

test('times out a blocked evaluator and releases the attempt', async function () {
	const repositoryPath = await createTestRepository()
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-evaluator-timeout-'))
	const provider = await startFakeProvider()
	const blocking = createBlockingEvaluator()

	try {
		const config = loadConfig({
			QWEN_BASE_URL: provider.baseUrl,
			QWEN_API_KEY: 'test-api-key-123456',
			QWEN_MODEL: 'fake-qwen',
			AGENT_HARNESS_ARTIFACT_ROOT: artifactRoot,
		})
		const service = new WorkerService(config, {
			evaluators: [blocking.evaluator],
		})
		const operation = service.delegate({
			objective: 'Create a generated TypeScript function.',
			repositoryPath,
			mode: 'implementation',
			allowedPaths: ['src/**'],
			prohibitedPaths: [],
			acceptanceCriteria: [],
			requiredCommands: [],
			baseRef: 'HEAD',
			maxIterations: 4,
			timeoutSeconds: 1,
			allowNetwork: false,
		})

		await blocking.started
		const report = await operation
		blocking.release()

		assert.equal(report.status, 'timed_out')
		assert.equal(report.failureCode, 'WORKER_ABORTED')
		assert.equal(report.evaluation?.results.length, 1)
	} finally {
		blocking.release()
		await provider.close()
	}
})

test('cancels while evaluation history publication is pending', async function () {
	const repositoryPath = await createTestRepository()
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-publication-cancel-'))
	const provider = await startFakeProvider()
	let publication: ReturnType<typeof blockTaskEventPublication> | null = null

	try {
		const config = loadConfig({
			QWEN_BASE_URL: provider.baseUrl,
			QWEN_API_KEY: 'test-api-key-123456',
			QWEN_MODEL: 'fake-qwen',
			AGENT_HARNESS_ARTIFACT_ROOT: artifactRoot,
		})
		const service = new WorkerService(config)
		publication = blockTaskEventPublication(service, 'EvaluationCompleted')
		const controller = new AbortController()
		const operation = service.delegate({
			objective: 'Create a generated TypeScript function.',
			repositoryPath,
			mode: 'implementation',
			allowedPaths: ['src/**'],
			prohibitedPaths: [],
			acceptanceCriteria: [],
			requiredCommands: [],
			baseRef: 'HEAD',
			maxIterations: 4,
			timeoutSeconds: 60,
			allowNetwork: false,
		}, controller.signal)

		await publication.started
		controller.abort()
		await publication.aborted
		publication.release()
		await assert.rejects(
			operation,
			(error: unknown) => error instanceof DOMException && error.name === 'AbortError',
		)
		const [repositoryDirectory] = await readdir(artifactRoot)
		assert.ok(repositoryDirectory)
		const effectiveRoot = path.join(artifactRoot, repositoryDirectory)
		const taskIds = await readdir(path.join(effectiveRoot, 'tasks'))
		assert.equal(taskIds.length, 1)
		const timeline = await new TaskJournal().timeline(effectiveRoot, taskIds[0]!)
		assert.equal(
			timeline.events.some(event => event.type === 'EvaluationCompleted'),
			false,
		)
		assert.equal(
			(await readdir(effectiveRoot)).some(entry => /^[0-9a-f-]{36}$/i.test(entry)),
			false,
		)
	} finally {
		publication?.release()
		await provider.close()
	}
})

test('keeps the deadline active through evaluation history publication', async function () {
	const repositoryPath = await createTestRepository()
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-publication-timeout-'))
	const provider = await startFakeProvider()
	let publication: ReturnType<typeof blockTaskEventPublication> | null = null

	try {
		const config = loadConfig({
			QWEN_BASE_URL: provider.baseUrl,
			QWEN_API_KEY: 'test-api-key-123456',
			QWEN_MODEL: 'fake-qwen',
			AGENT_HARNESS_ARTIFACT_ROOT: artifactRoot,
		})
		const service = new WorkerService(config)
		publication = blockTaskEventPublication(service, 'EvaluationCompleted')
		const operation = service.delegate({
			objective: 'Create a generated TypeScript function.',
			repositoryPath,
			mode: 'implementation',
			allowedPaths: ['src/**'],
			prohibitedPaths: [],
			acceptanceCriteria: [],
			requiredCommands: [],
			baseRef: 'HEAD',
			maxIterations: 4,
			timeoutSeconds: 1,
			allowNetwork: false,
		})

		await publication.started
		await publication.aborted
		publication.release()
		await assert.rejects(
			operation,
			(error: unknown) => error instanceof DOMException && error.name === 'AbortError',
		)
		const [repositoryDirectory] = await readdir(artifactRoot)
		assert.ok(repositoryDirectory)
		const rootEntries = await readdir(path.join(artifactRoot, repositoryDirectory))
		assert.equal(rootEntries.some(entry => /^[0-9a-f-]{36}$/i.test(entry)), false)
	} finally {
		publication?.release()
		await provider.close()
	}
})

test('cancellation wins before the task completion commit', async function () {
	const repositoryPath = await createTestRepository()
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-completion-cancel-'))
	const provider = await startFakeProvider()
	let publication: ReturnType<typeof blockTaskEventPublication> | null = null

	try {
		const config = loadConfig({
			QWEN_BASE_URL: provider.baseUrl,
			QWEN_API_KEY: 'test-api-key-123456',
			QWEN_MODEL: 'fake-qwen',
			AGENT_HARNESS_ARTIFACT_ROOT: artifactRoot,
		})
		const service = new WorkerService(config)
		publication = blockTaskEventPublication(service, 'TaskCompleted')
		const controller = new AbortController()
		const operation = service.delegate({
			objective: 'Create a generated TypeScript function.',
			repositoryPath,
			mode: 'implementation',
			allowedPaths: ['src/**'],
			prohibitedPaths: [],
			acceptanceCriteria: [],
			requiredCommands: [],
			baseRef: 'HEAD',
			maxIterations: 4,
			timeoutSeconds: 60,
			allowNetwork: false,
		}, controller.signal)

		await publication.started
		controller.abort()
		await publication.aborted
		publication.release()
		await assert.rejects(
			operation,
			(error: unknown) => error instanceof DOMException && error.name === 'AbortError',
		)
		const [repositoryDirectory] = await readdir(artifactRoot)
		assert.ok(repositoryDirectory)
		const effectiveRoot = path.join(artifactRoot, repositoryDirectory)
		const [taskId] = await readdir(path.join(effectiveRoot, 'tasks'))
		assert.ok(taskId)
		const timeline = await new TaskJournal().timeline(effectiveRoot, taskId)
		assert.equal(timeline.events.some(event => event.type === 'TaskCompleted'), false)
		const started = timeline.events.find(event => event.type === 'WorkerStarted')
		assert.equal(started?.type, 'WorkerStarted')
		if (started?.type !== 'WorkerStarted') {
			throw new Error('Worker run was not recorded')
		}
		await assert.rejects(
			service.applyRun(repositoryPath, started.data.runId),
			hasHarnessCode('EVALUATION_HISTORY_MISMATCH'),
		)
	} finally {
		publication?.release()
		await provider.close()
	}
})

test('invalidates a run when deterministic validation mutates the worker patch', async function () {
	const repositoryPath = await createTestRepository()
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-validation-artifacts-'))
	const provider = await startFakeProvider()

	try {
		const config = loadConfig({
			QWEN_BASE_URL: provider.baseUrl,
			QWEN_API_KEY: 'test-api-key-123456',
			QWEN_MODEL: 'fake-qwen',
			AGENT_HARNESS_ARTIFACT_ROOT: artifactRoot,
			AGENT_HARNESS_EXECUTION_BACKEND: 'local',
			AGENT_HARNESS_ALLOW_UNSANDBOXED_LOCAL: 'true',
			AGENT_HARNESS_ALLOWED_COMMANDS: 'node',
		})
		const service = new WorkerService(config)
		const report = await service.delegate({
			objective: 'Create a generated TypeScript function.',
			repositoryPath,
			mode: 'implementation',
			allowedPaths: ['src/**'],
			prohibitedPaths: [],
			acceptanceCriteria: ['src/generated.ts exports generated'],
			requiredCommands: [
				{
					command: 'node',
					args: [
						'-e',
						"require('node:fs').appendFileSync('src/generated.ts', '// validation mutation\\n')",
					],
				},
			],
			baseRef: 'HEAD',
			maxIterations: 4,
			timeoutSeconds: 60,
			allowNetwork: true,
		})

		assert.equal(report.status, 'failed')
		assert.ok(
			report.warnings.some(warning =>
				warning.includes('Validation integrity check failed'),
			),
		)
		assert.ok(report.patchPath)
		const patch = await readFile(report.patchPath, 'utf8')
		assert.equal(patch.includes('validation mutation'), false)
		await assert.rejects(
			service.applyRun(repositoryPath, report.runId),
			hasHarnessCode('RUN_NOT_APPLICABLE'),
		)
	} finally {
		await provider.close()
	}
})

test('rejects a version 3 run when evaluation history is corrupt', async function () {
	const repositoryPath = await createTestRepository()
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-history-corrupt-'))
	const provider = await startFakeProvider()

	try {
		const config = loadConfig({
			QWEN_BASE_URL: provider.baseUrl,
			QWEN_API_KEY: 'test-api-key-123456',
			QWEN_MODEL: 'fake-qwen',
			AGENT_HARNESS_ARTIFACT_ROOT: artifactRoot,
			AGENT_HARNESS_EXECUTION_BACKEND: 'local',
			AGENT_HARNESS_ALLOW_UNSANDBOXED_LOCAL: 'false',
		})
		const service = new WorkerService(config)
		const report = await service.delegate({
			objective: 'Create a generated TypeScript function.',
			repositoryPath,
			mode: 'implementation',
			allowedPaths: ['src/**'],
			prohibitedPaths: [],
			acceptanceCriteria: [],
			requiredCommands: [],
			baseRef: 'HEAD',
			maxIterations: 4,
			timeoutSeconds: 60,
			allowNetwork: false,
		})
		assert.ok(report.taskId)
		const effectiveRoot = path.dirname(path.dirname(report.reportPath))
		const eventDirectory = path.join(
			effectiveRoot,
			'tasks',
			report.taskId,
			'events',
		)
		const firstEvent = (await readdir(eventDirectory)).sort()[0]
		assert.ok(firstEvent)
		await writeFile(path.join(eventDirectory, firstEvent), '{corrupt\n')

		await assert.rejects(
			service.applyRun(repositoryPath, report.runId),
			hasHarnessCode('EVALUATION_HISTORY_INVALID'),
		)
		await assert.rejects(access(path.join(repositoryPath, 'src/generated.ts')))
	} finally {
		await provider.close()
	}
})

test('rejects a version 3 report attached to another task journal', async function () {
	const repositoryPath = await createTestRepository()
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-history-link-'))
	const provider = await startFakeProvider()

	try {
		const config = loadConfig({
			QWEN_BASE_URL: provider.baseUrl,
			QWEN_API_KEY: 'test-api-key-123456',
			QWEN_MODEL: 'fake-qwen',
			AGENT_HARNESS_ARTIFACT_ROOT: artifactRoot,
			AGENT_HARNESS_EXECUTION_BACKEND: 'local',
			AGENT_HARNESS_ALLOW_UNSANDBOXED_LOCAL: 'false',
		})
		const service = new WorkerService(config)
		const report = await service.delegate({
			objective: 'Create a generated TypeScript function.',
			repositoryPath,
			mode: 'implementation',
			allowedPaths: ['src/**'],
			prohibitedPaths: [],
			acceptanceCriteria: [],
			requiredCommands: [],
			baseRef: 'HEAD',
			maxIterations: 4,
			timeoutSeconds: 60,
			allowNetwork: false,
		})
		const effectiveRoot = path.dirname(path.dirname(report.reportPath))
		const journal = new TaskJournal()
		const unrelated = await journal.create({
			artifactRoot: effectiveRoot,
			objective: 'Unrelated task',
			mode: 'review',
			repositoryPath,
			baseCommit: report.baseRef,
		})
		const storedReport = JSON.parse(
			await readFile(report.reportPath, 'utf8'),
		) as { taskId: string }
		storedReport.taskId = unrelated.taskId
		await writeFile(report.reportPath, `${JSON.stringify(storedReport)}\n`)

		await assert.rejects(
			service.applyRun(repositoryPath, report.runId),
			hasHarnessCode('EVALUATION_HISTORY_MISMATCH'),
		)
		await assert.rejects(access(path.join(repositoryPath, 'src/generated.ts')))
		const unrelatedTimeline = await journal.timeline(
			effectiveRoot,
			unrelated.taskId,
		)
		assert.deepEqual(
			unrelatedTimeline.events.map(event => event.type),
			['TaskCreated'],
		)
	} finally {
		await provider.close()
	}
})
