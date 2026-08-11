import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadConfig } from '../../src/config.js'
import { TaskJournal } from '../../src/artifacts/task-journal.js'
import { WorkerService } from '../../src/worker/service.js'
import { createTestRepository, runGit } from '../helpers/git.js'

async function startFakeProvider(): Promise<{
	baseUrl: string
	close(): Promise<void>
}> {
	let requestCount = 0
	const server = createServer((request, response) => {
		request.resume()
		request.on('end', () => {
			requestCount += 1
			response.setHeader('content-type', 'application/json')

			if (requestCount === 1) {
				response.end(JSON.stringify({
					choices: [{
						message: {
							role: 'assistant',
							content: null,
							tool_calls: [{
								id: 'call-write',
								type: 'function',
								function: {
									name: 'write_file',
									arguments: JSON.stringify({
										path: 'src/generated.ts',
										content: "export function generated(): string {\n\treturn 'ready'\n}\n",
									}),
								},
							}],
						},
					}],
				}))
				return
			}

			response.end(JSON.stringify({
				choices: [{
					message: {
						role: 'assistant',
						content: 'Completed the bounded implementation.',
					},
				}],
			}))
		})
	})

	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()

	if (address === null || typeof address === 'string') {
		throw new Error('Fake provider did not bind to a TCP port')
	}

	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		close: async () => await new Promise<void>((resolve, reject) => {
			server.close(error => error === undefined ? resolve() : reject(error))
		}),
	}
}

function hasHarnessCode(code: string): (error: unknown) => boolean {
	return error => typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

test('delegates in a worktree, protects patch integrity, rejects stale bases, and applies separately', async function () {
	const repositoryPath = await createTestRepository()
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-artifacts-'))
	const provider = await startFakeProvider()

	try {
		const config = loadConfig({
			QWEN_BASE_URL: provider.baseUrl,
			QWEN_API_KEY: 'test-api-key-123456',
			QWEN_MODEL: 'fake-qwen',
			AGENT_HARNESS_ARTIFACT_ROOT: artifactRoot,
			AGENT_HARNESS_EXECUTION_BACKEND: 'local',
			AGENT_HARNESS_ALLOW_UNSANDBOXED_LOCAL: 'false',
		})
		const service = new WorkerService(config)
		const report = await service.delegate({
			objective: 'Create a generated TypeScript function.',
			repositoryPath,
			mode: 'implementation',
			allowedPaths: ['src/**'],
			prohibitedPaths: [],
			acceptanceCriteria: ['src/generated.ts exports generated'],
			requiredCommands: [],
			baseRef: 'HEAD',
			maxIterations: 4,
			timeoutSeconds: 60,
			allowNetwork: false,
		})

		assert.equal(report.status, 'completed')
		assert.equal(report.schemaVersion, 2)
		assert.ok(report.taskId)
		assert.deepEqual(report.changedFiles, ['src/generated.ts'])
		assert.ok(report.patchPath)
		const originalPatch = await readFile(report.patchPath, 'utf8')
		await writeFile(report.patchPath, `${originalPatch}\n# tampered\n`)
		await assert.rejects(
			service.applyRun(repositoryPath, report.runId),
			hasHarnessCode('PATCH_INTEGRITY_FAILED'),
		)
		await writeFile(report.patchPath, originalPatch)

		await writeFile(path.join(repositoryPath, 'NEXT.md'), 'new head\n')
		await runGit(repositoryPath, ['add', 'NEXT.md'])
		await runGit(repositoryPath, ['commit', '-m', 'Advance base'])
		await assert.rejects(
			service.applyRun(repositoryPath, report.runId),
			hasHarnessCode('BASE_COMMIT_CHANGED'),
		)
		await runGit(repositoryPath, ['reset', '--hard', 'HEAD^'])

		const application = await service.applyRun(repositoryPath, report.runId)
		assert.equal(application.applied, true)
		assert.equal(application.historyRecorded, true)
		assert.equal(
			await readFile(path.join(repositoryPath, 'src/generated.ts'), 'utf8'),
			"export function generated(): string {\n\treturn 'ready'\n}\n",
		)

		const timeline = await service.getTaskTimeline(
			repositoryPath,
			report.taskId,
		)
		assert.equal(timeline.task.status, 'completed')
		assert.equal(timeline.task.patchApplicationStatus, 'applied')
		assert.deepEqual(
			timeline.events.map(event => event.type),
			[
				'TaskCreated',
				'RouteSelected',
				'WorkerStarted',
				'ToolCalled',
				'WorkerCompleted',
				'PatchProduced',
				'ValidationCompleted',
				'AttemptCompleted',
				'TaskCompleted',
				'PatchApplicationRequested',
				'PatchApplicationRejected',
				'PatchApplicationRequested',
				'PatchApplicationRejected',
				'PatchApplicationRequested',
				'PatchApproved',
				'PatchApplied',
			],
		)
	} finally {
		await provider.close()
	}
})

test('invalidates a run when deterministic validation mutates the worker patch', async function () {
	const repositoryPath = await createTestRepository()
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-validation-artifacts-'))
	const provider = await startFakeProvider()

	try {
		const config = loadConfig({
			QWEN_BASE_URL: provider.baseUrl,
			QWEN_API_KEY: 'test-api-key-123456',
			QWEN_MODEL: 'fake-qwen',
			AGENT_HARNESS_ARTIFACT_ROOT: artifactRoot,
			AGENT_HARNESS_EXECUTION_BACKEND: 'local',
			AGENT_HARNESS_ALLOW_UNSANDBOXED_LOCAL: 'true',
			AGENT_HARNESS_ALLOWED_COMMANDS: 'node',
		})
		const service = new WorkerService(config)
		const report = await service.delegate({
			objective: 'Create a generated TypeScript function.',
			repositoryPath,
			mode: 'implementation',
			allowedPaths: ['src/**'],
			prohibitedPaths: [],
			acceptanceCriteria: ['src/generated.ts exports generated'],
			requiredCommands: [
				{
					command: 'node',
					args: [
						'-e',
						"require('node:fs').appendFileSync('src/generated.ts', '// validation mutation\\n')",
					],
				},
			],
			baseRef: 'HEAD',
			maxIterations: 4,
			timeoutSeconds: 60,
			allowNetwork: true,
		})

		assert.equal(report.status, 'failed')
		assert.ok(
			report.warnings.some(warning =>
				warning.includes('Validation integrity check failed'),
			),
		)
		assert.ok(report.patchPath)
		const patch = await readFile(report.patchPath, 'utf8')
		assert.equal(patch.includes('validation mutation'), false)
		await assert.rejects(
			service.applyRun(repositoryPath, report.runId),
			hasHarnessCode('RUN_NOT_APPLICABLE'),
		)
	} finally {
		await provider.close()
	}
})

test('applies an authoritative run when its task history is corrupt', async function () {
	const repositoryPath = await createTestRepository()
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-history-corrupt-'))
	const provider = await startFakeProvider()

	try {
		const config = loadConfig({
			QWEN_BASE_URL: provider.baseUrl,
			QWEN_API_KEY: 'test-api-key-123456',
			QWEN_MODEL: 'fake-qwen',
			AGENT_HARNESS_ARTIFACT_ROOT: artifactRoot,
			AGENT_HARNESS_EXECUTION_BACKEND: 'local',
			AGENT_HARNESS_ALLOW_UNSANDBOXED_LOCAL: 'false',
		})
		const service = new WorkerService(config)
		const report = await service.delegate({
			objective: 'Create a generated TypeScript function.',
			repositoryPath,
			mode: 'implementation',
			allowedPaths: ['src/**'],
			prohibitedPaths: [],
			acceptanceCriteria: [],
			requiredCommands: [],
			baseRef: 'HEAD',
			maxIterations: 4,
			timeoutSeconds: 60,
			allowNetwork: false,
		})
		assert.ok(report.taskId)
		const effectiveRoot = path.dirname(path.dirname(report.reportPath))
		const eventDirectory = path.join(
			effectiveRoot,
			'tasks',
			report.taskId,
			'events',
		)
		const firstEvent = (await readdir(eventDirectory)).sort()[0]
		assert.ok(firstEvent)
		await writeFile(path.join(eventDirectory, firstEvent), '{corrupt\n')

		const application = await service.applyRun(repositoryPath, report.runId)
		assert.equal(application.applied, true)
		assert.equal(application.historyRecorded, false)
		assert.ok(application.warnings.some(warning =>
			warning.includes('PatchApplicationRequested'),
		))
	} finally {
		await provider.close()
	}
})

test('does not attach a forged report to another task journal', async function () {
	const repositoryPath = await createTestRepository()
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-history-link-'))
	const provider = await startFakeProvider()

	try {
		const config = loadConfig({
			QWEN_BASE_URL: provider.baseUrl,
			QWEN_API_KEY: 'test-api-key-123456',
			QWEN_MODEL: 'fake-qwen',
			AGENT_HARNESS_ARTIFACT_ROOT: artifactRoot,
			AGENT_HARNESS_EXECUTION_BACKEND: 'local',
			AGENT_HARNESS_ALLOW_UNSANDBOXED_LOCAL: 'false',
		})
		const service = new WorkerService(config)
		const report = await service.delegate({
			objective: 'Create a generated TypeScript function.',
			repositoryPath,
			mode: 'implementation',
			allowedPaths: ['src/**'],
			prohibitedPaths: [],
			acceptanceCriteria: [],
			requiredCommands: [],
			baseRef: 'HEAD',
			maxIterations: 4,
			timeoutSeconds: 60,
			allowNetwork: false,
		})
		const effectiveRoot = path.dirname(path.dirname(report.reportPath))
		const journal = new TaskJournal()
		const unrelated = await journal.create({
			artifactRoot: effectiveRoot,
			objective: 'Unrelated task',
			mode: 'review',
			repositoryPath,
			baseCommit: report.baseRef,
		})
		const storedReport = JSON.parse(
			await readFile(report.reportPath, 'utf8'),
		) as { taskId: string }
		storedReport.taskId = unrelated.taskId
		await writeFile(report.reportPath, `${JSON.stringify(storedReport)}\n`)

		const application = await service.applyRun(repositoryPath, report.runId)
		assert.equal(application.applied, true)
		assert.equal(application.historyRecorded, false)
		assert.ok(application.warnings.some(warning =>
			warning.includes('does not match the authoritative run report'),
		))
		const unrelatedTimeline = await journal.timeline(
			effectiveRoot,
			unrelated.taskId,
		)
		assert.deepEqual(
			unrelatedTimeline.events.map(event => event.type),
			['TaskCreated'],
		)
	} finally {
		await provider.close()
	}
})
