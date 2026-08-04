import assert from 'node:assert/strict'
import { link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ArtifactStore } from '../../src/artifacts/store.js'
import { Redactor } from '../../src/lib/redaction.js'
import type { WorkerRunReport } from '../../src/domain/types.js'


function createReport(runId: string): WorkerRunReport {
	return {
		schemaVersion: 1,
		runId,
		status: 'completed',
		objective: 'test',
		mode: 'implementation',
		repositoryPath: '/tmp/repo',
		baseRef: 'abc',
		startedAt: new Date(0).toISOString(),
		completedAt: new Date(1).toISOString(),
		durationMs: 1,
		workerSummary: 'done',
		changedFiles: ['file.txt'],
		patchPath: null,
		patchSha256: null,
		reportPath: '',
		commandResults: [],
		acceptanceCriteria: [],
		policyViolations: [],
		warnings: [],
		provider: { baseUrl: 'http://provider', model: 'qwen', requestCount: 1 },
	}
}

test('persists an exact patch while redacting the transcript', async function () {
	const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-store-'))
	const patch = 'diff --git a/token.txt b/token.txt\n+sk-1234567890abcdef\n'
	const report: WorkerRunReport = {
		schemaVersion: 1,
		runId: '11111111-1111-4111-8111-111111111111',
		status: 'completed',
		objective: 'test',
		mode: 'implementation',
		repositoryPath: '/tmp/repo',
		baseRef: 'abc',
		startedAt: new Date(0).toISOString(),
		completedAt: new Date(1).toISOString(),
		durationMs: 1,
		workerSummary: 'done custom-provider-secret',
		changedFiles: ['token.txt'],
		patchPath: null,
		patchSha256: null,
		reportPath: '',
		commandResults: [],
		acceptanceCriteria: [],
		policyViolations: [],
		warnings: [],
		provider: { baseUrl: 'http://provider', model: 'qwen', requestCount: 1 },
	}
	const store = new ArtifactStore(
		new Redactor({}, ['custom-provider-secret']),
	)
	const persisted = await store.persist({
		artifactRoot: root,
		report,
		patch,
		workerTranscript: 'Bearer abcdefghijklmnop',
	})

	assert.ok(persisted.patchPath)
	assert.equal(persisted.workerSummary.includes('custom-provider-secret'), false)
	assert.equal(await readFile(persisted.patchPath, 'utf8'), patch)
	const transcript = await readFile(path.join(root, report.runId, 'worker-transcript.txt'), 'utf8')
	assert.equal(transcript.includes('abcdefghijklmnop'), false)
})


test('rejects a patch artifact replaced by a symbolic link', async function () {
	const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-store-link-'))
	const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'artifact-store-outside-'))
	const outsidePatch = path.join(outsideRoot, 'changes.patch')
	await writeFile(outsidePatch, 'malicious patch', 'utf8')
	const report: WorkerRunReport = {
		schemaVersion: 1,
		runId: '22222222-2222-4222-8222-222222222222',
		status: 'completed',
		objective: 'test',
		mode: 'implementation',
		repositoryPath: '/tmp/repo',
		baseRef: 'abc',
		startedAt: new Date(0).toISOString(),
		completedAt: new Date(1).toISOString(),
		durationMs: 1,
		workerSummary: 'done',
		changedFiles: ['file.txt'],
		patchPath: null,
		patchSha256: null,
		reportPath: '',
		commandResults: [],
		acceptanceCriteria: [],
		policyViolations: [],
		warnings: [],
		provider: { baseUrl: 'http://provider', model: 'qwen', requestCount: 1 },
	}
	const store = new ArtifactStore()
	const persisted = await store.persist({
		artifactRoot: root,
		report,
		patch: 'original patch',
		workerTranscript: '',
	})

	assert.ok(persisted.patchPath)
	await rm(persisted.patchPath)
	await symlink(outsidePatch, persisted.patchPath)

	await assert.rejects(
		store.loadPatch(root, persisted),
		(error: unknown) =>
			error instanceof Error && error.message.includes('symbolic link'),
	)
})



test('rejects a patch artifact replaced by a hard link', async function () {
	const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-store-hard-link-'))
	const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'artifact-store-hard-link-outside-'))
	const outsidePatch = path.join(outsideRoot, 'changes.patch')
	await writeFile(outsidePatch, 'hard-linked patch', 'utf8')
	const report = createReport('44444444-4444-4444-8444-444444444444')
	const store = new ArtifactStore()
	const persisted = await store.persist({
		artifactRoot: root,
		report,
		patch: 'original patch',
		workerTranscript: '',
	})

	assert.ok(persisted.patchPath)
	await rm(persisted.patchPath)
	await link(outsidePatch, persisted.patchPath)

	await assert.rejects(
		store.loadPatch(root, persisted),
		(error: unknown) =>
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'ARTIFACT_HARD_LINK_DENIED',
	)
})

test('bounds persisted report reads', async function () {
	const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-store-large-report-'))
	const report = createReport('55555555-5555-4555-8555-555555555555')
	const store = new ArtifactStore()
	const persisted = await store.persist({
		artifactRoot: root,
		report,
		patch: '',
		workerTranscript: '',
	})
	await writeFile(persisted.reportPath, 'x'.repeat(4_194_305), 'utf8')

	await assert.rejects(
		store.loadReport(root, report.runId),
		(error: unknown) =>
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'ARTIFACT_FILE_TOO_LARGE',
	)
})

test('rejects a corrupted run report as invalid rather than missing', async function () {
	const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-store-corrupt-'))
	const report: WorkerRunReport = {
		schemaVersion: 1,
		runId: '33333333-3333-4333-8333-333333333333',
		status: 'completed',
		objective: 'test',
		mode: 'research',
		repositoryPath: '/tmp/repo',
		baseRef: 'abc',
		startedAt: new Date(0).toISOString(),
		completedAt: new Date(1).toISOString(),
		durationMs: 1,
		workerSummary: 'done',
		changedFiles: [],
		patchPath: null,
		patchSha256: null,
		reportPath: '',
		commandResults: [],
		acceptanceCriteria: [],
		policyViolations: [],
		warnings: [],
		provider: { baseUrl: 'http://provider', model: 'qwen', requestCount: 1 },
	}
	const store = new ArtifactStore()
	const persisted = await store.persist({
		artifactRoot: root,
		report,
		patch: '',
		workerTranscript: '',
	})
	await writeFile(persisted.reportPath, '{invalid json', 'utf8')

	await assert.rejects(
		store.loadReport(root, report.runId),
		(error: unknown) =>
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'INVALID_RUN_REPORT',
	)
})
