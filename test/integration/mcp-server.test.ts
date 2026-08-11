import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'
import test from 'node:test'

test('speaks newline-delimited MCP JSON-RPC over stdio', async function () {
	const cliPath = path.resolve('dist/src/cli.js')
	const child = spawn(process.execPath, [cliPath, 'mcp'], {
		cwd: process.cwd(),
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, AGENT_HARNESS_LOG_LEVEL: 'error' },
	})
	const output = createInterface({ input: child.stdout })
	const lines: Array<unknown> = []
	output.on('line', line => lines.push(JSON.parse(line)))

	child.stdin.write(`${JSON.stringify({
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
	})}\n`)
	await waitForLength(lines, 1)
	assert.equal((lines[0] as Record<string, unknown>)['jsonrpc'], '2.0')

	child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
	child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`)
	await waitForLength(lines, 2)
	const response = lines[1] as { result: { tools: Array<{ name: string }> } }
	assert.deepEqual(
		response.result.tools.map(tool => tool.name),
		[
			'health_check',
			'list_workers',
			'route_worker',
			'delegate_to_worker',
			'get_worker_run',
			'create_coding_workflow',
			'run_workflow',
			'approve_workflow',
			'cancel_workflow',
			'get_workflow',
			'list_workflows',
			'list_tasks',
			'get_task_timeline',
			'get_observability_trace',
			'get_observability_metrics',
			'apply_worker_patch',
		],
	)

	child.kill('SIGTERM')
	await new Promise<void>(resolve => child.once('close', () => resolve()))
})


test('supports stateless MCP 2026-07-28 discovery and tool calls', async function () {
	const cliPath = path.resolve('dist/src/cli.js')
	const child = spawn(process.execPath, [cliPath, 'mcp'], {
		cwd: process.cwd(),
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, AGENT_HARNESS_LOG_LEVEL: 'error' },
	})
	const output = createInterface({ input: child.stdout })
	const lines: Array<Record<string, unknown>> = []
	output.on('line', line => lines.push(JSON.parse(line) as Record<string, unknown>))
	const modernMeta = {
		'io.modelcontextprotocol/protocolVersion': '2026-07-28',
		'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
		'io.modelcontextprotocol/clientCapabilities': {},
	}

	try {
		child.stdin.write(`${JSON.stringify({
			jsonrpc: '2.0',
			id: 'discover',
			method: 'server/discover',
			params: { _meta: modernMeta },
		})}\n`)
		await waitForLength(lines, 1)
		const discoverMessage = lines[0]
		assert.ok(discoverMessage)
		const discover = discoverMessage['result'] as Record<string, unknown>
		assert.equal(discover['resultType'], 'complete')
		assert.deepEqual(discover['supportedVersions'], ['2026-07-28', '2025-11-25', '2025-06-18'])

		child.stdin.write(`${JSON.stringify({
			jsonrpc: '2.0',
			id: 'list',
			method: 'tools/list',
			params: { _meta: modernMeta },
		})}\n`)
		await waitForLength(lines, 2)
		const listMessage = lines[1]
		assert.ok(listMessage)
		const list = listMessage['result'] as {
			resultType: string
			tools: Array<{ name: string }>
		}
		assert.equal(list.resultType, 'complete')
		assert.deepEqual(
			list.tools.map(tool => tool.name),
			[
			'health_check',
			'list_workers',
			'route_worker',
				'delegate_to_worker',
				'get_worker_run',
				'create_coding_workflow',
				'run_workflow',
				'approve_workflow',
				'cancel_workflow',
				'get_workflow',
				'list_workflows',
				'list_tasks',
				'get_task_timeline',
				'get_observability_trace',
				'get_observability_metrics',
				'apply_worker_patch',
			],
		)

		child.stdin.write(`${JSON.stringify({
			jsonrpc: '2.0',
			id: 'health',
			method: 'tools/call',
			params: { _meta: modernMeta, name: 'health_check', arguments: {} },
		})}\n`)
		await waitForLength(lines, 3)
		const healthMessage = lines[2]
		assert.ok(healthMessage)
		const health = healthMessage['result'] as Record<string, unknown>
		assert.equal(health['resultType'], 'complete')
		assert.equal(health['isError'], undefined)
	} finally {
		child.kill('SIGTERM')
		await new Promise<void>(resolve => child.once('close', () => resolve()))
	}
})

test('rejects unsupported stateless MCP protocol versions', async function () {
	const cliPath = path.resolve('dist/src/cli.js')
	const child = spawn(process.execPath, [cliPath, 'mcp'], {
		cwd: process.cwd(),
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, AGENT_HARNESS_LOG_LEVEL: 'error' },
	})
	const output = createInterface({ input: child.stdout })
	const lines: Array<Record<string, unknown>> = []
	output.on('line', line => lines.push(JSON.parse(line) as Record<string, unknown>))

	try {
		child.stdin.write(`${JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
			params: {
				_meta: {
					'io.modelcontextprotocol/protocolVersion': '1900-01-01',
					'io.modelcontextprotocol/clientCapabilities': {},
				},
			},
		})}\n`)
		await waitForLength(lines, 1)
		const errorMessage = lines[0]
		assert.ok(errorMessage)
		const error = errorMessage['error'] as {
			code: number
			data: { supported: Array<string>; requested: string }
		}
		assert.equal(error.code, -32022)
		assert.equal(error.data.requested, '1900-01-01')
		assert.equal(error.data.supported[0], '2026-07-28')
	} finally {
		child.kill('SIGTERM')
		await new Promise<void>(resolve => child.once('close', () => resolve()))
	}
})

async function waitForLength(values: Array<unknown>, expected: number): Promise<void> {
	const startedAt = Date.now()

	while (values.length < expected) {
		if (Date.now() - startedAt > 5000) {
			throw new Error(`Timed out waiting for ${expected} JSON-RPC responses`)
		}

		await new Promise(resolve => setTimeout(resolve, 10))
	}
}

test('bounds MCP input lines and recovers after an oversized request', async function () {
	const cliPath = path.resolve('dist/src/cli.js')
	const child = spawn(process.execPath, [cliPath, 'mcp'], {
		cwd: process.cwd(),
		stdio: ['pipe', 'pipe', 'pipe'],
		env: {
			...process.env,
			AGENT_HARNESS_LOG_LEVEL: 'error',
			AGENT_HARNESS_MAX_MCP_MESSAGE_BYTES: '1024',
		},
	})
	const output = createInterface({ input: child.stdout })
	const lines: Array<Record<string, unknown>> = []
	output.on('line', line => lines.push(JSON.parse(line) as Record<string, unknown>))

	try {
		child.stdin.write(`${JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'ping',
			params: { padding: 'x'.repeat(2_000) },
		})}\n`)
		await waitForLength(lines, 1)
		const oversizedResponse = lines[0]
		assert.ok(oversizedResponse)
		const oversizedError = oversizedResponse['error'] as { code: number }
		assert.equal(oversizedError.code, -32600)

		child.stdin.write(`${JSON.stringify({
			jsonrpc: '2.0',
			id: 2,
			method: 'initialize',
			params: {
				protocolVersion: '2025-11-25',
				capabilities: {},
				clientInfo: { name: 'test', version: '1' },
			},
		})}\n`)
		await waitForLength(lines, 2)
		const initializeResponse = lines[1]
		assert.ok(initializeResponse)
		const initializeResult = initializeResponse['result'] as {
			protocolVersion: string
		}
		assert.equal(initializeResult.protocolVersion, '2025-11-25')
	} finally {
		child.kill('SIGTERM')
		await new Promise<void>(resolve => child.once('close', () => resolve()))
	}
})
