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
import {
	runAgentLoop,
	type AgentLoopObservation,
} from '../../src/worker/agent-loop.js'
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
	const observations: Array<AgentLoopObservation> = []

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
			async observation => {
				observations.push(observation)
			},
		),
		(error: unknown) =>
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'WORKER_TOOL_CALL_LIMIT',
	)
	assert.deepEqual(
		observations.map(observation => [
			observation.type,
			observation.outcome,
			observation.type === 'model_turn'
				? observation.toolCallCount
				: null,
		]),
		[['model_turn', 'failed', 0]],
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

test('reports bounded model-turn and tool-call timing without payloads', async function () {
	const { task, executor } = await createFixture()
	const completions: Array<ProviderCompletion> = [
		{
			content: null,
			toolCalls: [{
				id: 'call-1',
				type: 'function',
				function: { name: 'list_files', arguments: '{}' },
			}],
		},
		{ content: 'done', toolCalls: [] },
	]
	const provider: WorkerProvider = {
		async complete(): Promise<ProviderCompletion> {
			const completion = completions.shift()
			assert.ok(completion)
			return completion
		},
	}
	const observations: Array<AgentLoopObservation> = []
	const result = await runAgentLoop(
		task,
		provider,
		executor,
		{
			maxTotalToolCalls: 10,
			maxContextBytes: 1_000_000,
			maxAssistantContentBytes: 65_536,
		},
		new AbortController().signal,
		async observation => {
			observations.push(observation)
		},
	)

	assert.equal(result.finalResponse, 'done')
	assert.deepEqual(observations.map(item => item.type), [
		'model_turn',
		'tool_call',
		'model_turn',
	])
	assert.deepEqual(
		observations
			.filter(observation => observation.type === 'model_turn')
			.map(observation => observation.toolCallCount),
		[1, 0],
	)
	for (const observation of observations) {
		assert.ok(observation.durationMs >= 0)
		assert.ok(Date.parse(observation.completedAt) >= Date.parse(observation.startedAt))
		assert.equal('content' in observation, false)
	}
})

test('reports a failed model turn before propagating the provider error', async function () {
	const { task, executor } = await createFixture()
	const provider: WorkerProvider = {
		async complete(): Promise<ProviderCompletion> {
			throw new Error('provider unavailable')
		},
	}
	const observations: Array<AgentLoopObservation> = []
	await assert.rejects(
		runAgentLoop(
			task,
			provider,
			executor,
			{
				maxTotalToolCalls: 10,
				maxContextBytes: 1_000_000,
				maxAssistantContentBytes: 65_536,
			},
			new AbortController().signal,
			async observation => {
				observations.push(observation)
			},
		),
		/provider unavailable/,
	)
	assert.equal(observations.length, 1)
	assert.equal(observations[0]?.type, 'model_turn')
	assert.equal(observations[0]?.outcome, 'failed')
	assert.equal(
		observations[0]?.type === 'model_turn'
			? observations[0].toolCallCount
			: null,
		0,
	)
})
