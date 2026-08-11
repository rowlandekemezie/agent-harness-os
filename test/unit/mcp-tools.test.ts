import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadConfig } from '../../src/config.js'
import { McpTools } from '../../src/mcp/tools.js'
import { createTestRepository } from '../helpers/git.js'

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
			'create_coding_workflow',
			'run_workflow',
			'approve_workflow',
			'cancel_workflow',
			'get_workflow',
			'list_workflows',
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

test('requires an implementation stage for durable workflows', async function () {
	const tools = new McpTools(loadConfig({}))
	const result = await tools.call('create_coding_workflow', {
		objective: 'Create a durable workflow.',
		repositoryPath: process.cwd(),
		stages: {},
	})

	assert.equal(result.isError, true)
	assert.equal(result.structuredContent?.['error'], 'INVALID_ARGUMENT')
})

test('forwards MCP cancellation to workflow approval', async function () {
	const tools = new McpTools(loadConfig({}))
	let receivedSignal: AbortSignal | undefined
	const mutableTools = tools as unknown as {
		workflowService: {
			approve(
				repositoryPath: string,
				workflowId: string,
				decision: 'approved' | 'rejected',
				feedback: string,
				signal?: AbortSignal,
			): Promise<Record<string, unknown>>
		}
	}
	mutableTools.workflowService = {
		async approve(_repositoryPath, _workflowId, _decision, _feedback, signal) {
			receivedSignal = signal
			return { status: 'waiting_for_approval' }
		},
	}
	const controller = new AbortController()

	const response = await tools.call('approve_workflow', {
		repositoryPath: '/tmp/repository',
		workflowId: randomUUID(),
		decision: 'approved',
	}, controller.signal)

	assert.notEqual(response.isError, true)
	assert.equal(receivedSignal, controller.signal)
})

test('rejects approval feedback that exceeds its UTF-8 byte bound', async function () {
	const tools = new McpTools(loadConfig({}))
	const response = await tools.call('approve_workflow', {
		repositoryPath: '/tmp/repository',
		workflowId: randomUUID(),
		decision: 'rejected',
		feedback: '🙂'.repeat(2_000),
	})

	assert.equal(response.isError, true)
	assert.equal(response.structuredContent?.['error'], 'INVALID_ARGUMENT')
})

test('creates and reads a durable workflow without invoking a provider', async function () {
	const repositoryPath = await createTestRepository()
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'mcp-workflow-'))
	const tools = new McpTools(loadConfig({
		AGENT_HARNESS_ARTIFACT_ROOT: artifactRoot,
	}))
	const created = await tools.call('create_coding_workflow', {
		objective: 'Persist a bounded workflow.',
		repositoryPath,
		stages: {
			implement: {
				objective: 'Implement the bounded change.',
				allowedPaths: ['src/**'],
			},
		},
	})
	assert.equal(created.isError, undefined)
	const summary = created.structuredContent?.['summary'] as {
		workflowId: string
		status: string
	}
	assert.equal(summary.status, 'pending')

	const loaded = await tools.call('get_workflow', {
		repositoryPath,
		workflowId: summary.workflowId,
	})
	assert.equal(
		(loaded.structuredContent?.['summary'] as { workflowId: string }).workflowId,
		summary.workflowId,
	)
	const listed = await tools.call('list_workflows', { repositoryPath })
	assert.deepEqual(
		(listed.structuredContent?.['workflows'] as Array<{ workflowId: string }>)
			.map(workflow => workflow.workflowId),
		[summary.workflowId],
	)
})
