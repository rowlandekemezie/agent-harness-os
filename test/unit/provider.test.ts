import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import test from 'node:test'
import { loadConfig } from '../../src/config.js'
import type { ProviderRequest } from '../../src/domain/types.js'
import { Logger } from '../../src/lib/logger.js'
import { OpenAiCompatibleProvider } from '../../src/provider/openai-compatible.js'

type ProviderFixture = {
	baseUrl: string
	close(): Promise<void>
}

async function startProvider(
	respond: (response: ServerResponse) => void,
): Promise<ProviderFixture> {
	const server = createServer((request, response) => {
		request.resume()
		request.on('end', () => respond(response))
	})
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()

	if (address === null || typeof address === 'string') {
		throw new Error('Provider fixture did not bind to a TCP port')
	}

	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		close: async () => await new Promise<void>((resolve, reject) => {
			server.close(error => error === undefined ? resolve() : reject(error))
		}),
	}
}

function createRequest(): ProviderRequest {
	return {
		messages: [{ role: 'user', content: 'test' }],
		tools: [],
		signal: new AbortController().signal,
	}
}

function createProvider(baseUrl: string, overrides: NodeJS.ProcessEnv = {}): OpenAiCompatibleProvider {
	const config = loadConfig({
		QWEN_BASE_URL: baseUrl,
		QWEN_API_KEY: 'provider-api-secret',
		QWEN_MODEL: 'fake-worker',
		QWEN_MAX_RETRIES: '0',
		...overrides,
	})
	return new OpenAiCompatibleProvider(
		config.provider,
		new Logger('provider-test', 'error'),
	)
}

test('bounds provider response bodies before parsing', async function () {
	const fixture = await startProvider(response => {
		response.setHeader('content-type', 'application/json')
		response.end('x'.repeat(70_000))
	})

	try {
		const provider = createProvider(fixture.baseUrl, {
			QWEN_MAX_RESPONSE_BYTES: '65536',
		})
		await assert.rejects(provider.complete(createRequest()), error => {
			return (
				typeof error === 'object' &&
				error !== null &&
				'code' in error &&
				error.code === 'PROVIDER_RESPONSE_TOO_LARGE'
			)
		})
	} finally {
		await fixture.close()
	}
})

test('redacts custom provider header values from invalid-response evidence', async function () {
	const customSecret = 'custom-provider-secret'
	const fixture = await startProvider(response => {
		response.setHeader('content-type', 'application/json')
		response.end(`not-json ${customSecret}`)
	})

	try {
		const provider = createProvider(fixture.baseUrl, {
			QWEN_HEADERS_JSON: JSON.stringify({ 'x-provider-auth': customSecret }),
		})
		await assert.rejects(provider.complete(createRequest()), error => {
			if (
				typeof error !== 'object' ||
				error === null ||
				!('code' in error) ||
				error.code !== 'PROVIDER_INVALID_JSON' ||
				!('details' in error)
			) {
				return false
			}

			return JSON.stringify(error.details).includes(customSecret) === false
		})
	} finally {
		await fixture.close()
	}
})

test('rejects excessive tool-call fanout', async function () {
	const fixture = await startProvider(response => {
		response.setHeader('content-type', 'application/json')
		response.end(JSON.stringify({
			choices: [{
				message: {
					content: null,
					tool_calls: Array.from({ length: 33 }, (_, index) => ({
						id: `call-${index}`,
						type: 'function',
						function: { name: 'read_file', arguments: '{}' },
					})),
				},
			}],
		}))
	})

	try {
		const provider = createProvider(fixture.baseUrl)
		await assert.rejects(provider.complete(createRequest()), error => {
			return (
				typeof error === 'object' &&
				error !== null &&
				'code' in error &&
				error.code === 'PROVIDER_TOOL_CALL_LIMIT'
			)
		})
	} finally {
		await fixture.close()
	}
})
