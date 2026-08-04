import assert from 'node:assert/strict'
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadConfig } from '../../src/config.js'
import type { WorkerTask } from '../../src/domain/types.js'
import { createCommandRunner } from '../../src/worker/command-runner.js'

function createTask(repositoryPath: string, allowNetwork: boolean): WorkerTask {
	return {
		objective: 'Run one declared validation command.',
		repositoryPath,
		mode: 'implementation',
		allowedPaths: ['src/**'],
		prohibitedPaths: [],
		acceptanceCriteria: [],
		requiredCommands: [{ command: 'npm', args: ['test'] }],
		baseRef: 'HEAD',
		maxIterations: 1,
		timeoutSeconds: 30,
		allowNetwork,
	}
}

async function installFakeDocker(
	directory: string,
	logPath: string,
	cleanupFails: boolean,
): Promise<void> {
	const executablePath = path.join(directory, 'docker')
	const source = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n')
if (args[0] === 'rm') {
	if (${JSON.stringify(cleanupFails)}) {
		process.stderr.write('daemon unavailable\\n')
		process.exit(2)
	}
	process.stderr.write('Error response from daemon: No such container\\n')
	process.exit(1)
}
process.stdout.write('validation passed\\n')
`
	await writeFile(executablePath, source, 'utf8')
	await chmod(executablePath, 0o755)
}

test('hardens Docker execution and confirms container cleanup', {
	skip: process.platform === 'win32',
}, async function () {
	const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'command-runner-repo-'))
	const fakeBin = await mkdtemp(path.join(os.tmpdir(), 'command-runner-bin-'))
	const logPath = path.join(fakeBin, 'docker.log')
	await writeFile(path.join(repositoryPath, '.git'), 'gitdir: /tmp/unmounted-gitdir\n')
	await mkdir(path.join(repositoryPath, 'src'))
	await installFakeDocker(fakeBin, logPath, false)
	const originalPath = process.env.PATH
	process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ''}`

	try {
		const config = loadConfig({
			AGENT_HARNESS_EXECUTION_BACKEND: 'docker',
			AGENT_HARNESS_DOCKER_IMAGE: `node@sha256:${'a'.repeat(64)}`,
		})
		const runner = createCommandRunner(config)
		const result = await runner.run(
			{ command: 'npm', args: ['test'] },
			{
				worktreePath: repositoryPath,
				repositoryPath,
				sandboxHome: path.join(repositoryPath, '.home'),
				task: createTask(repositoryPath, false),
				signal: new AbortController().signal,
			},
		)

		assert.equal(result.command, 'npm')
		assert.deepEqual(result.args, ['test'])
		assert.equal(result.exitCode, 0)
		const calls = (await readFile(logPath, 'utf8'))
			.trim()
			.split('\n')
			.map(line => JSON.parse(line) as Array<string>)
		assert.equal(calls.length, 2)
		const runCall = calls[0]
		const cleanupCall = calls[1]
		assert.ok(runCall)
		assert.ok(cleanupCall)
		const entrypointIndex = runCall.indexOf('--entrypoint')
		assert.ok(entrypointIndex >= 0)
		assert.equal(runCall[entrypointIndex + 1], '')
		assert.ok(
			runCall.some(argument =>
				argument.includes('target=/workspace/.git,readonly'),
			),
		)
		assert.deepEqual(cleanupCall.slice(0, 2), ['rm', '--force'])
	} finally {
		process.env.PATH = originalPath
	}
})

test('fails closed when Docker container removal cannot be confirmed', {
	skip: process.platform === 'win32',
}, async function () {
	const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'command-runner-cleanup-'))
	const fakeBin = await mkdtemp(path.join(os.tmpdir(), 'command-runner-cleanup-bin-'))
	const logPath = path.join(fakeBin, 'docker.log')
	await writeFile(path.join(repositoryPath, '.git'), 'gitdir: /tmp/unmounted-gitdir\n')
	await installFakeDocker(fakeBin, logPath, true)
	const originalPath = process.env.PATH
	process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ''}`

	try {
		const config = loadConfig({
			AGENT_HARNESS_EXECUTION_BACKEND: 'docker',
			AGENT_HARNESS_DOCKER_IMAGE: `node@sha256:${'b'.repeat(64)}`,
		})
		const runner = createCommandRunner(config)

		await assert.rejects(
			runner.run(
				{ command: 'npm', args: ['test'] },
				{
					worktreePath: repositoryPath,
					repositoryPath,
					sandboxHome: path.join(repositoryPath, '.home'),
					task: createTask(repositoryPath, false),
					signal: new AbortController().signal,
				},
			),
			(error: unknown) =>
				typeof error === 'object' &&
				error !== null &&
				'code' in error &&
				error.code === 'DOCKER_CONTAINER_CLEANUP_FAILED',
		)
		const calls = (await readFile(logPath, 'utf8'))
			.trim()
			.split('\n')
			.map(line => JSON.parse(line) as Array<string>)
		assert.equal(calls.filter(call => call[0] === 'rm').length, 3)
	} finally {
		process.env.PATH = originalPath
	}
})

test('does not pretend local execution can enforce network isolation', async function () {
	const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'command-runner-local-'))
	const config = loadConfig({
		AGENT_HARNESS_EXECUTION_BACKEND: 'local',
		AGENT_HARNESS_ALLOW_UNSANDBOXED_LOCAL: 'true',
	})
	const runner = createCommandRunner(config)

	await assert.rejects(
		runner.run(
			{ command: 'npm', args: ['test'] },
			{
				worktreePath: repositoryPath,
				repositoryPath,
				sandboxHome: path.join(repositoryPath, '.home'),
				task: createTask(repositoryPath, false),
				signal: new AbortController().signal,
			},
		),
		(error: unknown) =>
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'LOCAL_NETWORK_ISOLATION_UNAVAILABLE',
	)
})
