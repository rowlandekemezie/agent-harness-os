import assert from 'node:assert/strict'
import test from 'node:test'
import { loadConfig } from '../../src/config.js'
import type { WorkerRoutingPolicy } from '../../src/domain/types.js'
import { routeWorkers } from '../../src/provider/router.js'

function createConfig() {
	return loadConfig({
		AGENT_OS_WORKERS_JSON: JSON.stringify([
			{
				id: 'qwen-fast',
				adapter: 'openai-compatible',
				model: 'qwen',
				baseUrl: 'http://127.0.0.1:11434/v1',
				auth: 'none',
				capabilities: ['implementation', 'testing', 'tool-calling'],
				priority: 40,
				costTier: 'low',
				latencyTier: 'fast',
			},
			{
				id: 'claude-quality',
				adapter: 'anthropic',
				model: 'claude',
				baseUrl: 'https://api.anthropic.com/v1',
				apiKeyEnv: 'ANTHROPIC_API_KEY',
				capabilities: ['implementation', 'testing', 'review', 'tool-calling', 'long-context'],
				priority: 90,
				costTier: 'high',
				latencyTier: 'standard',
			},
		]),
		ANTHROPIC_API_KEY: 'secret',
	})
}

function policy(overrides: Partial<WorkerRoutingPolicy> = {}): WorkerRoutingPolicy {
	return {
		preferredWorkerId: null,
		requiredCapabilities: [],
		strategy: 'balanced',
		maxCostTier: null,
		maxLatencyTier: null,
		allowFallback: true,
		maxAttempts: 3,
		...overrides,
	}
}

test('routes deterministically by declared cost, latency, and quality metadata', function () {
	const config = createConfig()
	assert.equal(
		routeWorkers(config, 'implementation', policy({ strategy: 'cost' }))
			.candidates[0]?.worker.id,
		'qwen-fast',
	)
	assert.equal(
		routeWorkers(config, 'implementation', policy({ strategy: 'latency' }))
			.candidates[0]?.worker.id,
		'qwen-fast',
	)
	assert.equal(
		routeWorkers(config, 'implementation', policy({ strategy: 'quality' }))
			.candidates[0]?.worker.id,
		'claude-quality',
	)
})

test('enforces capability and tier constraints before scoring', function () {
	const config = createConfig()
	const route = routeWorkers(config, 'review', policy({
		maxCostTier: 'high',
		requiredCapabilities: ['long-context'],
	}))
	assert.deepEqual(route.candidates.map(candidate => candidate.worker.id), [
		'claude-quality',
	])

	assert.throws(
		() => routeWorkers(config, 'review', policy({ maxCostTier: 'low' })),
		(error: unknown) =>
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'NO_WORKER_ROUTE',
	)
})

test('treats an explicit preferred worker as a strict routing contract', function () {
	const config = createConfig()
	const route = routeWorkers(config, 'implementation', policy({
		preferredWorkerId: 'qwen-fast',
		maxAttempts: 2,
	}))
	assert.equal(route.candidates[0]?.worker.id, 'qwen-fast')
	assert.equal(route.maxAttempts, 2)

	assert.throws(
		() => routeWorkers(config, 'review', policy({
			preferredWorkerId: 'qwen-fast',
		})),
		(error: unknown) =>
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'WORKER_DOES_NOT_SATISFY_ROUTE',
	)
})

test('redacts all endpoint query values from worker registry output', async function () {
	const { describeWorker } = await import('../../src/provider/router.js')
	const config = loadConfig({
		AGENT_OS_WORKERS_JSON: JSON.stringify([{
			id: 'azure',
			adapter: 'openai-compatible',
			model: 'deployment',
			endpointUrl: 'https://provider.example/chat/completions?api-version=2026-01-01',
			auth: 'none',
			capabilities: ['implementation', 'tool-calling'],
		}]),
	})
	const description = describeWorker(config.workers[0]!)
	assert.equal(
		description['baseUrl'],
		'https://provider.example/chat/completions?api-version=%5Bredacted%5D',
	)
})

test('routes only profiles whose declared role matches the task mode', function () {
	const config = loadConfig({
		AGENT_OS_WORKERS_JSON: JSON.stringify([{
			id: 'codex-subscription',
			adapter: 'codex',
			capabilities: [
				'implementation',
				'review',
				'tool-calling',
			],
		}]),
		AGENT_OS_WORKER_PROFILES_JSON: JSON.stringify([
			{
				id: 'codex-implementation',
				worker: 'codex-subscription',
				role: 'implementation',
				allowedCapabilities: [
					'implementation',
					'review',
					'tool-calling',
				],
			},
			{
				id: 'codex-review',
				worker: 'codex-subscription',
				role: 'review',
				allowedCapabilities: [
					'implementation',
					'review',
					'tool-calling',
				],
			},
		]),
	})

	assert.deepEqual(
		routeWorkers(config, 'implementation', policy()).candidates.map(
			candidate => candidate.worker.id,
		),
		['codex-implementation'],
	)
	assert.deepEqual(
		routeWorkers(config, 'review', policy()).candidates.map(
			candidate => candidate.worker.id,
		),
		['codex-review'],
	)
	assert.throws(
		() => routeWorkers(config, 'review', policy({
			preferredWorkerId: 'codex-implementation',
		})),
		(error: unknown) =>
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'WORKER_DOES_NOT_SATISFY_ROUTE',
	)
})
