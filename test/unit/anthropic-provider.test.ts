import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { loadConfig } from '../../src/config.js'
import type { ProviderRequest } from '../../src/domain/types.js'
import { Logger } from '../../src/lib/logger.js'
import { AnthropicProvider } from '../../src/provider/anthropic.js'

test('maps the internal tool protocol to Anthropic Messages API blocks', async function () {
	let requestBody: Record<string, unknown> | null = null
	let requestHeaders: Record<string, string | string[] | undefined> = {}
	const server = createServer((request, response) => {
		const chunks: Array<Buffer> = []
		request.on('data', chunk => chunks.push(Buffer.from(chunk)))
		request.on('end', () => {
			requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
			requestHeaders = request.headers
			response.setHeader('content-type', 'application/json')
			response.end(JSON.stringify({
				content: [{
					type: 'tool_use',
					id: 'tool-1',
					name: 'read_file',
					input: { path: 'src/index.ts' },
				}],
				stop_reason: 'tool_use',
				usage: { input_tokens: 17, output_tokens: 9 },
			}))
		})
	})
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	assert.ok(address !== null && typeof address !== 'string')

	try {
		const config = loadConfig({
			ANTHROPIC_API_KEY: 'anthropic-secret',
			AGENT_OS_WORKERS_JSON: JSON.stringify([{
				id: 'claude',
				adapter: 'anthropic',
				model: 'claude-test',
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				apiKeyEnv: 'ANTHROPIC_API_KEY',
				capabilities: ['implementation', 'tool-calling'],
				maxRetries: 0,
			}]),
		})
		const provider = new AnthropicProvider(
			config.workers[0]!,
			new Logger('anthropic-test', 'error'),
		)
		const request: ProviderRequest = {
			messages: [
				{ role: 'system', content: 'Bounded worker.' },
				{ role: 'user', content: 'Inspect the file.' },
			],
			tools: [{
				type: 'function',
				function: {
					name: 'read_file',
					description: 'Read one file',
					parameters: { type: 'object', properties: { path: { type: 'string' } } },
				},
			}],
			signal: new AbortController().signal,
		}
		const completion = await provider.complete(request)

		assert.equal(requestHeaders['x-api-key'], 'anthropic-secret')
		assert.equal(requestHeaders['anthropic-version'], '2023-06-01')
		assert.equal(requestBody?.['system'], 'Bounded worker.')
		assert.equal(
			((requestBody?.['tools'] as Array<Record<string, unknown>>)[0]?.['input_schema'] as Record<string, unknown>)['type'],
			'object',
		)
		assert.equal(completion.toolCalls[0]?.function.name, 'read_file')
		assert.equal(completion.toolCalls[0]?.function.arguments, '{"path":"src/index.ts"}')
		assert.deepEqual(provider.getUsage(), {
			requestCount: 1,
			inputTokens: 17,
			outputTokens: 9,
			totalTokens: 26,
			totalLatencyMs: provider.getUsage().totalLatencyMs,
			estimatedCostUsd: null,
		})
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close(error => error === undefined ? resolve() : reject(error))
		})
	}
})
