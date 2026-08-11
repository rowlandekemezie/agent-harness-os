import assert from 'node:assert/strict'
import { access, link, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ArtifactStore } from '../../src/artifacts/store.js'
import { Redactor } from '../../src/lib/redaction.js'
import type { EvaluationSummary, WorkerRunReport } from '../../src/domain/types.js'
import { deterministicEvaluationDimensionIds } from '../../src/evaluation/dimensions.js'


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
		provider: {
			workerId: 'qwen',
			adapter: 'openai-compatible',
			baseUrl: 'http://provider',
			model: 'qwen',
			requestCount: 1,
		},
	}
}

function createEvaluationSummary(secret = 'deterministic evidence'): EvaluationSummary {
	const evaluatedAt = new Date(2).toISOString()
	return {
		schemaVersion: 1,
		evaluatedAt,
		outcome: 'passed',
		results: [{
			schemaVersion: 1,
			evaluatorId: 'deterministic-v1',
			evaluatorKind: 'deterministic',
			evaluatedAt,
			outcome: 'passed',
			dimensions: deterministicEvaluationDimensionIds.map(id => ({
				id,
				status: 'passed',
				summary: secret,
				evidence: [secret],
			})),
		}],
	}
}

function hasHarnessCode(code: string): (error: unknown) => boolean {
	return error => typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === code
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

test('rejects a run directory replaced by a symbolic link', async function () {
	const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-store-directory-'))
	const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'artifact-store-outside-'))
	const report = createReport('77777777-7777-4777-8777-777777777777')
	const store = new ArtifactStore()
	await store.persist({
		artifactRoot: root,
		report,
		patch: 'candidate',
		workerTranscript: '',
	})
	const runPath = path.join(root, report.runId)
	const outsideRunPath = path.join(outsideRoot, report.runId)
	await rename(runPath, outsideRunPath)
	await symlink(outsideRunPath, runPath)

	await assert.rejects(
		store.loadReport(root, report.runId),
		(error: unknown) =>
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'ARTIFACT_PATH_INVALID',
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

test('requires a task ID on version 2 run reports', async function () {
	const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-store-task-id-'))
	const report: WorkerRunReport = {
		...createReport('66666666-6666-4666-8666-666666666666'),
		schemaVersion: 2,
		taskId: '77777777-7777-4777-8777-777777777777',
	}
	const store = new ArtifactStore()
	const persisted = await store.persist({
		artifactRoot: root,
		report,
		patch: 'candidate',
		workerTranscript: '',
	})
	const value = JSON.parse(await readFile(persisted.reportPath, 'utf8')) as {
		taskId?: string
	}
	delete value.taskId
	await writeFile(persisted.reportPath, `${JSON.stringify(value)}\n`, 'utf8')

	await assert.rejects(
		store.loadReport(root, report.runId),
		(error: unknown) =>
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'INVALID_RUN_REPORT',
	)
})

test('requires a valid evaluation summary on version 3 run reports', async function () {
	const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-store-evaluation-'))
	const report: WorkerRunReport = {
		...createReport('12121212-1212-4121-8121-121212121212'),
		schemaVersion: 3,
		taskId: '34343434-3434-4343-8343-343434343434',
		evaluation: createEvaluationSummary(),
	}
	const store = new ArtifactStore()
	const persisted = await store.persist({
		artifactRoot: root,
		report,
		patch: '',
		workerTranscript: '',
	})
	const value = JSON.parse(await readFile(persisted.reportPath, 'utf8')) as {
		evaluation?: { unexpected?: boolean }
	}
	if (value.evaluation === undefined) {
		throw new Error('Persisted report did not include evaluation evidence')
	}
	value.evaluation.unexpected = true
	await writeFile(persisted.reportPath, `${JSON.stringify(value)}\n`, 'utf8')

	await assert.rejects(
		store.loadReport(root, report.runId),
		hasHarnessCode('INVALID_RUN_REPORT'),
	)
})

test('requires worker identity on version 3 run reports', async function () {
	const cases = [
		{
			runId: '23232323-2323-4232-8232-232323232323',
			field: 'workerId',
		},
		{
			runId: '45454545-4545-4454-8454-454545454545',
			field: 'adapter',
		},
	] as const

	for (const testCase of cases) {
		const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-store-identity-'))
		const report: WorkerRunReport = {
			...createReport(testCase.runId),
			schemaVersion: 3,
			taskId: '67676767-6767-4676-8676-676767676767',
			evaluation: createEvaluationSummary(),
		}
		delete report.provider[testCase.field]

		await assert.rejects(
			new ArtifactStore().persist({
				artifactRoot: root,
				report,
				patch: '',
				workerTranscript: '',
			}),
			hasHarnessCode('INVALID_RUN_REPORT'),
		)
	}
})

test('rejects a completed version 3 report with a failed evaluation', async function () {
	const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-store-evaluation-status-'))
	const report: WorkerRunReport = {
		...createReport('90909090-9090-4909-8909-909090909090'),
		schemaVersion: 3,
		taskId: 'abababab-abab-4bab-8bab-abababababab',
		evaluation: createEvaluationSummary(),
	}
	const store = new ArtifactStore()
	const persisted = await store.persist({
		artifactRoot: root,
		report,
		patch: '',
		workerTranscript: '',
	})
	const value = JSON.parse(await readFile(persisted.reportPath, 'utf8')) as {
		evaluation: EvaluationSummary
	}
	value.evaluation.outcome = 'failed'
	value.evaluation.results[0]!.outcome = 'failed'
	value.evaluation.results[0]!.dimensions[0]!.status = 'failed'
	await writeFile(persisted.reportPath, `${JSON.stringify(value)}\n`, 'utf8')

	await assert.rejects(
		store.loadReport(root, report.runId),
		hasHarnessCode('INVALID_RUN_REPORT'),
	)
})

test('binds strict-profile rejection to an inconclusive evaluation', async function () {
	const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-store-profile-policy-'))
	const evaluation = createEvaluationSummary()
	evaluation.outcome = 'inconclusive'
	evaluation.results[0]!.outcome = 'inconclusive'
	evaluation.results[0]!.dimensions[0]!.status = 'unknown'
	const report: WorkerRunReport = {
		...createReport('45454545-4545-4454-8454-454545454545'),
		schemaVersion: 3,
		taskId: '56565656-5656-4565-8565-565656565656',
		status: 'failed',
		failureCode: 'EVALUATION_INCONCLUSIVE',
		evaluation,
		provider: {
			workerId: 'strict-implementation',
			adapter: 'openai-compatible',
			baseUrl: 'http://provider',
			model: 'qwen',
			requestCount: 1,
			profile: {
				backingWorkerId: 'qwen',
				role: 'implementation',
				maxIterations: 20,
				evaluationPolicy: 'strict',
			},
		},
	}
	const store = new ArtifactStore()
	const persisted = await store.persist({
		artifactRoot: root,
		report,
		patch: '',
		workerTranscript: '',
	})
	const value = JSON.parse(await readFile(persisted.reportPath, 'utf8')) as {
		status: string
		failureCode: string | null
		provider: { profile: { evaluationPolicy: string } }
	}
	value.status = 'completed'
	value.failureCode = null
	await writeFile(persisted.reportPath, `${JSON.stringify(value)}\n`, 'utf8')
	await assert.rejects(
		store.loadReport(root, report.runId),
		hasHarnessCode('INVALID_RUN_REPORT'),
	)

	value.status = 'failed'
	value.failureCode = 'EVALUATION_INCONCLUSIVE'
	value.provider.profile.evaluationPolicy = 'default'
	await writeFile(persisted.reportPath, `${JSON.stringify(value)}\n`, 'utf8')

	await assert.rejects(
		store.loadReport(root, report.runId),
		hasHarnessCode('INVALID_RUN_REPORT'),
	)
})

test('redacts evaluator summaries and evidence before persistence', async function () {
	const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-store-evaluation-redact-'))
	const secret = 'private-evaluator-secret'
	const report: WorkerRunReport = {
		...createReport('56565656-5656-4565-8565-565656565656'),
		schemaVersion: 3,
		taskId: '78787878-7878-4787-8787-787878787878',
		evaluation: createEvaluationSummary(secret),
	}
	const store = new ArtifactStore(new Redactor({}, [secret]))
	const persisted = await store.persist({
		artifactRoot: root,
		report,
		patch: '',
		workerTranscript: '',
	})
	const contents = await readFile(persisted.reportPath, 'utf8')

	assert.equal(contents.includes(secret), false)
	assert.equal(contents.includes('[REDACTED]'), true)
})

test('rebounds evaluation evidence after redaction expansion', async function () {
	const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-store-redaction-bound-'))
	const secret = 'secret'
	const expandedEvidence = secret.repeat(166)
	const report: WorkerRunReport = {
		...createReport('cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd'),
		schemaVersion: 3,
		taskId: 'efefefef-efef-4fef-8fef-efefefefefef',
		evaluation: createEvaluationSummary(expandedEvidence),
	}
	const store = new ArtifactStore(new Redactor({}, [secret]))

	const persisted = await store.persist({
		artifactRoot: root,
		report,
		patch: '',
		workerTranscript: '',
	})
	const loaded = await store.loadReport(root, report.runId)
	const evidence = loaded.evaluation?.results[0]?.dimensions[0]?.evidence[0]

	assert.ok(evidence)
	assert.equal(evidence.includes(secret), false)
	assert.equal(Buffer.byteLength(evidence, 'utf8') <= 1_000, true)
	assert.equal(persisted.reportPath, loaded.reportPath)
})

test('rejects an oversized final report before publication', async function () {
	const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-store-report-bound-'))
	const report: WorkerRunReport = {
		...createReport('10101010-1010-4101-8101-101010101010'),
		workerSummary: 'x'.repeat(4_194_304),
	}
	const store = new ArtifactStore()

	await assert.rejects(
		store.persist({
			artifactRoot: root,
			report,
			patch: '',
			workerTranscript: '',
		}),
		hasHarnessCode('ARTIFACT_FILE_TOO_LARGE'),
	)
	await assert.rejects(access(path.join(root, report.runId)))
})

test('rejects a report whose run ID does not match its artifact directory', async function () {
	const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-store-run-link-'))
	const report = createReport('88888888-8888-4888-8888-888888888888')
	const store = new ArtifactStore()
	const persisted = await store.persist({
		artifactRoot: root,
		report,
		patch: '',
		workerTranscript: '',
	})
	const value = JSON.parse(await readFile(persisted.reportPath, 'utf8')) as {
		runId: string
	}
	value.runId = '99999999-9999-4999-8999-999999999999'
	await writeFile(persisted.reportPath, `${JSON.stringify(value)}\n`, 'utf8')

	await assert.rejects(
		store.loadReport(root, report.runId),
		(error: unknown) =>
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'INVALID_RUN_REPORT',
	)
})

test('rejects unrecognized fields in a persisted run report', async function () {
	const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-store-extra-field-'))
	const report = createReport('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
	const store = new ArtifactStore()
	const persisted = await store.persist({
		artifactRoot: root,
		report,
		patch: '',
		workerTranscript: '',
	})
	const value = JSON.parse(await readFile(persisted.reportPath, 'utf8')) as
		Record<string, unknown>
	value['providerResponse'] = { secret: 'must-not-escape' }
	await writeFile(persisted.reportPath, `${JSON.stringify(value)}\n`, 'utf8')

	await assert.rejects(
		store.loadReport(root, report.runId),
		(error: unknown) =>
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'INVALID_RUN_REPORT',
	)
})

test('rejects a run-directory collision without changing prior artifacts', async function () {
	const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-store-collision-'))
	const report = createReport('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
	const store = new ArtifactStore()
	const persisted = await store.persist({
		artifactRoot: root,
		report,
		patch: 'original patch',
		workerTranscript: 'original transcript',
	})

	await assert.rejects(
		store.persist({
			artifactRoot: root,
			report,
			patch: 'replacement patch',
			workerTranscript: 'replacement transcript',
		}),
		(error: unknown) =>
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'ARTIFACT_RUN_COLLISION',
	)
	assert.ok(persisted.patchPath)
	assert.equal(await readFile(persisted.patchPath, 'utf8'), 'original patch')
})
