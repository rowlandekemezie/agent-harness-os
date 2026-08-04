import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadConfig } from '../../src/config.js'
import { resolveCommit } from '../../src/git/repository.js'
import { WorkerToolExecutor } from '../../src/worker/tool-executor.js'
import { createTestRepository } from '../helpers/git.js'


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
		config,
		baseCommit: 'HEAD',
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
	assert.equal(
		executor.getDefinitions().some(
			definition => definition.function.name === 'run_command',
		),
		false,
	)

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
		config,
		baseCommit: 'HEAD',
		policyViolations: [],
		signal: new AbortController().signal,
	})

	const result = await executor.execute('read_file', { path: 'large.txt' })

	assert.equal(result.isError, false)
	assert.ok(Buffer.byteLength(result.content, 'utf8') <= 1024)
	assert.match(result.content, /TOOL OUTPUT TRUNCATED/)
})


test('does not expose diffs for prohibited changed paths', async function () {
	const repositoryPath = await createTestRepository()
	const baseCommit = await resolveCommit(repositoryPath, 'HEAD')
	await writeFile(path.join(repositoryPath, '.env'), 'SECRET=do-not-expose\n', 'utf8')
	const config = loadConfig({})
	const executor = new WorkerToolExecutor({
		task: {
			objective: 'Test diff scope enforcement.',
			repositoryPath,
			mode: 'implementation',
			allowedPaths: ['src/**'],
			prohibitedPaths: [],
			acceptanceCriteria: [],
			requiredCommands: [],
			baseRef: baseCommit,
			maxIterations: 1,
			timeoutSeconds: 30,
			allowNetwork: false,
		},
		worktreePath: repositoryPath,
		config,
		baseCommit,
		policyViolations: [],
		signal: new AbortController().signal,
	})

	const result = await executor.execute('get_diff', {})

	assert.equal(result.isError, true)
	assert.match(result.content, /SENSITIVE_PATH_DENIED|PATH_NOT_ALLOWED/)
	assert.equal(result.content.includes('do-not-expose'), false)
})

test('bounds repository traversal independently of returned entry count', async function () {
	const worktreePath = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-traversal-'))

	for (let index = 0; index < 101; index += 1) {
		await writeFile(
			path.join(worktreePath, `file-${index}.txt`),
			'fixture\n',
			'utf8',
		)
	}

	const config = loadConfig({
		AGENT_HARNESS_MAX_TRAVERSAL_ENTRIES: '100',
	})
	const task = {
		objective: 'List repository files.',
		repositoryPath: worktreePath,
		mode: 'research' as const,
		allowedPaths: ['**/*'],
		prohibitedPaths: [],
		acceptanceCriteria: [],
		requiredCommands: [],
		baseRef: 'HEAD',
		maxIterations: 1,
		timeoutSeconds: 30,
		allowNetwork: false,
	}
	const executor = new WorkerToolExecutor({
		task,
		worktreePath,
		config,
		baseCommit: 'HEAD',
		policyViolations: [],
		signal: new AbortController().signal,
	})

	const result = await executor.execute('list_files', {})
	assert.equal(result.isError, true)
	assert.match(result.content, /FILE_TRAVERSAL_LIMIT/)
})

test('bounds aggregate bytes scanned during literal search', async function () {
	const worktreePath = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-search-'))
	await writeFile(path.join(worktreePath, 'first.txt'), 'a'.repeat(600_000), 'utf8')
	await writeFile(path.join(worktreePath, 'second.txt'), 'b'.repeat(600_000), 'utf8')
	const config = loadConfig({
		AGENT_HARNESS_MAX_FILE_BYTES: '1048576',
		AGENT_HARNESS_MAX_SEARCH_BYTES: '1048576',
	})
	const task = {
		objective: 'Search repository files.',
		repositoryPath: worktreePath,
		mode: 'research' as const,
		allowedPaths: ['**/*'],
		prohibitedPaths: [],
		acceptanceCriteria: [],
		requiredCommands: [],
		baseRef: 'HEAD',
		maxIterations: 1,
		timeoutSeconds: 30,
		allowNetwork: false,
	}
	const executor = new WorkerToolExecutor({
		task,
		worktreePath,
		config,
		baseCommit: 'HEAD',
		policyViolations: [],
		signal: new AbortController().signal,
	})

	const result = await executor.execute('search_files', { query: 'not-present' })
	assert.equal(result.isError, true)
	assert.match(result.content, /SEARCH_BYTE_LIMIT/)
})
