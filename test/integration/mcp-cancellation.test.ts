import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { createTestRepository } from '../helpers/git.js'

test('handles MCP cancellation while a worker tool call is in flight', async function () {
	let markRequestStarted: (() => void) | undefined
	const requestStarted = new Promise<void>(resolve => {
		markRequestStarted = resolve
	})
	const provider = createServer(request => {
		request.resume()
		request.on('end', () => markRequestStarted?.())
	})
	await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
	const address = provider.address()

	if (address === null || typeof address === 'string') {
		throw new Error('Provider fixture did not bind to a TCP port')
	}

	const repositoryPath = await createTestRepository()
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-mcp-cancel-'))
	const cliPath = path.resolve('dist/src/cli.js')
	const child = spawn(process.execPath, [cliPath, 'mcp'], {
		cwd: process.cwd(),
		stdio: ['pipe', 'pipe', 'pipe'],
		env: {
			...process.env,
			QWEN_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			QWEN_API_KEY: 'test-api-key',
			QWEN_MODEL: 'fake-worker',
			QWEN_MAX_RETRIES: '0',
			QWEN_TIMEOUT_MS: '60000',
			AGENT_HARNESS_ARTIFACT_ROOT: artifactRoot,
			AGENT_HARNESS_LOG_LEVEL: 'error',
		},
	})
	if (child.stdin === null) {
		throw new Error('MCP child stdin is unavailable')
	}

	const childInput = child.stdin
	const output = createInterface({ input: child.stdout })
	const messages: Array<Record<string, unknown>> = []
	output.on('line', line => messages.push(JSON.parse(line) as Record<string, unknown>))

	try {
		writeMessage(childInput, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-11-25',
				capabilities: {},
				clientInfo: { name: 'test', version: '1' },
			},
		})
		await waitForResponse(messages, 1)
		writeMessage(childInput, {
			jsonrpc: '2.0',
			method: 'notifications/initialized',
		})
		writeMessage(childInput, {
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/call',
			params: {
				name: 'delegate_to_worker',
				arguments: {
					objective: 'Wait until this request is cancelled.',
					repositoryPath,
					mode: 'research',
					allowedPaths: ['**/*'],
					timeoutSeconds: 60,
				},
			},
		})
		await requestStarted
		writeMessage(childInput, {
			jsonrpc: '2.0',
			method: 'notifications/cancelled',
			params: { requestId: 2, reason: 'test cancellation' },
		})

		const response = await waitForResponse(messages, 2)
		const result = response['result'] as {
			structuredContent?: Record<string, unknown>
		}
		assert.equal(result.structuredContent?.['status'], 'cancelled')
	} finally {
		child.kill('SIGTERM')
		await new Promise<void>(resolve => child.once('close', () => resolve()))
		provider.closeAllConnections()
		await new Promise<void>((resolve, reject) => {
			provider.close(error => error === undefined ? resolve() : reject(error))
		})
	}
})

function writeMessage(
	input: NodeJS.WritableStream,
	message: Record<string, unknown>,
): void {
	input.write(`${JSON.stringify(message)}\n`)
}

async function waitForResponse(
	messages: Array<Record<string, unknown>>,
	id: number,
): Promise<Record<string, unknown>> {
	const startedAt = Date.now()

	while (true) {
		const response = messages.find(message => message['id'] === id)

		if (response !== undefined) {
			return response
		}

		if (Date.now() - startedAt > 5000) {
			throw new Error(`Timed out waiting for JSON-RPC response ${id}`)
		}

		await new Promise(resolve => setTimeout(resolve, 10))
	}
}

test('rejects excess concurrent MCP requests while preserving the active request', async function () {
	let markRequestStarted: (() => void) | undefined
	const requestStarted = new Promise<void>(resolve => {
		markRequestStarted = resolve
	})
	const provider = createServer(request => {
		request.resume()
		request.on('end', () => markRequestStarted?.())
	})
	await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
	const address = provider.address()

	if (address === null || typeof address === 'string') {
		throw new Error('Provider fixture did not bind to a TCP port')
	}

	const repositoryPath = await createTestRepository()
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-mcp-limit-'))
	const child = spawn(process.execPath, [path.resolve('dist/src/cli.js'), 'mcp'], {
		cwd: process.cwd(),
		stdio: ['pipe', 'pipe', 'pipe'],
		env: {
			...process.env,
			QWEN_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			QWEN_API_KEY: 'test-api-key',
			QWEN_MODEL: 'fake-worker',
			QWEN_MAX_RETRIES: '0',
			QWEN_TIMEOUT_MS: '60000',
			AGENT_HARNESS_ARTIFACT_ROOT: artifactRoot,
			AGENT_HARNESS_MAX_MCP_IN_FLIGHT: '1',
			AGENT_HARNESS_LOG_LEVEL: 'error',
		},
	})

	if (child.stdin === null) {
		throw new Error('MCP child stdin is unavailable')
	}

	const messages: Array<Record<string, unknown>> = []
	const output = createInterface({ input: child.stdout })
	output.on('line', line => messages.push(JSON.parse(line) as Record<string, unknown>))

	try {
		writeMessage(child.stdin, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-11-25',
				capabilities: {},
				clientInfo: { name: 'test', version: '1' },
			},
		})
		await waitForResponse(messages, 1)
		writeMessage(child.stdin, {
			jsonrpc: '2.0',
			method: 'notifications/initialized',
		})
		await new Promise(resolve => setTimeout(resolve, 20))
		writeMessage(child.stdin, {
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/call',
			params: {
				name: 'delegate_to_worker',
				arguments: {
					objective: 'Remain active until cancelled.',
					repositoryPath,
					mode: 'research',
					allowedPaths: ['**/*'],
					timeoutSeconds: 60,
				},
			},
		})
		await requestStarted
		writeMessage(child.stdin, {
			jsonrpc: '2.0',
			id: 3,
			method: 'ping',
			params: {},
		})
		const overloaded = await waitForResponse(messages, 3)
		const error = overloaded['error'] as { code: number; message: string }
		assert.equal(error.code, -32000)
		assert.match(error.message, /in-flight limit/)
		writeMessage(child.stdin, {
			jsonrpc: '2.0',
			method: 'notifications/cancelled',
			params: { requestId: 2, reason: 'test complete' },
		})
		const active = await waitForResponse(messages, 2)
		const result = active['result'] as {
			structuredContent?: Record<string, unknown>
		}
		assert.equal(result.structuredContent?.['status'], 'cancelled')
	} finally {
		child.kill('SIGTERM')
		await new Promise<void>(resolve => child.once('close', () => resolve()))
		provider.closeAllConnections()
		await new Promise<void>((resolve, reject) => {
			provider.close(error => error === undefined ? resolve() : reject(error))
		})
	}
})
