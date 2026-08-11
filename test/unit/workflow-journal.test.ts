import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, chmod, mkdtemp, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type {
	WorkflowDefinition,
	WorkflowEvent,
	WorkflowWorkerStage,
} from '../../src/domain/types.js'
import { Redactor } from '../../src/lib/redaction.js'
import {
	serializeWorkflowEvent,
	workflowEventSha256,
} from '../../src/workflow/event-model.js'
import { WorkflowJournal } from '../../src/workflow/journal.js'

test('persists and projects a complete workflow timeline', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'workflow-journal-'))
	const journal = new WorkflowJournal()
	let timeline = await journal.create(artifactRoot, definition())
	const workflowId = timeline.summary.workflowId
	const executionId = randomUUID()
	const taskId = randomUUID()
	const runId = randomUUID()

	await journal.append(artifactRoot, workflowId, {
		type: 'WorkflowStageStarted',
		data: {
			stage: 'implement',
			executionId,
			attemptNumber: 1,
			sourceRunId: null,
		},
	})
	await journal.append(artifactRoot, workflowId, {
		type: 'WorkflowStageCompleted',
		data: {
			stage: 'implement',
			executionId,
			taskId,
			runId,
			status: 'completed',
			failureCode: null,
			candidateRunId: runId,
			nextStage: 'approval',
		},
	})
	await journal.append(artifactRoot, workflowId, {
		type: 'WorkflowApprovalRequested',
		data: { candidateRunId: runId },
	})
	await journal.append(artifactRoot, workflowId, {
		type: 'WorkflowApprovalDecided',
		data: {
			decision: 'approved',
			feedback: '',
			source: 'mcp_call',
			nextStage: null,
		},
	})
	await journal.append(artifactRoot, workflowId, {
		type: 'WorkflowCompleted',
		data: { status: 'completed', failureCode: null, candidateRunId: runId },
	})

	timeline = await journal.timeline(artifactRoot, workflowId)
	assert.equal(timeline.summary.status, 'completed')
	assert.equal(timeline.summary.candidateRunId, runId)
	assert.equal(timeline.summary.approvalDecision, 'approved')
	assert.equal(timeline.summary.transitionCount, 1)
	assert.equal(timeline.events.length, 6)
	assert.match(timeline.summary.latestEventSha256, /^[a-f0-9]{64}$/)

	const page = await journal.list(artifactRoot, 10, null)
	assert.deepEqual(page.workflows.map(item => item.workflowId), [workflowId])
})

test('records interrupted stages without consuming the retry budget', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'workflow-resume-'))
	const journal = new WorkflowJournal()
	const workflowDefinition = definition()
	workflowDefinition.stages.implement.retryLimit = 0
	const created = await journal.create(artifactRoot, workflowDefinition)
	const workflowId = created.summary.workflowId
	const firstExecutionId = randomUUID()
	const secondExecutionId = randomUUID()
	await journal.append(artifactRoot, workflowId, {
		type: 'WorkflowStageStarted',
		data: {
			stage: 'implement',
			executionId: firstExecutionId,
			attemptNumber: 1,
			sourceRunId: null,
		},
	})
	await journal.append(artifactRoot, workflowId, {
		type: 'WorkflowStageInterrupted',
		data: {
			stage: 'implement',
			executionId: firstExecutionId,
			reason: 'resume',
		},
	})
	await journal.append(artifactRoot, workflowId, {
		type: 'WorkflowStageStarted',
		data: {
			stage: 'implement',
			executionId: secondExecutionId,
			attemptNumber: 2,
			sourceRunId: null,
		},
	})

	const timeline = await journal.timeline(artifactRoot, workflowId)
	assert.equal(timeline.summary.stageAttempts.implement, 2)
	assert.equal(timeline.summary.transitionCount, 2)
	await journal.append(artifactRoot, workflowId, {
		type: 'WorkflowStageInterrupted',
		data: {
			stage: 'implement',
			executionId: secondExecutionId,
			reason: 'resume',
		},
	})
	await journal.append(artifactRoot, workflowId, {
		type: 'WorkflowStageStarted',
		data: {
			stage: 'implement',
			executionId: randomUUID(),
			attemptNumber: 3,
			sourceRunId: null,
		},
	})
	const resumed = await journal.timeline(artifactRoot, workflowId)
	assert.equal(resumed.summary.stageAttempts.implement, 3)
})

test('rejects completed stage evidence without a worker task and run', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'workflow-evidence-'))
	const journal = new WorkflowJournal()
	const created = await journal.create(artifactRoot, definition())
	const executionId = randomUUID()
	await journal.append(artifactRoot, created.summary.workflowId, {
		type: 'WorkflowStageStarted',
		data: {
			stage: 'implement',
			executionId,
			attemptNumber: 1,
			sourceRunId: null,
		},
	})

	await assert.rejects(
		journal.append(artifactRoot, created.summary.workflowId, {
			type: 'WorkflowStageCompleted',
			data: {
				stage: 'implement',
				executionId,
				taskId: null,
				runId: null,
				status: 'completed',
				failureCode: null,
				candidateRunId: randomUUID(),
				nextStage: 'approval',
			},
		}),
		hasCode('INVALID_WORKFLOW_TRANSITION'),
	)
})

test('rejects failed patch promotion into a retry stage', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'workflow-retry-'))
	const journal = new WorkflowJournal()
	const workflowDefinition = definition()
	workflowDefinition.stages.test = {
		...stage(),
		objective: 'Test the candidate.',
	}
	const created = await journal.create(artifactRoot, workflowDefinition)
	const implementationExecutionId = randomUUID()
	const implementationRunId = randomUUID()
	await journal.append(artifactRoot, created.summary.workflowId, {
		type: 'WorkflowStageStarted',
		data: {
			stage: 'implement',
			executionId: implementationExecutionId,
			attemptNumber: 1,
			sourceRunId: null,
		},
	})
	await journal.append(artifactRoot, created.summary.workflowId, {
		type: 'WorkflowStageCompleted',
		data: {
			stage: 'implement',
			executionId: implementationExecutionId,
			taskId: randomUUID(),
			runId: implementationRunId,
			status: 'completed',
			failureCode: null,
			candidateRunId: implementationRunId,
			nextStage: 'test',
		},
	})
	const testExecutionId = randomUUID()
	await journal.append(artifactRoot, created.summary.workflowId, {
		type: 'WorkflowStageStarted',
		data: {
			stage: 'test',
			executionId: testExecutionId,
			attemptNumber: 1,
			sourceRunId: implementationRunId,
		},
	})
	const failedRunId = randomUUID()

	await assert.rejects(
		journal.append(artifactRoot, created.summary.workflowId, {
			type: 'WorkflowStageCompleted',
			data: {
				stage: 'test',
				executionId: testExecutionId,
				taskId: randomUUID(),
				runId: failedRunId,
				status: 'failed',
				failureCode: 'EVALUATION_FAILED',
				candidateRunId: failedRunId,
				nextStage: 'test',
			},
		}),
		hasCode('INVALID_WORKFLOW_TRANSITION'),
	)
})

test('rejects demoting a successful verification run to its input candidate', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'workflow-demotion-'))
	const journal = new WorkflowJournal()
	const workflowDefinition = definition()
	workflowDefinition.stages.test = {
		...stage(),
		objective: 'Test the candidate.',
	}
	const created = await journal.create(artifactRoot, workflowDefinition)
	const implementationExecutionId = randomUUID()
	const implementationRunId = randomUUID()
	await journal.append(artifactRoot, created.summary.workflowId, {
		type: 'WorkflowStageStarted',
		data: {
			stage: 'implement',
			executionId: implementationExecutionId,
			attemptNumber: 1,
			sourceRunId: null,
		},
	})
	await journal.append(artifactRoot, created.summary.workflowId, {
		type: 'WorkflowStageCompleted',
		data: {
			stage: 'implement',
			executionId: implementationExecutionId,
			taskId: randomUUID(),
			runId: implementationRunId,
			status: 'completed',
			failureCode: null,
			candidateRunId: implementationRunId,
			nextStage: 'test',
		},
	})
	const testExecutionId = randomUUID()
	await journal.append(artifactRoot, created.summary.workflowId, {
		type: 'WorkflowStageStarted',
		data: {
			stage: 'test',
			executionId: testExecutionId,
			attemptNumber: 1,
			sourceRunId: implementationRunId,
		},
	})

	await assert.rejects(
		journal.append(artifactRoot, created.summary.workflowId, {
			type: 'WorkflowStageCompleted',
			data: {
				stage: 'test',
				executionId: testExecutionId,
				taskId: randomUUID(),
				runId: randomUUID(),
				status: 'completed',
				failureCode: null,
				candidateRunId: implementationRunId,
				nextStage: 'approval',
			},
		}),
		hasCode('INVALID_WORKFLOW_TRANSITION'),
	)
})

test('rejects repair transitions without a validated candidate run', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'workflow-repair-'))
	const journal = new WorkflowJournal()
	const workflowDefinition = definition()
	workflowDefinition.stages.repair = {
		...stage(),
		objective: 'Repair the candidate.',
		retryLimit: 0,
	}
	workflowDefinition.maxRepairAttempts = 1
	const created = await journal.create(artifactRoot, workflowDefinition)
	const executionId = randomUUID()
	await journal.append(artifactRoot, created.summary.workflowId, {
		type: 'WorkflowStageStarted',
		data: {
			stage: 'implement',
			executionId,
			attemptNumber: 1,
			sourceRunId: null,
		},
	})

	await assert.rejects(
		journal.append(artifactRoot, created.summary.workflowId, {
			type: 'WorkflowStageCompleted',
			data: {
				stage: 'implement',
				executionId,
				taskId: null,
				runId: null,
				status: 'failed',
				failureCode: 'EVALUATION_FAILED',
				candidateRunId: null,
				nextStage: 'repair',
			},
		}),
		hasCode('INVALID_WORKFLOW_TRANSITION'),
	)
})

test('rejects repair transitions without failed-run patch evidence', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'workflow-repair-evidence-'))
	const journal = new WorkflowJournal()
	const ready = await createRepairReadyWorkflow(journal, artifactRoot, 2)
	const executionId = randomUUID()
	await journal.append(artifactRoot, ready.workflowId, {
		type: 'WorkflowStageStarted',
		data: {
			stage: 'repair',
			executionId,
			attemptNumber: 1,
			sourceRunId: ready.candidateRunId,
		},
	})

	await assert.rejects(
		journal.append(artifactRoot, ready.workflowId, {
			type: 'WorkflowStageCompleted',
			data: {
				stage: 'repair',
				executionId,
				taskId: null,
				runId: null,
				status: 'failed',
				failureCode: 'EVALUATION_FAILED',
				candidateRunId: ready.candidateRunId,
				nextStage: 'repair',
			},
		}),
		hasCode('INVALID_WORKFLOW_TRANSITION'),
	)
})

test('allows bounded repair attempts to consume retained failed patches', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'workflow-repair-loop-'))
	const journal = new WorkflowJournal()
	const ready = await createRepairReadyWorkflow(journal, artifactRoot, 2)
	const firstExecutionId = randomUUID()
	await journal.append(artifactRoot, ready.workflowId, {
		type: 'WorkflowStageStarted',
		data: {
			stage: 'repair',
			executionId: firstExecutionId,
			attemptNumber: 1,
			sourceRunId: ready.candidateRunId,
		},
	})
	const retainedRunId = randomUUID()
	await journal.append(artifactRoot, ready.workflowId, {
		type: 'WorkflowStageCompleted',
		data: {
			stage: 'repair',
			executionId: firstExecutionId,
			taskId: randomUUID(),
			runId: retainedRunId,
			status: 'failed',
			failureCode: 'EVALUATION_FAILED',
			candidateRunId: retainedRunId,
			nextStage: 'repair',
		},
	})
	await journal.append(artifactRoot, ready.workflowId, {
		type: 'WorkflowStageStarted',
		data: {
			stage: 'repair',
			executionId: randomUUID(),
			attemptNumber: 2,
			sourceRunId: retainedRunId,
		},
	})

	const timeline = await journal.timeline(artifactRoot, ready.workflowId)
	assert.equal(timeline.summary.currentStage, 'repair')
	assert.equal(timeline.summary.candidateRunId, retainedRunId)
	assert.equal(timeline.summary.stageAttempts.repair, 2)
})

test('fails closed on tampered events and unsafe read permissions', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'workflow-hostile-'))
	const journal = new WorkflowJournal()
	const created = await journal.create(artifactRoot, definition())
	const workflowId = created.summary.workflowId
	const eventsDirectory = path.join(
		artifactRoot,
		'workflows',
		workflowId,
		'events',
	)
	const [eventName] = await readdir(eventsDirectory)
	assert.ok(eventName)
	const eventPath = path.join(eventsDirectory, eventName)
	const original = await readFile(eventPath)
	await writeFile(eventPath, Buffer.from(original).fill(0x20, 1, 2))
	await assert.rejects(
		journal.timeline(artifactRoot, workflowId),
		hasCode('INVALID_WORKFLOW_JOURNAL'),
	)
	await writeFile(eventPath, original)

	await chmod(eventsDirectory, 0o750)
	await assert.rejects(
		journal.timeline(artifactRoot, workflowId),
		hasCode('ARTIFACT_PERMISSIONS_INVALID'),
	)
	assert.equal((await stat(eventsDirectory)).mode & 0o777, 0o750)
})

test('rejects credential material instead of transforming workflow events', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'workflow-secret-'))
	const secret = 'workflow-"secret\\value'
	const journal = new WorkflowJournal(new Redactor(
		{ REVIEW_API_KEY: secret },
		[],
	))
	const unsafeDefinition = definition()
	unsafeDefinition.objective = `Persist ${secret}`
	await assert.rejects(
		journal.create(artifactRoot, unsafeDefinition),
		hasCode('WORKFLOW_CONTAINS_SECRET'),
	)
	const created = await journal.create(artifactRoot, definition())

	await assert.rejects(
		journal.append(artifactRoot, created.summary.workflowId, {
			type: 'WorkflowDependencyStateChanged',
			data: { state: 'waiting' },
		}),
		hasCode('INVALID_WORKFLOW_TRANSITION'),
	)
	const executionId = randomUUID()
	const runId = randomUUID()
	await journal.append(artifactRoot, created.summary.workflowId, {
		type: 'WorkflowStageStarted',
		data: {
			stage: 'implement',
			executionId,
			attemptNumber: 1,
			sourceRunId: null,
		},
	})
	await journal.append(artifactRoot, created.summary.workflowId, {
		type: 'WorkflowStageCompleted',
		data: {
			stage: 'implement',
			executionId,
			taskId: randomUUID(),
			runId,
			status: 'completed',
			failureCode: null,
			candidateRunId: runId,
			nextStage: 'approval',
		},
	})
	await journal.append(artifactRoot, created.summary.workflowId, {
		type: 'WorkflowApprovalRequested',
		data: { candidateRunId: runId },
	})
	await assert.rejects(
		journal.append(artifactRoot, created.summary.workflowId, {
			type: 'WorkflowApprovalDecided',
			data: {
				decision: 'rejected',
				feedback: '🙂'.repeat(2_000),
				source: 'mcp_call',
				nextStage: null,
			},
		}),
		hasCode('INVALID_WORKFLOW_JOURNAL'),
	)
	await assert.rejects(
		journal.append(artifactRoot, created.summary.workflowId, {
			type: 'WorkflowApprovalDecided',
			data: {
				decision: 'rejected',
				feedback: secret,
				source: 'mcp_call',
				nextStage: null,
			},
		}),
		hasCode('WORKFLOW_CONTAINS_SECRET'),
	)
	assert.equal(
		(await journal.timeline(artifactRoot, created.summary.workflowId)).events.length,
		4,
	)
	await journal.append(artifactRoot, created.summary.workflowId, {
		type: 'WorkflowApprovalDecided',
		data: {
			decision: 'rejected',
			feedback: 'Needs revision.',
			source: 'mcp_call',
			nextStage: null,
		},
	})
	const eventsDirectory = path.join(
		artifactRoot,
		'workflows',
		created.summary.workflowId,
		'events',
	)
	const eventName = (await readdir(eventsDirectory)).find(name =>
		name.startsWith('000000000005-')
	)
	assert.ok(eventName)
	const eventPath = path.join(eventsDirectory, eventName)
	const event = JSON.parse(await readFile(eventPath, 'utf8')) as WorkflowEvent
	assert.equal(event.type, 'WorkflowApprovalDecided')
	if (event.type !== 'WorkflowApprovalDecided') {
		throw new Error('Expected an approval decision event')
	}
	event.data.feedback = secret
	const serializedEvent = serializeWorkflowEvent(event)
	const tamperedName = `000000000005-${workflowEventSha256(serializedEvent)}.json`
	await writeFile(eventPath, serializedEvent)
	await rename(eventPath, path.join(eventsDirectory, tamperedName))
	await assert.rejects(
		journal.timeline(artifactRoot, created.summary.workflowId),
		hasCode('WORKFLOW_CONTAINS_SECRET'),
	)
})

test('rejects an oversized definition before creating workflow artifacts', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'workflow-oversize-'))
	const journal = new WorkflowJournal()
	const oversized = definition()
	oversized.stages.implement.allowedPaths = Array.from(
		{ length: 100 },
		(_value, index) => `src/${String(index).padStart(3, '0')}-${'a'.repeat(990)}`,
	)

	await assert.rejects(
		journal.create(artifactRoot, oversized),
		hasCode('WORKFLOW_EVENT_LIMIT'),
	)
	await assert.rejects(
		access(path.join(artifactRoot, 'workflows')),
		hasCode('ENOENT'),
	)
})

function definition(): WorkflowDefinition {
	return {
		schemaVersion: 1,
		objective: 'Implement a durable workflow.',
		repositoryPath: '/tmp/workflow-repository',
		baseCommit: 'a'.repeat(40),
		deadlineAt: new Date(Date.now() + 60_000).toISOString(),
		maxTransitions: 8,
		maxRepairAttempts: 0,
		dependencyWorkflowIds: [],
		stages: {
			plan: null,
			implement: stage(),
			test: null,
			review: null,
			repair: null,
		},
	}
}

async function createRepairReadyWorkflow(
	journal: WorkflowJournal,
	artifactRoot: string,
	maxRepairAttempts: number,
): Promise<{ workflowId: string, candidateRunId: string }> {
	const workflowDefinition = definition()
	workflowDefinition.stages.repair = {
		...stage(),
		objective: 'Repair the candidate.',
		retryLimit: 0,
	}
	workflowDefinition.maxRepairAttempts = maxRepairAttempts
	const created = await journal.create(artifactRoot, workflowDefinition)
	const executionId = randomUUID()
	const candidateRunId = randomUUID()
	await journal.append(artifactRoot, created.summary.workflowId, {
		type: 'WorkflowStageStarted',
		data: {
			stage: 'implement',
			executionId,
			attemptNumber: 1,
			sourceRunId: null,
		},
	})
	await journal.append(artifactRoot, created.summary.workflowId, {
		type: 'WorkflowStageCompleted',
		data: {
			stage: 'implement',
			executionId,
			taskId: randomUUID(),
			runId: candidateRunId,
			status: 'completed',
			failureCode: null,
			candidateRunId,
			nextStage: 'approval',
		},
	})
	await journal.append(artifactRoot, created.summary.workflowId, {
		type: 'WorkflowApprovalRequested',
		data: { candidateRunId },
	})
	await journal.append(artifactRoot, created.summary.workflowId, {
		type: 'WorkflowApprovalDecided',
		data: {
			decision: 'rejected',
			feedback: 'Repair the failed candidate.',
			source: 'mcp_call',
			nextStage: 'repair',
		},
	})
	return { workflowId: created.summary.workflowId, candidateRunId }
}

function stage(): WorkflowWorkerStage {
	return {
		objective: 'Implement the change.',
		allowedPaths: ['src/**'],
		prohibitedPaths: [],
		acceptanceCriteria: [],
		requiredCommands: [],
		maxIterations: 8,
		timeoutSeconds: 60,
		allowNetwork: false,
		routing: {
			preferredWorkerId: null,
			requiredCapabilities: [],
			strategy: 'balanced',
			maxCostTier: null,
			maxLatencyTier: null,
			allowFallback: true,
			maxAttempts: 2,
		},
		retryLimit: 1,
	}
}

function hasCode(code: string): (error: unknown) => boolean {
	return error => typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === code
}
