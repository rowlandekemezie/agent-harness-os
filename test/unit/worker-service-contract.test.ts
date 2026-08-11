import assert from 'node:assert/strict'
import test from 'node:test'
import { loadConfig } from '../../src/config.js'
import { WorkerService } from '../../src/worker/service.js'
import type { Evaluator } from '../../src/evaluation/evaluator.js'

test('rejects an unpinned validation image before contacting the provider', async function () {
	const service = new WorkerService(loadConfig({
		QWEN_BASE_URL: 'http://127.0.0.1:1/v1',
		QWEN_API_KEY: 'test-api-key',
		QWEN_MODEL: 'fake-worker',
		AGENT_HARNESS_EXECUTION_BACKEND: 'docker',
		AGENT_HARNESS_DOCKER_IMAGE: 'node:22-bookworm-slim',
	}))

	await assert.rejects(
		service.delegate({
			objective: 'Validate a bounded task.',
			repositoryPath: '/path/that/should/not/be-resolved',
			mode: 'testing',
			allowedPaths: ['test/**'],
			prohibitedPaths: [],
			acceptanceCriteria: [],
			requiredCommands: [{ command: 'npm', args: ['test'] }],
			baseRef: 'HEAD',
			maxIterations: 1,
			timeoutSeconds: 30,
			allowNetwork: false,
		}),
		(error: unknown) =>
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'UNPINNED_DOCKER_IMAGE',
	)
})

test('bounds and deduplicates configured evaluators', function () {
	const config = loadConfig({
		QWEN_BASE_URL: 'http://127.0.0.1:1/v1',
		QWEN_API_KEY: 'test-api-key',
		QWEN_MODEL: 'fake-worker',
	})
	const evaluator: Evaluator = {
		id: 'deterministic-v1',
		async evaluate() {
			throw new Error('must not run')
		},
	}

	assert.throws(
		() => new WorkerService(config, { evaluators: [evaluator] }),
		(error: unknown) =>
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'EVALUATOR_ID_DUPLICATE',
	)
	assert.throws(
		() => new WorkerService(config, {
			evaluators: Array.from({ length: 8 }, (_, index) => ({
				...evaluator,
				id: `reviewer-${index}`,
			})),
		}),
		(error: unknown) =>
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'EVALUATOR_LIMIT',
	)
})
