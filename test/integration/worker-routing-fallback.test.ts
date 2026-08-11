import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadConfig } from '../../src/config.js'
import { WorkerService } from '../../src/worker/service.js'
import type {
	EvaluationInput,
	EvaluationResult,
} from '../../src/domain/types.js'
import type { Evaluator } from '../../src/evaluation/evaluator.js'
import { createTestRepository } from '../helpers/git.js'

type ProviderFixture = {
	baseUrl: string
	requestCount(): number
	close(): Promise<void>
}

async function startFailingProvider(): Promise<ProviderFixture> {
	let requests = 0
	const server = createServer((request, response) => {
		requests += 1
		request.resume()
		response.statusCode = 503
		response.setHeader('content-type', 'application/json')
		response.end(JSON.stringify({ error: 'temporarily unavailable' }))
	})
	return await listen(server, () => requests)
}

async function startSuccessfulProvider(): Promise<ProviderFixture> {
	let requests = 0
	const server = createServer((request, response) => {
		request.resume()
		request.on('end', () => {
			requests += 1
			response.setHeader('content-type', 'application/json')
			if (requests === 1) {
				response.end(JSON.stringify({
					choices: [{
						message: {
							content: null,
							tool_calls: [{
								id: 'write-success',
								type: 'function',
								function: {
									name: 'write_file',
									arguments: JSON.stringify({
										path: 'src/routed.ts',
										content: "export const routed = 'second-worker'\n",
									}),
								},
							}],
						},
					}],
				}))
				return
			}
			response.end(JSON.stringify({
				choices: [{ message: { content: 'Completed by fallback worker.' } }],
				usage: { prompt_tokens: 10, completion_tokens: 5 },
			}))
		})
	})
	return await listen(server, () => requests)
}

async function startLoopingProvider(): Promise<ProviderFixture> {
	let requests = 0
	const server = createServer((request, response) => {
		request.resume()
		request.on('end', () => {
			requests += 1
			response.setHeader('content-type', 'application/json')
			response.end(JSON.stringify({
				choices: [{
					message: {
						content: null,
						tool_calls: [{
							id: `read-${requests}`,
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
	return await listen(server, () => requests)
}

async function listen(
	server: Server,
	requestCount: () => number,
): Promise<ProviderFixture> {
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	if (address === null || typeof address === 'string') {
		throw new Error('Provider fixture did not bind')
	}
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		requestCount,
		close: async () => await new Promise<void>((resolve, reject) => {
			server.close(error => error === undefined ? resolve() : reject(error))
		}),
	}
}

test('falls back across workers using a fresh worktree and applies only the successful patch', async function () {
	const repositoryPath = await createTestRepository()
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-os-fallback-'))
	const failing = await startFailingProvider()
	const successful = await startSuccessfulProvider()

	try {
		const config = loadConfig({
			FIRST_API_KEY: 'first-secret',
			SECOND_API_KEY: 'second-secret',
			AGENT_HARNESS_ARTIFACT_ROOT: artifactRoot,
			AGENT_OS_WORKERS_JSON: JSON.stringify([
				{
					id: 'first',
					adapter: 'openai-compatible',
					model: 'first-model',
					baseUrl: failing.baseUrl,
					apiKeyEnv: 'FIRST_API_KEY',
					capabilities: ['implementation', 'tool-calling'],
					priority: 100,
					maxRetries: 0,
				},
				{
					id: 'second',
					adapter: 'openai-compatible',
					model: 'second-model',
					baseUrl: successful.baseUrl,
					apiKeyEnv: 'SECOND_API_KEY',
					capabilities: ['implementation', 'tool-calling'],
					priority: 50,
					maxRetries: 0,
				},
			]),
		})
		const service = new WorkerService(config)
		const report = await service.delegate({
			objective: 'Create the routed implementation.',
			repositoryPath,
			mode: 'implementation',
			allowedPaths: ['src/**'],
			prohibitedPaths: [],
			acceptanceCriteria: ['src/routed.ts is created'],
			requiredCommands: [],
			baseRef: 'HEAD',
			maxIterations: 4,
			timeoutSeconds: 60,
			allowNetwork: false,
			routing: {
				preferredWorkerId: 'first',
				requiredCapabilities: [],
				strategy: 'quality',
				maxCostTier: null,
				maxLatencyTier: null,
				allowFallback: true,
				maxAttempts: 2,
			},
		})

		assert.equal(report.status, 'completed')
		assert.equal(report.provider.workerId, 'second')
		assert.equal(report.routing?.attemptNumber, 2)
		assert.deepEqual(report.routing?.previousAttempts.map(attempt => ({
			workerId: attempt.workerId,
			status: attempt.status,
			failureCode: attempt.failureCode,
		})), [{
			workerId: 'first',
			status: 'failed',
			failureCode: 'PROVIDER_HTTP_ERROR',
		}])
		assert.equal(failing.requestCount(), 1)
		assert.equal(successful.requestCount(), 2)
		assert.deepEqual(report.changedFiles, ['src/routed.ts'])
		assert.ok(report.taskId)
		const timeline = await service.getTaskTimeline(
			repositoryPath,
			report.taskId,
		)
		assert.equal(
			timeline.events.filter(event => event.type === 'WorkerStarted').length,
			2,
		)
		assert.equal(
			timeline.events.filter(event => event.type === 'AttemptCompleted').length,
			2,
		)
		assert.deepEqual(timeline.task.workerIds, ['first', 'second'])
		assert.equal(timeline.task.status, 'completed')

		await service.applyRun(repositoryPath, report.runId)
		assert.equal(
			await readFile(path.join(repositoryPath, 'src/routed.ts'), 'utf8'),
			"export const routed = 'second-worker'\n",
		)
	} finally {
		await failing.close()
		await successful.close()
	}
})

test('does not fall back after a profile iteration cap', async function () {
	const repositoryPath = await createTestRepository()
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-os-profile-fallback-'))
	const looping = await startLoopingProvider()
	const successful = await startSuccessfulProvider()

	try {
		const config = loadConfig({
			AGENT_HARNESS_ARTIFACT_ROOT: artifactRoot,
			AGENT_OS_WORKERS_JSON: JSON.stringify([
				{
					id: 'looping-provider',
					adapter: 'openai-compatible',
					model: 'looping-model',
					baseUrl: looping.baseUrl,
					auth: 'none',
					capabilities: ['implementation', 'tool-calling'],
					priority: 100,
					maxRetries: 0,
				},
				{
					id: 'successful-provider',
					adapter: 'openai-compatible',
					model: 'successful-model',
					baseUrl: successful.baseUrl,
					auth: 'none',
					capabilities: ['implementation', 'tool-calling'],
					priority: 50,
					maxRetries: 0,
				},
			]),
			AGENT_OS_WORKER_PROFILES_JSON: JSON.stringify([
				{
					id: 'bounded-implementation',
					worker: 'looping-provider',
					role: 'implementation',
					maxIterations: 1,
					allowedCapabilities: ['implementation', 'tool-calling'],
				},
				{
					id: 'fallback-implementation',
					worker: 'successful-provider',
					role: 'implementation',
					maxIterations: 4,
					allowedCapabilities: ['implementation', 'tool-calling'],
				},
			]),
		})
		const report = await new WorkerService(config).delegate({
			objective: 'Create the routed implementation.',
			repositoryPath,
			mode: 'implementation',
			allowedPaths: ['README.md', 'src/**'],
			prohibitedPaths: [],
			acceptanceCriteria: [],
			requiredCommands: [],
			baseRef: 'HEAD',
			maxIterations: 8,
			timeoutSeconds: 60,
			allowNetwork: false,
		})

		assert.equal(looping.requestCount(), 1)
		assert.equal(successful.requestCount(), 0)
		assert.equal(report.status, 'policy_violation')
		assert.equal(report.failureCode, 'WORKER_ITERATION_LIMIT')
		assert.equal(report.provider.workerId, 'bounded-implementation')
		assert.equal(report.provider.profile?.backingWorkerId, 'looping-provider')
		assert.ok(report.routing)
		assert.deepEqual(report.routing.previousAttempts, [])
	} finally {
		await looping.close()
		await successful.close()
	}
})

async function startPolicyViolatingProvider(): Promise<ProviderFixture> {
	let requests = 0
	const server = createServer((request, response) => {
		request.resume()
		request.on('end', () => {
			requests += 1
			response.setHeader('content-type', 'application/json')
			if (requests === 1) {
				response.end(JSON.stringify({
					choices: [{
						message: {
							content: null,
							tool_calls: [{
								id: 'write-control-plane',
								type: 'function',
								function: {
									name: 'write_file',
									arguments: JSON.stringify({
										path: 'package.json',
										content: '{}\n',
									}),
								},
							}],
						},
					}],
				}))
				return
			}
			response.end(JSON.stringify({
				choices: [{ message: { content: 'Attempted the requested change.' } }],
			}))
		})
	})
	return await listen(server, () => requests)
}

test('does not fallback after a worker policy violation', async function () {
	const repositoryPath = await createTestRepository()
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-os-policy-'))
	const violating = await startPolicyViolatingProvider()
	const fallback = await startSuccessfulProvider()

	try {
		const config = loadConfig({
			FIRST_API_KEY: 'first-secret',
			SECOND_API_KEY: 'second-secret',
			AGENT_HARNESS_ARTIFACT_ROOT: artifactRoot,
			AGENT_OS_WORKERS_JSON: JSON.stringify([
				{
					id: 'first',
					adapter: 'openai-compatible',
					model: 'first-model',
					baseUrl: violating.baseUrl,
					apiKeyEnv: 'FIRST_API_KEY',
					capabilities: ['implementation', 'tool-calling'],
					priority: 100,
					maxRetries: 0,
				},
				{
					id: 'second',
					adapter: 'openai-compatible',
					model: 'second-model',
					baseUrl: fallback.baseUrl,
					apiKeyEnv: 'SECOND_API_KEY',
					capabilities: ['implementation', 'tool-calling'],
					priority: 50,
					maxRetries: 0,
				},
			]),
		})
		const report = await new WorkerService(config).delegate({
			objective: 'Modify repository control-plane configuration.',
			repositoryPath,
			mode: 'implementation',
			allowedPaths: ['**'],
			prohibitedPaths: [],
			acceptanceCriteria: ['package.json is changed'],
			requiredCommands: [],
			baseRef: 'HEAD',
			maxIterations: 4,
			timeoutSeconds: 60,
			allowNetwork: false,
			routing: {
				preferredWorkerId: 'first',
				requiredCapabilities: [],
				strategy: 'quality',
				maxCostTier: null,
				maxLatencyTier: null,
				allowFallback: true,
				maxAttempts: 2,
			},
		})

		assert.equal(report.status, 'policy_violation')
		assert.equal(report.provider.workerId, 'first')
		assert.equal(report.routing?.attemptNumber, 1)
		assert.equal(violating.requestCount(), 2)
		assert.equal(fallback.requestCount(), 0)
		assert.equal(report.patchPath, null)
	} finally {
		await violating.close()
		await fallback.close()
	}
})

test('does not fallback after an independent evaluation failure', async function () {
	const repositoryPath = await createTestRepository()
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-os-evaluation-'))
	const selected = await startSuccessfulProvider()
	const fallback = await startSuccessfulProvider()
	const reviewer: Evaluator = {
		id: 'failing-reviewer',
		async evaluate(input: EvaluationInput): Promise<EvaluationResult> {
			return {
				schemaVersion: 1,
				evaluatorId: this.id,
				evaluatorKind: 'model',
				evaluatedAt: new Date().toISOString(),
				outcome: 'failed',
				dimensions: [{
					id: 'correctness',
					status: 'failed',
					summary: 'Independent review rejected the patch',
					evidence: [`Run ${input.runId} requires repair`],
				}],
			}
		},
	}

	try {
		const config = loadConfig({
			FIRST_API_KEY: 'first-secret',
			SECOND_API_KEY: 'second-secret',
			AGENT_HARNESS_ARTIFACT_ROOT: artifactRoot,
			AGENT_OS_WORKERS_JSON: JSON.stringify([
				{
					id: 'first',
					adapter: 'openai-compatible',
					model: 'first-model',
					baseUrl: selected.baseUrl,
					apiKeyEnv: 'FIRST_API_KEY',
					capabilities: ['implementation', 'tool-calling'],
					priority: 100,
					maxRetries: 0,
				},
				{
					id: 'second',
					adapter: 'openai-compatible',
					model: 'second-model',
					baseUrl: fallback.baseUrl,
					apiKeyEnv: 'SECOND_API_KEY',
					capabilities: ['implementation', 'tool-calling'],
					priority: 50,
					maxRetries: 0,
				},
			]),
		})
		const report = await new WorkerService(config, {
			evaluators: [reviewer],
		}).delegate({
			objective: 'Create the routed implementation.',
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
			routing: {
				preferredWorkerId: 'first',
				requiredCapabilities: [],
				strategy: 'quality',
				maxCostTier: null,
				maxLatencyTier: null,
				allowFallback: true,
				maxAttempts: 2,
			},
		})

		assert.equal(report.status, 'failed')
		assert.equal(report.failureCode, 'EVALUATION_FAILED')
		assert.equal(report.routing?.attemptNumber, 1)
		assert.equal(selected.requestCount(), 2)
		assert.equal(fallback.requestCount(), 0)
	} finally {
		await selected.close()
		await fallback.close()
	}
})
