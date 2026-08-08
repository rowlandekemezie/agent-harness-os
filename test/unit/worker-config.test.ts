import assert from 'node:assert/strict'
import test from 'node:test'
import {
	assertWorkersConfigured,
	getWorkerSecrets,
	loadConfig,
} from '../../src/config.js'

function hasCode(code: string): (error: unknown) => boolean {
	return error =>
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === code
}

test('loads a model-agnostic worker registry with environment-backed secrets', function () {
	const config = loadConfig({
		AGENT_OS_DEFAULT_WORKER: 'openai',
		AGENT_OS_ROUTING_STRATEGY: 'quality',
		OPENAI_API_KEY: 'openai-secret',
		ANTHROPIC_API_KEY: 'anthropic-secret',
		AGENT_OS_WORKERS_JSON: JSON.stringify([
			{
				id: 'openai',
				adapter: 'openai-compatible',
				model: 'gpt-worker',
				baseUrl: 'https://api.openai.com/v1',
				apiKeyEnv: 'OPENAI_API_KEY',
				capabilities: ['implementation', 'tool-calling'],
			},
			{
				id: 'anthropic',
				adapter: 'anthropic',
				model: 'claude-worker',
				baseUrl: 'https://api.anthropic.com/v1',
				apiKeyEnv: 'ANTHROPIC_API_KEY',
				capabilities: ['review', 'tool-calling'],
			},
		]),
	})

	assert.doesNotThrow(() => assertWorkersConfigured(config))
	assert.equal(config.routing.defaultWorkerId, 'openai')
	assert.equal(config.routing.defaultStrategy, 'quality')
	assert.equal(config.workers[1]?.auth, 'api-key')
	assert.deepEqual(getWorkerSecrets(config).namedSecrets, {
		OPENAI_API_KEY: 'openai-secret',
		ANTHROPIC_API_KEY: 'anthropic-secret',
	})
})

test('keeps legacy QWEN configuration operational', function () {
	const config = loadConfig({
		QWEN_BASE_URL: 'http://127.0.0.1:8080/v1',
		QWEN_API_KEY: 'qwen-secret',
		QWEN_MODEL: 'qwen-model',
	})
	assert.equal(config.workers[0]?.id, 'qwen')
	assert.equal(config.workers[0]?.model, 'qwen-model')
	assert.doesNotThrow(() => assertWorkersConfigured(config))
})

test('rejects duplicate workers and plaintext remote endpoints', function () {
	const duplicate = {
		id: 'same',
		adapter: 'openai-compatible',
		model: 'worker',
		baseUrl: 'http://127.0.0.1:8080/v1',
		auth: 'none',
		capabilities: ['implementation', 'tool-calling'],
	}
	assert.throws(
		() => loadConfig({
			AGENT_OS_WORKERS_JSON: JSON.stringify([duplicate, duplicate]),
		}),
		hasCode('INVALID_CONFIGURATION'),
	)
	assert.throws(
		() => loadConfig({
			API_KEY: 'secret',
			AGENT_OS_WORKERS_JSON: JSON.stringify([{
				...duplicate,
				id: 'remote',
				baseUrl: 'http://provider.example/v1',
				auth: 'bearer',
				apiKeyEnv: 'API_KEY',
			}]),
		}),
		hasCode('INSECURE_PROVIDER_URL'),
	)
})


test('rejects credentials embedded in worker URLs or static headers', function () {
	const baseWorker = {
		id: 'worker',
		adapter: 'openai-compatible',
		model: 'model',
		capabilities: ['implementation', 'tool-calling'],
		auth: 'none',
	}
	assert.throws(
		() => loadConfig({
			AGENT_OS_WORKERS_JSON: JSON.stringify([{
				...baseWorker,
				endpointUrl: 'https://provider.example/chat/completions?api_key=secret',
			}]),
		}),
		hasCode('INVALID_CONFIGURATION'),
	)
	assert.throws(
		() => loadConfig({
			AGENT_OS_WORKERS_JSON: JSON.stringify([{
				...baseWorker,
				baseUrl: 'https://provider.example/v1',
				headers: { Authorization: 'Bearer embedded-secret' },
			}]),
		}),
		hasCode('INVALID_CONFIGURATION'),
	)
})

test('marks workers unusable when environment-backed headers are missing', function () {
	const config = loadConfig({
		AGENT_OS_WORKERS_JSON: JSON.stringify([{
			id: 'gateway',
			adapter: 'openai-compatible',
			model: 'gateway-model',
			baseUrl: 'https://gateway.example/v1',
			auth: 'none',
			headerEnv: { 'x-tenant-token': 'TENANT_TOKEN' },
			capabilities: ['implementation', 'tool-calling'],
		}]),
	})

	assert.deepEqual(config.workers[0]?.configurationIssues, [
		'TENANT_TOKEN is missing',
	])
	assert.throws(
		() => assertWorkersConfigured(config),
		hasCode('WORKERS_NOT_CONFIGURED'),
	)
})

test('rejects uppercase worker IDs and oversized registry configuration', function () {
	assert.throws(
		() => loadConfig({
			AGENT_OS_WORKERS_JSON: JSON.stringify([{
				id: 'OpenAI',
				adapter: 'openai-compatible',
				model: 'model',
				baseUrl: 'https://provider.example/v1',
				auth: 'none',
				capabilities: ['implementation', 'tool-calling'],
			}]),
		}),
		hasCode('INVALID_CONFIGURATION'),
	)

	const oversizedWorker = {
		id: 'oversized',
		adapter: 'openai-compatible',
		model: 'model',
		baseUrl: 'https://provider.example/v1',
		auth: 'none',
		capabilities: ['implementation', 'tool-calling'],
		padding: 'x'.repeat(1_048_577),
	}
	assert.throws(
		() => loadConfig({
			AGENT_OS_WORKERS_JSON: JSON.stringify([oversizedWorker]),
		}),
		hasCode('INVALID_CONFIGURATION'),
	)
})

test('loads a ChatGPT-authenticated Codex CLI worker without API credentials', function () {
	const config = loadConfig({
		AGENT_OS_WORKERS_JSON: JSON.stringify([{
			id: 'codex-subscription',
			adapter: 'codex',
			capabilities: ['implementation', 'tool-calling', 'long-context'],
			command: '/opt/bin/codex',
			costTier: 'low',
		}]),
	})

	const worker = config.workers[0]
	assert.equal(worker?.adapter, 'codex')
	assert.equal(worker?.model, '')
	assert.equal(worker?.baseUrl, '')
	assert.equal(worker?.apiKeyEnv, null)
	assert.equal(worker?.apiKey, '')
	assert.equal(worker?.auth, 'none')
	assert.equal(worker?.codexCommand, '/opt/bin/codex')
	assert.equal(worker?.codexAuthMode, 'chatgpt')
	assert.deepEqual(getWorkerSecrets(config).namedSecrets, {})
	assert.doesNotThrow(() => assertWorkersConfigured(config))
})

test('rejects provider credentials and endpoints on Codex CLI workers', function () {
	const baseWorker = {
		id: 'codex-subscription',
		adapter: 'codex',
		capabilities: ['implementation', 'tool-calling'],
	}

	for (const invalid of [
		{ baseUrl: 'https://api.openai.com/v1' },
		{ apiKeyEnv: 'OPENAI_API_KEY' },
		{ headers: { Authorization: 'secret' } },
	]) {
		assert.throws(
			() => loadConfig({
				OPENAI_API_KEY: 'would-be-billed-separately',
				AGENT_OS_WORKERS_JSON: JSON.stringify([{
					...baseWorker,
					...invalid,
				}]),
			}),
			hasCode('INVALID_CONFIGURATION'),
		)
	}
})

test('requires explicit opt-in before allowing non-ChatGPT Codex authentication', function () {
	const config = loadConfig({
		AGENT_OS_WORKERS_JSON: JSON.stringify([{
			id: 'codex-any-auth',
			adapter: 'codex',
			authMode: 'any',
			capabilities: ['review', 'tool-calling'],
		}]),
	})

	assert.equal(config.workers[0]?.codexAuthMode, 'any')
	assert.throws(
		() => loadConfig({
			AGENT_OS_WORKERS_JSON: JSON.stringify([{
				id: 'codex-invalid-auth',
				adapter: 'codex',
				authMode: 'api-key',
				capabilities: ['review', 'tool-calling'],
			}]),
		}),
		hasCode('INVALID_CONFIGURATION'),
	)
})
