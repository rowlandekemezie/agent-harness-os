import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadConfig } from '../../src/config.js'
import type {
	WorkerRunReport,
	WorkerTask,
	WorkflowTaskProvenance,
} from '../../src/domain/types.js'
import { WorkerService } from '../../src/worker/service.js'
import { createTestRepository } from '../helpers/git.js'

test('feeds a validated cumulative candidate into a fresh workflow stage', async function () {
	let requestCount = 0
	let candidateSeen = false
	const server = createServer((request, response) => {
		const chunks: Array<Buffer> = []
		request.on('data', chunk => chunks.push(Buffer.from(chunk)))
		request.on('end', () => {
			requestCount += 1
			const body = Buffer.concat(chunks).toString('utf8')
			response.setHeader('content-type', 'application/json')
			if (requestCount === 1) {
				response.end(completionWithTool('write_file', {
					path: 'src/generated.ts',
					content: "export const durable = 'ready'\n",
				}))
				return
			}
			if (requestCount === 3) {
				response.end(completionWithTool('read_file', {
					path: 'src/generated.ts',
				}))
				return
			}
			if (requestCount === 4) {
				candidateSeen = body.includes("export const durable = 'ready'")
			}
			response.end(JSON.stringify({
				choices: [{
					message: {
						role: 'assistant',
						content: requestCount === 2
							? 'Implemented the candidate.'
							: 'Reviewed the cumulative candidate.',
					},
				}],
				usage: { prompt_tokens: 10, completion_tokens: 5 },
			}))
		})
	})
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	assert.ok(address !== null && typeof address !== 'string')
	const repositoryPath = await createTestRepository()
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'workflow-candidate-'))
	const config = loadConfig({
		AGENT_HARNESS_ARTIFACT_ROOT: artifactRoot,
		AGENT_OS_WORKERS_JSON: JSON.stringify([{
			id: 'workflow-worker',
			adapter: 'openai-compatible',
			model: 'workflow-test',
			baseUrl: `http://127.0.0.1:${address.port}/v1`,
			auth: 'none',
			capabilities: [
				'implementation',
				'review',
				'tool-calling',
			],
			maxRetries: 0,
		}]),
	})
	const service = new WorkerService(config)
	const workflowProvenance: WorkflowTaskProvenance = {
		workflowId: randomUUID(),
		stage: 'implement',
		executionId: randomUUID(),
		stageContractSha256: 'c'.repeat(64),
		sourceRunId: null,
	}

	try {
		const implementation = await service.delegate({
			...task(repositoryPath, 'implementation'),
			workflowProvenance,
		})
		assert.equal(implementation.status, 'completed')
		assert.ok(implementation.patchPath)
		assert.ok(implementation.patchSha256)
		const artifactStore = (service as unknown as {
			artifactStore: {
				loadReport(artifactRoot: string, runId: string): Promise<WorkerRunReport>
			}
		}).artifactStore
		const originalLoadReport = artifactStore.loadReport.bind(artifactStore)
		let approvalReportReads = 0
		artifactStore.loadReport = async (root, runId) => {
			approvalReportReads += 1
			if (approvalReportReads > 1) {
				throw new Error('Candidate validation reread mutable report state')
			}
			return await originalLoadReport(root, runId)
		}
		await service.validateCandidateRun(
			repositoryPath,
			implementation.runId,
			implementation.baseRef,
			'implementation',
			workflowProvenance,
		)
		assert.equal(approvalReportReads, 1)
		artifactStore.loadReport = originalLoadReport
		await assert.rejects(
			service.validateCandidateRun(
				repositoryPath,
				implementation.runId,
				implementation.baseRef,
				'review',
				workflowProvenance,
			),
			hasCode('WORKFLOW_RUN_MODE_MISMATCH'),
		)
		await assert.rejects(
			service.validateCandidateRun(
				repositoryPath,
				implementation.runId,
				implementation.baseRef,
				'implementation',
				{ ...workflowProvenance, executionId: randomUUID() },
			),
			hasCode('WORKFLOW_RUN_PROVENANCE_MISMATCH'),
		)
		const originalReport = await readFile(implementation.reportPath, 'utf8')
		const forgedProvenance = {
			...workflowProvenance,
			executionId: randomUUID(),
		}
		const forgedReport = JSON.parse(originalReport) as WorkerRunReport
		forgedReport.workflowProvenance = forgedProvenance
		await writeFile(
			implementation.reportPath,
			`${JSON.stringify(forgedReport)}\n`,
		)
		await assert.rejects(
			service.validateCandidateRun(
				repositoryPath,
				implementation.runId,
				implementation.baseRef,
				'implementation',
				forgedProvenance,
			),
			hasCode('CANDIDATE_HISTORY_MISMATCH'),
		)
		await writeFile(implementation.reportPath, originalReport)
		const credentialReport = JSON.parse(originalReport) as WorkerRunReport
		credentialReport.workerSummary = 'sk-1234567890abcdef'
		await writeFile(
			implementation.reportPath,
			`${JSON.stringify(credentialReport)}\n`,
		)
		await assert.rejects(
			service.delegate({
				...task(repositoryPath, 'review'),
				candidateRunId: implementation.runId,
			}),
			hasCode('ARTIFACT_CONTAINS_SECRET'),
		)
		assert.equal(requestCount, 2)
		await writeFile(implementation.reportPath, originalReport)
		if (implementation.taskId === undefined) {
			throw new Error('Workflow implementation did not record a task ID')
		}

		const review = await service.delegate(
			{
				...task(repositoryPath, 'review'),
				candidateRunId: implementation.runId,
			},
			undefined,
			{
				runId: implementation.runId,
				taskId: implementation.taskId,
				status: 'completed',
				failureCode: null,
				mode: 'implementation',
				provenance: workflowProvenance,
			},
		)
		assert.equal(review.status, 'completed')
		assert.equal(review.patchSha256, implementation.patchSha256)
		assert.deepEqual(review.changedFiles, implementation.changedFiles)
		assert.equal(candidateSeen, true)
		await assert.rejects(access(path.join(repositoryPath, 'src/generated.ts')))
		await assert.rejects(
			service.delegate({
				...task(repositoryPath, 'review'),
				allowedPaths: ['test/**'],
				candidateRunId: implementation.runId,
			}),
			hasCode('CANDIDATE_PATCH_INVALID'),
		)
		assert.equal(requestCount, 4)

		await writeFile(
			implementation.patchPath,
			`${await readFile(implementation.patchPath, 'utf8')}\n# tampered\n`,
		)
		await assert.rejects(
			service.delegate({
				...task(repositoryPath, 'review'),
				candidateRunId: implementation.runId,
			}),
			hasCode('PATCH_INTEGRITY_FAILED'),
		)
		assert.equal(requestCount, 4)
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close(error => error === undefined ? resolve() : reject(error))
		})
	}
})

function task(repositoryPath: string, mode: WorkerTask['mode']): WorkerTask {
	return {
		objective: mode === 'implementation'
			? 'Create the bounded candidate.'
			: 'Review the bounded candidate.',
		repositoryPath,
		mode,
		allowedPaths: ['src/**'],
		prohibitedPaths: [],
		acceptanceCriteria: [],
		requiredCommands: [],
		baseRef: 'HEAD',
		maxIterations: 4,
		timeoutSeconds: 60,
		allowNetwork: false,
		routing: {
			preferredWorkerId: 'workflow-worker',
			requiredCapabilities: [],
			strategy: 'balanced',
			maxCostTier: null,
			maxLatencyTier: null,
			allowFallback: false,
			maxAttempts: 1,
		},
	}
}

function completionWithTool(name: string, input: Record<string, unknown>): string {
	return JSON.stringify({
		choices: [{
			message: {
				role: 'assistant',
				content: null,
				tool_calls: [{
					id: `call-${name}`,
					type: 'function',
					function: { name, arguments: JSON.stringify(input) },
				}],
			},
		}],
		usage: { prompt_tokens: 10, completion_tokens: 5 },
	})
}

function hasCode(code: string): (error: unknown) => boolean {
	return error => typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === code
}
