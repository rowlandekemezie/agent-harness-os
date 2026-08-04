import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadConfig } from '../../src/config.js'
import type {
	ProviderCompletion,
	ProviderRequest,
	WorkerProvider,
	WorkerTask,
} from '../../src/domain/types.js'
import { runAgentLoop } from '../../src/worker/agent-loop.js'
import { WorkerToolExecutor } from '../../src/worker/tool-executor.js'

class StaticProvider implements WorkerProvider {
	private readonly completion: ProviderCompletion
	private requestCount = 0

	constructor(completion: ProviderCompletion) {
		this.completion = completion
	}

	async complete(_request: ProviderRequest): Promise<ProviderCompletion> {
		this.requestCount += 1
		return this.completion
	}

	getRequestCount(): number {
		return this.requestCount
	}
}

async function createFixture(): Promise<{
	task: WorkerTask
	executor: WorkerToolExecutor
}> {
	const worktreePath = await mkdtemp(path.join(os.tmpdir(), 'agent-loop-'))
	const task: WorkerTask = {
		objective: 'Inspect the repository.',
		repositoryPath: worktreePath,
		mode: 'research',
		allowedPaths: ['**/*'],
		prohibitedPaths: [],
		acceptanceCriteria: [],
		requiredCommands: [],
		baseRef: 'HEAD',
		maxIterations: 4,
		timeoutSeconds: 30,
		allowNetwork: false,
	}
	const executor = new WorkerToolExecutor({
		task,
		worktreePath,
		config: loadConfig({}),
		baseCommit: 'HEAD',
		policyViolations: [],
		signal: new AbortController().signal,
	})
	return { task, executor }
}

test('bounds total worker tool calls across a run', async function () {
	const { task, executor } = await createFixture()
	const provider = new StaticProvider({
		content: null,
		toolCalls: [
			{
				id: 'call-1',
				type: 'function',
				function: { name: 'list_files', arguments: '{}' },
			},
			{
				id: 'call-2',
				type: 'function',
				function: { name: 'list_files', arguments: '{}' },
			},
		],
	})

	await assert.rejects(
		runAgentLoop(
			task,
			provider,
			executor,
			{
				maxTotalToolCalls: 1,
				maxContextBytes: 1_000_000,
				maxAssistantContentBytes: 65_536,
			},
			new AbortController().signal,
		),
		(error: unknown) =>
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'WORKER_TOOL_CALL_LIMIT',
	)
})

test('bounds provider context before issuing a request', async function () {
	const { task, executor } = await createFixture()
	const provider = new StaticProvider({ content: 'done', toolCalls: [] })

	await assert.rejects(
		runAgentLoop(
			task,
			provider,
			executor,
			{
				maxTotalToolCalls: 10,
				maxContextBytes: 1,
				maxAssistantContentBytes: 65_536,
			},
			new AbortController().signal,
		),
		(error: unknown) =>
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'WORKER_CONTEXT_LIMIT',
	)
	assert.equal(provider.getRequestCount(), 0)
})

test('bounds assistant content returned by the worker provider', async function () {
	const { task, executor } = await createFixture()
	const provider = new StaticProvider({
		content: 'x'.repeat(101),
		toolCalls: [],
	})

	await assert.rejects(
		runAgentLoop(
			task,
			provider,
			executor,
			{
				maxTotalToolCalls: 10,
				maxContextBytes: 1_000_000,
				maxAssistantContentBytes: 100,
			},
			new AbortController().signal,
		),
		(error: unknown) =>
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'WORKER_ASSISTANT_CONTENT_LIMIT',
	)
})
