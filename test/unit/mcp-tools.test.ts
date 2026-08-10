import assert from 'node:assert/strict'
import test from 'node:test'
import { loadConfig } from '../../src/config.js'
import { McpTools } from '../../src/mcp/tools.js'

test('marks delegation as open-world and requires an explicit path allowlist', async function () {
	const tools = new McpTools(loadConfig({}))
	const delegation = tools.list().find(
		definition => definition.name === 'delegate_to_worker',
	)
	assert.ok(delegation)
	assert.equal(delegation.annotations.openWorldHint, true)
	assert.deepEqual(
		(delegation.inputSchema['required'] as Array<string>),
		['objective', 'repositoryPath', 'allowedPaths'],
	)

	const result = await tools.call('delegate_to_worker', {
		objective: 'Inspect one bounded area.',
		repositoryPath: process.cwd(),
	})
	assert.equal(result.isError, true)
	assert.equal(result.structuredContent?.['error'], 'INVALID_ARGUMENT')
})

test('rejects validation commands for read-only worker modes', async function () {
	const tools = new McpTools(loadConfig({}))
	const result = await tools.call('delegate_to_worker', {
		objective: 'Review the selected files.',
		repositoryPath: process.cwd(),
		mode: 'review',
		allowedPaths: ['src/**'],
		requiredCommands: [
			{ command: 'npm', args: ['test'] },
		],
	})

	assert.equal(result.isError, true)
	assert.equal(result.structuredContent?.['error'], 'INVALID_ARGUMENT')
	assert.match(
		String(result.structuredContent?.['message']),
		/read-only/,
	)
})

test('rejects unsupported task-history filters before reading artifacts', async function () {
	const tools = new McpTools(loadConfig({}))
	const result = await tools.call('list_tasks', {
		repositoryPath: process.cwd(),
		status: 'unknown',
	})

	assert.equal(result.isError, true)
	assert.equal(result.structuredContent?.['error'], 'INVALID_ARGUMENT')
})

test('exposes the worker registry and deterministic route preview without invoking providers', async function () {
	const tools = new McpTools(loadConfig({
		AGENT_OS_WORKERS_JSON: JSON.stringify([
			{
				id: 'cheap-worker',
				adapter: 'openai-compatible',
				model: 'cheap',
				baseUrl: 'http://127.0.0.1:9001/v1',
				auth: 'none',
				capabilities: ['implementation', 'tool-calling'],
				costTier: 'low',
				latencyTier: 'fast',
			},
			{
				id: 'quality-worker',
				adapter: 'openai-compatible',
				model: 'quality',
				baseUrl: 'http://127.0.0.1:9002/v1',
				auth: 'none',
				capabilities: ['implementation', 'tool-calling'],
				priority: 90,
				costTier: 'high',
				latencyTier: 'standard',
			},
		]),
	}))
	assert.deepEqual(
		tools.list().map(definition => definition.name),
		[
			'health_check',
			'list_workers',
			'route_worker',
			'delegate_to_worker',
			'get_worker_run',
			'list_tasks',
			'get_task_timeline',
			'apply_worker_patch',
		],
	)

	const workers = await tools.call('list_workers', {})
	assert.equal(
		(workers.structuredContent?.['workers'] as Array<unknown>).length,
		2,
	)

	const route = await tools.call('route_worker', {
		mode: 'implementation',
		routing: { strategy: 'cost' },
	})
	const candidates = route.structuredContent?.['candidates'] as Array<{
		workerId: string
	}>
	assert.equal(candidates[0]?.workerId, 'cheap-worker')
})
