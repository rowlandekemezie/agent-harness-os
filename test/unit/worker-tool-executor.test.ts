import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadConfig } from '../../src/config.js'
import type { CommandRunner } from '../../src/worker/command-runner.js'
import { WorkerToolExecutor } from '../../src/worker/tool-executor.js'

const unavailableCommandRunner: CommandRunner = {
	run: async () => {
		throw new Error('Command runner should not be called')
	},
}

test('exposes literal search only and enforces file limits by UTF-8 bytes', async function () {
	const worktreePath = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-tools-'))
	const config = loadConfig({
		AGENT_HARNESS_MAX_FILE_BYTES: '1024',
	})
	const executor = new WorkerToolExecutor({
		task: {
			objective: 'Test the tool contract.',
			repositoryPath: worktreePath,
			mode: 'implementation',
			allowedPaths: ['**/*'],
			prohibitedPaths: [],
			acceptanceCriteria: [],
			requiredCommands: [],
			baseRef: 'HEAD',
			maxIterations: 1,
			timeoutSeconds: 30,
			allowNetwork: false,
		},
		worktreePath,
		repositoryPath: worktreePath,
		sandboxHome: path.join(worktreePath, '.sandbox-home'),
		config,
		commandRunner: unavailableCommandRunner,
		commandResults: [],
		policyViolations: [],
		signal: new AbortController().signal,
	})
	const searchDefinition = executor.getDefinitions().find(
		definition => definition.function.name === 'search_files',
	)
	const parameters = searchDefinition?.function.parameters as {
		properties?: Record<string, unknown>
	} | undefined

	assert.ok(searchDefinition)
	assert.equal(parameters?.properties?.['isRegex'], undefined)

	const result = await executor.execute('write_file', {
		path: 'unicode.txt',
		content: 'é'.repeat(600),
	})

	assert.equal(result.isError, true)
	assert.match(result.content, /FILE_TOO_LARGE/)
})


test('bounds successful tool output by UTF-8 bytes', async function () {
	const worktreePath = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-output-'))
	await writeFile(path.join(worktreePath, 'large.txt'), 'é'.repeat(900), 'utf8')
	const config = loadConfig({
		AGENT_HARNESS_MAX_FILE_BYTES: '4096',
		AGENT_HARNESS_MAX_TOOL_OUTPUT_BYTES: '1024',
	})
	const executor = new WorkerToolExecutor({
		task: {
			objective: 'Test output bounds.',
			repositoryPath: worktreePath,
			mode: 'implementation',
			allowedPaths: ['**/*'],
			prohibitedPaths: [],
			acceptanceCriteria: [],
			requiredCommands: [],
			baseRef: 'HEAD',
			maxIterations: 1,
			timeoutSeconds: 30,
			allowNetwork: false,
		},
		worktreePath,
		repositoryPath: worktreePath,
		sandboxHome: path.join(worktreePath, '.sandbox-home'),
		config,
		commandRunner: unavailableCommandRunner,
		commandResults: [],
		policyViolations: [],
		signal: new AbortController().signal,
	})

	const result = await executor.execute('read_file', { path: 'large.txt' })

	assert.equal(result.isError, false)
	assert.ok(Buffer.byteLength(result.content, 'utf8') <= 1024)
	assert.match(result.content, /TOOL OUTPUT TRUNCATED/)
})
