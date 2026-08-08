import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadConfig } from '../../src/config.js'
import { WorkerService } from '../../src/worker/service.js'
import { createTestRepository } from '../helpers/git.js'

async function createFakeCodexWorker(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-os-codex-worker-'))
	const command = path.join(directory, 'codex')
	const script = [
		'#!/usr/bin/env node',
		"const fs = require('node:fs')",
		"const path = require('node:path')",
		'const directory = path.dirname(process.argv[1])',
		'const args = process.argv.slice(2)',
		"if (args[0] === 'login' && args[1] === 'status') {",
		"\tprocess.stdout.write('Logged in using ChatGPT\\n')",
		'\tprocess.exit(0)',
		'}',
		"if (args[0] !== 'exec') process.exit(2)",
		"const statePath = path.join(directory, 'count.txt')",
		"const count = fs.existsSync(statePath) ? Number(fs.readFileSync(statePath, 'utf8')) : 0",
		'fs.writeFileSync(statePath, String(count + 1))',
		"const outputIndex = args.indexOf('--output-last-message')",
		'const outputPath = args[outputIndex + 1]',
		'const result = count === 0',
		"\t? { content: null, toolCalls: [{ id: 'write-1', name: 'write_file', arguments: { path: 'src/codex.ts', content: \"export function fromCodex(): string {\\n\\treturn 'subscription'\\n}\\n\" } }] }",
		"\t: { content: 'Completed through the Codex subscription worker.', toolCalls: [] }",
		'fs.writeFileSync(outputPath, JSON.stringify(result))',
	].join('\n')
	await writeFile(command, `${script}\n`)
	await chmod(command, 0o755)
	return command
}

test('delegates through a ChatGPT-authenticated Codex CLI worker and preserves patch gates', async function () {
	const repositoryPath = await createTestRepository()
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-os-codex-artifacts-'))
	const command = await createFakeCodexWorker()
	const config = loadConfig({
		AGENT_HARNESS_ARTIFACT_ROOT: artifactRoot,
		AGENT_OS_DEFAULT_WORKER: 'codex-subscription',
		AGENT_OS_WORKERS_JSON: JSON.stringify([{
			id: 'codex-subscription',
			adapter: 'codex',
			command,
			capabilities: ['implementation', 'tool-calling', 'long-context'],
			priority: 100,
			costTier: 'low',
		}]),
	})
	const service = new WorkerService(config)
	const report = await service.delegate({
		objective: 'Create src/codex.ts.',
		repositoryPath,
		mode: 'implementation',
		allowedPaths: ['src/**'],
		prohibitedPaths: [],
		acceptanceCriteria: ['src/codex.ts exports fromCodex'],
		requiredCommands: [],
		baseRef: 'HEAD',
		maxIterations: 4,
		timeoutSeconds: 60,
		allowNetwork: false,
	})

	assert.equal(report.status, 'completed')
	assert.equal(report.provider.adapter, 'codex')
	assert.equal(report.provider.workerId, 'codex-subscription')
	assert.equal(report.provider.requestCount, 2)
	assert.equal(report.provider.estimatedCostUsd, null)
	assert.deepEqual(report.changedFiles, ['src/codex.ts'])
	assert.ok(report.patchPath)

	const application = await service.applyRun(repositoryPath, report.runId)
	assert.equal(application.applied, true)
	assert.equal(
		await readFile(path.join(repositoryPath, 'src/codex.ts'), 'utf8'),
		"export function fromCodex(): string {\n\treturn 'subscription'\n}\n",
	)
})
