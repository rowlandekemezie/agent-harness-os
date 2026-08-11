import assert from 'node:assert/strict'
import test from 'node:test'
import { loadConfig } from '../../src/config.js'
import type {
	RoutingEvidenceSnapshot,
	WorkerRoutingPolicy,
} from '../../src/domain/types.js'
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

function evidence(overrides: Partial<RoutingEvidenceSnapshot> = {}): RoutingEvidenceSnapshot {
	return {
		schemaVersion: 1,
		mode: 'implementation',
		taskLimit: 100,
		sampledTaskCount: 5,
		sampledAttemptCount: 40,
		sources: Array.from({ length: 5 }, (_, index) => ({
			taskId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
			latestEventSha256: String(index + 1).repeat(64),
		})),
		workers: [
			{
				workerId: 'qwen-fast',
				mode: 'implementation',
				sampleSize: 20,
				successCount: 0,
				evaluationCount: 20,
				evaluationPassCount: 0,
				patchProducedCount: 0,
				patchAppliedCount: 0,
				medianDurationMs: 30_000,
				averageProviderLatencyMs: 25_000,
				averageTotalTokens: 10_000,
				estimatedCostSampleCount: 20,
				averageEstimatedCostMicroUsd: 900_000,
			},
			{
				workerId: 'claude-quality',
				mode: 'implementation',
				sampleSize: 20,
				successCount: 20,
				evaluationCount: 20,
				evaluationPassCount: 20,
				patchProducedCount: 20,
				patchAppliedCount: 18,
				medianDurationMs: 5_000,
				averageProviderLatencyMs: 4_000,
				averageTotalTokens: 2_000,
				estimatedCostSampleCount: 20,
				averageEstimatedCostMicroUsd: 10_000,
			},
		],
		sha256: 'a'.repeat(64),
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

test('uses measured outcomes, latency, and cost without model-selected routing', function () {
	const config = createConfig()
	for (const strategy of ['balanced', 'cost', 'latency', 'quality'] as const) {
		const route = routeWorkers(
			config,
			'implementation',
			policy({ strategy }),
			evidence(),
		)
		assert.equal(route.candidates[0]?.worker.id, 'claude-quality')
		assert.match(route.candidates[0]?.reasons.at(-1) ?? '', /history 20/)
		assert.equal(route.evidence?.sampledAttemptCount, 40)
		assert.match(route.decisionSha256, /^[a-f0-9]{64}$/)
	}

	assert.throws(
		() => routeWorkers(
			config,
			'testing',
			policy(),
			evidence(),
		),
		(error: unknown) =>
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'ROUTING_EVIDENCE_MODE_MISMATCH',
	)
})

test('does not prefer a fully failed worker for being cheaper or faster', function () {
	const config = createConfig()
	const conflictingEvidence = evidence()
	const failed = conflictingEvidence.workers[0]!
	const reliable = conflictingEvidence.workers[1]!
	failed.medianDurationMs = 100
	failed.averageEstimatedCostMicroUsd = 100
	reliable.medianDurationMs = 30_000
	reliable.averageEstimatedCostMicroUsd = 900_000

	for (const strategy of ['cost', 'latency'] as const) {
		const route = routeWorkers(
			config,
			'implementation',
			policy({ strategy }),
			conflictingEvidence,
		)
		assert.equal(route.candidates[0]?.worker.id, 'claude-quality')
	}
})

test('treats an explicit preferred worker as a strict routing contract', function () {
	const config = createConfig()
	const route = routeWorkers(
		config,
		'implementation',
		policy({
			preferredWorkerId: 'qwen-fast',
			strategy: 'quality',
			maxAttempts: 2,
		}),
		evidence(),
	)
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
