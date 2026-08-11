import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import {
	chmod,
	link,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	symlink,
	unlink,
	writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { TaskJournal } from '../../src/artifacts/task-journal.js'

async function createTask(
	journal: TaskJournal,
	artifactRoot: string,
	objective: string,
) {
	return await journal.create({
		artifactRoot,
		objective,
		mode: 'implementation',
		repositoryPath: '/tmp/repository',
		baseCommit: 'a'.repeat(40),
	})
}

async function getEventPath(
	artifactRoot: string,
	taskId: string,
	sequence: number,
): Promise<string> {
	const eventsDirectory = path.join(artifactRoot, 'tasks', taskId, 'events')
	const prefix = `${String(sequence).padStart(12, '0')}-`
	const names = await readdir(eventsDirectory)
	const name = names.find(candidate => candidate.startsWith(prefix))
	assert.ok(name)
	return path.join(eventsDirectory, name)
}

function hasHarnessCode(code: string): (error: unknown) => boolean {
	return error =>
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === code
}

test('persists and projects an append-only task timeline', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'task-journal-'))
	const journal = new TaskJournal()
	const task = await createTask(journal, artifactRoot, 'Implement history.')
	const runId = '11111111-1111-4111-8111-111111111111'

	await journal.append(artifactRoot, task.taskId, {
		type: 'RouteSelected',
		data: {
			strategy: 'balanced',
			candidateWorkerIds: ['worker-one'],
			maxAttempts: 1,
		},
	})
	await journal.append(artifactRoot, task.taskId, {
		type: 'WorkerStarted',
		data: {
			runId,
			workerId: 'worker-one',
			attemptNumber: 1,
		},
	})
	await journal.append(artifactRoot, task.taskId, {
		type: 'WorkerCompleted',
		data: {
			runId,
			outcome: 'succeeded',
			failureCode: null,
			requestCount: 1,
		},
	})
	await journal.append(artifactRoot, task.taskId, {
		type: 'ValidationCompleted',
		data: { runId, outcome: 'skipped', commandCount: 0 },
	})
	await journal.append(artifactRoot, task.taskId, {
		type: 'EvaluationCompleted',
		data: {
			runId,
			evaluatorIds: ['deterministic-v1'],
			outcome: 'passed',
			failedDimensions: [],
			unknownDimensions: [],
		},
	})
	await journal.append(artifactRoot, task.taskId, {
		type: 'AttemptCompleted',
		data: { runId, status: 'completed', failureCode: null },
	})
	await journal.append(artifactRoot, task.taskId, {
		type: 'TaskCompleted',
		data: { runId, status: 'completed' },
	})

	const timeline = await journal.timeline(artifactRoot, task.taskId)
	assert.equal(timeline.incomplete, false)
	assert.equal(timeline.task.status, 'completed')
	assert.equal(timeline.task.latestRunId, runId)
	assert.deepEqual(timeline.task.workerIds, ['worker-one'])
	assert.deepEqual(
		timeline.events.map(event => event.type),
		[
			'TaskCreated',
			'RouteSelected',
			'WorkerStarted',
			'WorkerCompleted',
			'ValidationCompleted',
			'EvaluationCompleted',
			'AttemptCompleted',
			'TaskCompleted',
		],
	)
	assert.deepEqual(
		timeline.events.map(event => event.sequence),
		[1, 2, 3, 4, 5, 6, 7, 8],
	)
})

test('rejects re-digested events with unexpected data fields', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'task-event-extra-'))
	const journal = new TaskJournal()
	const task = await createTask(journal, artifactRoot, 'Reject hidden payloads')
	const eventPath = await getEventPath(artifactRoot, task.taskId, 1)
	const event = JSON.parse(await readFile(eventPath, 'utf8')) as {
		data: Record<string, unknown>
	}
	event.data['arguments'] = { secret: 'must-not-escape' }
	const contents = `${JSON.stringify(event)}\n`
	const digest = createHash('sha256').update(contents).digest('hex')
	const replacementPath = path.join(
		path.dirname(eventPath),
		`000000000001-${digest}.json`,
	)
	await writeFile(replacementPath, contents, { mode: 0o600 })
	await rm(eventPath)

	await assert.rejects(
		journal.timeline(artifactRoot, task.taskId),
		hasHarnessCode('INVALID_TASK_JOURNAL'),
	)
})

test('rejects a re-digested event that skips the attempt lifecycle', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'task-event-order-'))
	const journal = new TaskJournal()
	const task = await createTask(journal, artifactRoot, 'Reject invalid order')
	const runId = randomUUID()
	await journal.append(artifactRoot, task.taskId, {
		type: 'RouteSelected',
		data: {
			strategy: 'balanced',
			candidateWorkerIds: ['worker-one'],
			maxAttempts: 1,
		},
	})
	await journal.append(artifactRoot, task.taskId, {
		type: 'WorkerStarted',
		data: { runId, workerId: 'worker-one', attemptNumber: 1 },
	})
	const previousPath = await getEventPath(artifactRoot, task.taskId, 3)
	const previousDigest = path.basename(previousPath).slice(13, 77)
	const forgedEvent = {
		schemaVersion: 1,
		eventId: randomUUID(),
		taskId: task.taskId,
		sequence: 4,
		occurredAt: new Date().toISOString(),
		previousEventSha256: previousDigest,
		type: 'AttemptCompleted',
		data: { runId, status: 'completed', failureCode: null },
	}
	const contents = `${JSON.stringify(forgedEvent)}\n`
	const digest = createHash('sha256').update(contents).digest('hex')
	await writeFile(
		path.join(path.dirname(previousPath), `000000000004-${digest}.json`),
		contents,
		{ mode: 0o600 },
	)

	await assert.rejects(
		journal.timeline(artifactRoot, task.taskId),
		hasHarnessCode('INVALID_TASK_JOURNAL'),
	)
})

test('requires evaluation evidence before completing a version 2 attempt', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'task-event-evaluation-order-'))
	const journal = new TaskJournal()
	const task = await createTask(journal, artifactRoot, 'Require evaluation evidence')
	const runId = randomUUID()
	await journal.append(artifactRoot, task.taskId, {
		type: 'RouteSelected',
		data: {
			strategy: 'balanced',
			candidateWorkerIds: ['worker-one'],
			maxAttempts: 1,
		},
	})
	await journal.append(artifactRoot, task.taskId, {
		type: 'WorkerStarted',
		data: { runId, workerId: 'worker-one', attemptNumber: 1 },
	})
	await journal.append(artifactRoot, task.taskId, {
		type: 'WorkerCompleted',
		data: {
			runId,
			outcome: 'succeeded',
			failureCode: null,
			requestCount: 1,
		},
	})
	await journal.append(artifactRoot, task.taskId, {
		type: 'ValidationCompleted',
		data: { runId, outcome: 'skipped', commandCount: 0 },
	})

	await assert.rejects(
		journal.append(artifactRoot, task.taskId, {
			type: 'AttemptCompleted',
			data: { runId, status: 'completed', failureCode: null },
		}),
		hasHarnessCode('INVALID_TASK_EVENT_TRANSITION'),
	)
})

test('rejects contradictory evaluation dimension evidence', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'task-event-evaluation-data-'))
	const journal = new TaskJournal()
	const task = await createTask(journal, artifactRoot, 'Reject contradictory evidence')
	const runId = randomUUID()
	await journal.append(artifactRoot, task.taskId, {
		type: 'RouteSelected',
		data: {
			strategy: 'balanced',
			candidateWorkerIds: ['worker-one'],
			maxAttempts: 1,
		},
	})
	await journal.append(artifactRoot, task.taskId, {
		type: 'WorkerStarted',
		data: { runId, workerId: 'worker-one', attemptNumber: 1 },
	})
	await journal.append(artifactRoot, task.taskId, {
		type: 'WorkerCompleted',
		data: {
			runId,
			outcome: 'failed',
			failureCode: 'PROVIDER_ERROR',
			requestCount: 1,
		},
	})
	await journal.append(artifactRoot, task.taskId, {
		type: 'ValidationCompleted',
		data: { runId, outcome: 'skipped', commandCount: 0 },
	})

	await assert.rejects(
		journal.append(artifactRoot, task.taskId, {
			type: 'EvaluationCompleted',
			data: {
				runId,
				evaluatorIds: ['deterministic-v1'],
				outcome: 'failed',
				failedDimensions: ['worker_execution'],
				unknownDimensions: ['worker_execution'],
			},
		}),
		hasHarnessCode('INVALID_TASK_JOURNAL'),
	)
	await assert.rejects(
		journal.append(artifactRoot, task.taskId, {
			type: 'EvaluationCompleted',
			data: {
				runId,
				evaluatorIds: ['model-only'],
				outcome: 'failed',
				failedDimensions: ['correctness'],
				unknownDimensions: [],
			},
		}),
		hasHarnessCode('INVALID_TASK_JOURNAL'),
	)
})

test('rejects a failed attempt paired with a non-failed evaluation', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'task-event-evaluation-status-'))
	const journal = new TaskJournal()
	const task = await createTask(journal, artifactRoot, 'Match evaluation to status')
	const runId = randomUUID()
	await journal.append(artifactRoot, task.taskId, {
		type: 'RouteSelected',
		data: {
			strategy: 'balanced',
			candidateWorkerIds: ['worker-one'],
			maxAttempts: 1,
		},
	})
	await journal.append(artifactRoot, task.taskId, {
		type: 'WorkerStarted',
		data: { runId, workerId: 'worker-one', attemptNumber: 1 },
	})
	await journal.append(artifactRoot, task.taskId, {
		type: 'WorkerCompleted',
		data: {
			runId,
			outcome: 'failed',
			failureCode: 'PROVIDER_ERROR',
			requestCount: 1,
		},
	})
	await journal.append(artifactRoot, task.taskId, {
		type: 'ValidationCompleted',
		data: { runId, outcome: 'skipped', commandCount: 0 },
	})
	await journal.append(artifactRoot, task.taskId, {
		type: 'EvaluationCompleted',
		data: {
			runId,
			evaluatorIds: ['deterministic-v1'],
			outcome: 'passed',
			failedDimensions: [],
			unknownDimensions: [],
		},
	})

	await assert.rejects(
		journal.append(artifactRoot, task.taskId, {
			type: 'AttemptCompleted',
			data: { runId, status: 'failed', failureCode: 'PROVIDER_ERROR' },
		}),
		hasHarnessCode('INVALID_TASK_EVENT_TRANSITION'),
	)
})

test('ignores unpublished staging entries during active reads', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'task-event-pending-'))
	const journal = new TaskJournal()
	const task = await createTask(journal, artifactRoot, 'Ignore staging')
	const tasksRoot = path.join(artifactRoot, 'tasks')
	await mkdir(path.join(tasksRoot, randomUUID()), { mode: 0o700 })
	const eventsDirectory = path.join(tasksRoot, task.taskId, 'events')
	const pendingEventName = `000000000002-${'b'.repeat(64)}.json`
	await writeFile(
		path.join(
			eventsDirectory,
			`.publish-${randomUUID()}-${pendingEventName}`,
		),
		'',
	)

	const timeline = await journal.timeline(artifactRoot, task.taskId)
	const page = await journal.list(artifactRoot, {
		limit: 10,
		cursor: null,
		status: null,
		mode: null,
		workerId: null,
	})
	assert.equal(timeline.events.length, 1)
	assert.deepEqual(page.tasks.map(item => item.taskId), [task.taskId])
})

test('reads a committed hard-link pair without mutating or reusing its sequence', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'task-event-recover-'))
	const journal = new TaskJournal()
	const task = await createTask(journal, artifactRoot, 'Recover publication')
	await journal.append(artifactRoot, task.taskId, {
		type: 'RouteSelected',
		data: {
			strategy: 'balanced',
			candidateWorkerIds: ['worker-one'],
			maxAttempts: 1,
		},
	})
	const eventPath = await getEventPath(artifactRoot, task.taskId, 2)
	const pendingPath = path.join(
		path.dirname(eventPath),
		`.publish-${randomUUID()}-${path.basename(eventPath)}`,
	)
	await link(eventPath, pendingPath)
	assert.equal((await stat(eventPath)).nlink, 2)
	assert.deepEqual(
		(await journal.timeline(artifactRoot, task.taskId)).events.map(
			event => event.sequence,
		),
		[1, 2],
	)
	assert.equal((await stat(pendingPath)).nlink, 2)

	await journal.append(artifactRoot, task.taskId, {
		type: 'WorkerStarted',
		data: {
			runId: randomUUID(),
			workerId: 'worker-one',
			attemptNumber: 1,
		},
	})

	const timeline = await journal.timeline(artifactRoot, task.taskId)
	assert.deepEqual(timeline.events.map(event => event.sequence), [1, 2, 3])
	assert.equal((await stat(eventPath)).nlink, 2)
	await unlink(pendingPath)
	assert.equal((await stat(eventPath)).nlink, 1)
	assert.deepEqual(
		(await journal.timeline(artifactRoot, task.taskId)).events.map(
			event => event.sequence,
		),
		[1, 2, 3],
	)
})

test('rejects a staging name that is not linked to its published event', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'task-event-mismatch-'))
	const journal = new TaskJournal()
	const task = await createTask(journal, artifactRoot, 'Reject mismatched staging')
	await journal.append(artifactRoot, task.taskId, {
		type: 'RouteSelected',
		data: {
			strategy: 'balanced',
			candidateWorkerIds: ['worker-one'],
			maxAttempts: 1,
		},
	})
	const eventPath = await getEventPath(artifactRoot, task.taskId, 2)
	await writeFile(
		path.join(
			path.dirname(eventPath),
			`.publish-${randomUUID()}-${path.basename(eventPath)}`,
		),
		'not the published event',
		{ mode: 0o600 },
	)

	await assert.rejects(
		journal.timeline(artifactRoot, task.taskId),
		hasHarnessCode('ARTIFACT_HARD_LINK_DENIED'),
	)
})

test('reads a committed readiness-marker pair without mutating it', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'task-ready-pair-'))
	const journal = new TaskJournal()
	const task = await createTask(journal, artifactRoot, 'Read ready pair')
	const taskDirectory = path.join(artifactRoot, 'tasks', task.taskId)
	const markerPath = path.join(taskDirectory, '.task-ready')
	const pendingPath = path.join(
		taskDirectory,
		`.publish-${randomUUID()}-.task-ready`,
	)
	await link(markerPath, pendingPath)

	assert.equal((await stat(markerPath)).nlink, 2)
	assert.equal((await journal.timeline(artifactRoot, task.taskId)).events.length, 1)
	assert.deepEqual(
		(await journal.list(artifactRoot, {
			limit: 10,
			cursor: null,
			status: null,
			mode: null,
			workerId: null,
		})).tasks.map(item => item.taskId),
		[task.taskId],
	)
	assert.equal((await stat(pendingPath)).nlink, 2)
	await unlink(pendingPath)
	assert.equal((await stat(markerPath)).nlink, 1)
})

test('does not change private directory modes during timeline or list queries', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'task-read-mode-'))
	const journal = new TaskJournal()
	const task = await createTask(journal, artifactRoot, 'Keep directory modes')
	const tasksDirectory = path.join(artifactRoot, 'tasks')
	const taskDirectory = path.join(tasksDirectory, task.taskId)
	const eventsDirectory = path.join(taskDirectory, 'events')
	const directories = [artifactRoot, tasksDirectory, taskDirectory, eventsDirectory]
	for (const directory of directories) {
		await chmod(directory, 0o500)
	}

	assert.equal((await journal.timeline(artifactRoot, task.taskId)).events.length, 1)
	assert.equal((await journal.list(artifactRoot, {
		limit: 10,
		cursor: null,
		status: null,
		mode: null,
		workerId: null,
	})).tasks.length, 1)
	for (const directory of directories) {
		assert.equal((await stat(directory)).mode & 0o777, 0o500)
	}
})

test('rejects unsafe journal ancestor modes without changing them', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'task-ancestor-mode-'))
	const journal = new TaskJournal()
	const task = await createTask(journal, artifactRoot, 'Reject ancestor modes')
	const tasksDirectory = path.join(artifactRoot, 'tasks')
	const query = {
		limit: 10,
		cursor: null,
		status: null,
		mode: null,
		workerId: null,
	} as const

	await chmod(tasksDirectory, 0o750)
	await assert.rejects(
		journal.timeline(artifactRoot, task.taskId),
		hasHarnessCode('ARTIFACT_PERMISSIONS_INVALID'),
	)
	await assert.rejects(
		journal.list(artifactRoot, query),
		hasHarnessCode('ARTIFACT_PERMISSIONS_INVALID'),
	)
	assert.equal((await stat(tasksDirectory)).mode & 0o777, 0o750)
	await chmod(tasksDirectory, 0o700)

	await chmod(artifactRoot, 0o750)
	await assert.rejects(
		journal.timeline(artifactRoot, task.taskId),
		hasHarnessCode('ARTIFACT_PERMISSIONS_INVALID'),
	)
	await assert.rejects(
		journal.list(artifactRoot, query),
		hasHarnessCode('ARTIFACT_PERMISSIONS_INVALID'),
	)
	assert.equal((await stat(artifactRoot)).mode & 0o777, 0o750)
})

test('bounds aggregate task-list event bytes', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'task-list-bytes-'))
	const tasksRoot = path.join(artifactRoot, 'tasks')
	await mkdir(tasksRoot, { mode: 0o700 })

	for (let index = 0; index < 2_100; index += 1) {
		const taskId = randomUUID()
		const eventsDirectory = path.join(tasksRoot, taskId, 'events')
		await mkdir(eventsDirectory, { recursive: true, mode: 0o700 })
		const event = {
			schemaVersion: 1,
			eventId: randomUUID(),
			taskId,
			sequence: 1,
			occurredAt: new Date().toISOString(),
			previousEventSha256: null,
			type: 'TaskCreated',
			data: {
				objective: 'x'.repeat(4_000),
				mode: 'implementation',
				repositoryPath: '/tmp/repository',
				baseCommit: 'a'.repeat(40),
			},
		}
		const contents = `${JSON.stringify(event)}\n`
		const digest = createHash('sha256').update(contents).digest('hex')
		await writeFile(
			path.join(eventsDirectory, `000000000001-${digest}.json`),
			contents,
			{ mode: 0o600 },
		)
		const marker = `${JSON.stringify({
			schemaVersion: 1,
			taskId,
			firstEventSha256: digest,
		})}\n`
		await writeFile(path.join(tasksRoot, taskId, '.task-ready'), marker, {
			mode: 0o600,
		})
	}

	const journal = new TaskJournal()
	await assert.rejects(
		journal.list(artifactRoot, {
			limit: 10,
			cursor: null,
			status: null,
			mode: null,
			workerId: null,
		}),
		hasHarnessCode('TASK_TRAVERSAL_LIMIT'),
	)
})

test('accepts the configured 1024-tool-call boundary for one attempt', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'task-tool-boundary-'))
	const taskId = randomUUID()
	const runId = randomUUID()
	const taskDirectory = path.join(artifactRoot, 'tasks', taskId)
	const eventsDirectory = path.join(taskDirectory, 'events')
	await mkdir(eventsDirectory, { recursive: true, mode: 0o700 })
	let sequence = 0
	let previousEventSha256: string | null = null
	let firstEventSha256 = ''

	async function appendRawEvent(
		type: string,
		data: Record<string, unknown>,
	): Promise<void> {
		sequence += 1
		const event = {
			schemaVersion: 1,
			eventId: randomUUID(),
			taskId,
			sequence,
			occurredAt: new Date().toISOString(),
			previousEventSha256,
			type,
			data,
		}
		const contents = `${JSON.stringify(event)}\n`
		const eventSha256 = createHash('sha256').update(contents).digest('hex')
		await writeFile(
			path.join(
				eventsDirectory,
				`${String(sequence).padStart(12, '0')}-${eventSha256}.json`,
			),
			contents,
			{ mode: 0o600 },
		)
		if (sequence === 1) {
			firstEventSha256 = eventSha256
		}
		previousEventSha256 = eventSha256
	}

	await appendRawEvent('TaskCreated', {
		objective: 'Exercise the tool-call boundary',
		mode: 'implementation',
		repositoryPath: '/tmp/repository',
		baseCommit: 'a'.repeat(40),
	})
	await appendRawEvent('RouteSelected', {
		strategy: 'balanced',
		candidateWorkerIds: ['worker-one'],
		maxAttempts: 1,
	})
	await appendRawEvent('WorkerStarted', {
		runId,
		workerId: 'worker-one',
		attemptNumber: 1,
	})
	for (let index = 0; index < 1_024; index += 1) {
		await appendRawEvent('ToolCalled', {
			runId,
			toolName: 'read_file',
			iteration: index + 1,
			outcome: 'succeeded',
			inputBytes: 1,
			outputBytes: 1,
			durationMs: 1,
		})
	}
	await appendRawEvent('WorkerCompleted', {
		runId,
		outcome: 'succeeded',
		failureCode: null,
		requestCount: 1,
	})
	await appendRawEvent('ValidationCompleted', {
		runId,
		outcome: 'skipped',
		commandCount: 0,
	})
	await appendRawEvent('AttemptCompleted', {
		runId,
		status: 'completed',
		failureCode: null,
	})
	await appendRawEvent('TaskCompleted', { runId, status: 'completed' })
	await writeFile(
		path.join(taskDirectory, '.task-ready'),
		`${JSON.stringify({
			schemaVersion: 1,
			taskId,
			firstEventSha256,
		})}\n`,
		{ mode: 0o600 },
	)

	const timeline = await new TaskJournal().timeline(artifactRoot, taskId)
	assert.equal(timeline.events.length, 1_031)
	assert.equal(timeline.task.status, 'completed')
})

test('lists tasks with bounded filters and cursor pagination', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'task-list-'))
	const journal = new TaskJournal()
	const first = await createTask(journal, artifactRoot, 'First task')
	const second = await createTask(journal, artifactRoot, 'Second task')

	const firstPage = await journal.list(artifactRoot, {
		limit: 1,
		cursor: null,
		status: 'in_progress',
		mode: 'implementation',
		workerId: null,
	})
	assert.equal(firstPage.tasks.length, 1)
	assert.ok(firstPage.nextCursor)

	const secondPage = await journal.list(artifactRoot, {
		limit: 1,
		cursor: firstPage.nextCursor,
		status: 'in_progress',
		mode: 'implementation',
		workerId: null,
	})
	assert.equal(secondPage.tasks.length, 1)
	assert.equal(secondPage.nextCursor, null)
	assert.deepEqual(
		new Set([
			firstPage.tasks[0]?.taskId,
			secondPage.tasks[0]?.taskId,
		]),
		new Set([first.taskId, second.taskId]),
	)
})

test('rejects a task event replaced by a symbolic link', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'task-event-link-'))
	const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'task-event-outside-'))
	const journal = new TaskJournal()
	const task = await createTask(journal, artifactRoot, 'Reject links')
	const eventPath = await getEventPath(artifactRoot, task.taskId, 1)
	const outsideEvent = path.join(outsideRoot, 'event.json')
	await writeFile(outsideEvent, await readFile(eventPath))
	await rm(eventPath)
	await symlink(outsideEvent, eventPath)

	await assert.rejects(
		journal.timeline(artifactRoot, task.taskId),
		hasHarnessCode('INVALID_TASK_JOURNAL'),
	)
})

test('rejects a hard-linked task event', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'task-event-hard-link-'))
	const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'task-event-hard-outside-'))
	const journal = new TaskJournal()
	const task = await createTask(journal, artifactRoot, 'Reject hard links')
	const eventPath = await getEventPath(artifactRoot, task.taskId, 1)
	const outsideEvent = path.join(outsideRoot, 'event.json')
	await writeFile(outsideEvent, await readFile(eventPath))
	await rm(eventPath)
	await link(outsideEvent, eventPath)

	await assert.rejects(
		journal.timeline(artifactRoot, task.taskId),
		hasHarnessCode('ARTIFACT_HARD_LINK_DENIED'),
	)
})

test('rejects an intermediate task directory replaced by a symbolic link', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'task-directory-link-'))
	const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'task-directory-outside-'))
	const journal = new TaskJournal()
	const task = await createTask(journal, artifactRoot, 'Reject directory swaps')
	const taskPath = path.join(artifactRoot, 'tasks', task.taskId)
	const outsideTaskPath = path.join(outsideRoot, task.taskId)
	await rename(taskPath, outsideTaskPath)
	await symlink(outsideTaskPath, taskPath)

	await assert.rejects(
		journal.timeline(artifactRoot, task.taskId),
		hasHarnessCode('ARTIFACT_PATH_INVALID'),
	)
})

test('detects event mutation through the projected digest', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'task-event-digest-'))
	const journal = new TaskJournal()
	const task = await createTask(journal, artifactRoot, 'Original objective')
	const eventPath = await getEventPath(artifactRoot, task.taskId, 1)
	const event = JSON.parse(await readFile(eventPath, 'utf8')) as {
		data: { objective: string }
	}
	event.data.objective = 'Mutated objective'
	await writeFile(eventPath, `${JSON.stringify(event)}\n`, 'utf8')

	await assert.rejects(
		journal.timeline(artifactRoot, task.taskId),
		hasHarnessCode('INVALID_TASK_JOURNAL'),
	)
})

test('detects mutation of an earlier event through the digest chain', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'task-event-chain-'))
	const journal = new TaskJournal()
	const task = await createTask(journal, artifactRoot, 'Original objective')
	await journal.append(artifactRoot, task.taskId, {
		type: 'RouteSelected',
		data: {
			strategy: 'balanced',
			candidateWorkerIds: ['worker-one'],
			maxAttempts: 1,
		},
	})
	const eventPath = await getEventPath(artifactRoot, task.taskId, 1)
	const event = JSON.parse(await readFile(eventPath, 'utf8')) as {
		data: { objective: string }
	}
	event.data.objective = 'Mutated objective'
	await writeFile(eventPath, `${JSON.stringify(event)}\n`, 'utf8')

	await assert.rejects(
		journal.timeline(artifactRoot, task.taskId),
		hasHarnessCode('INVALID_TASK_JOURNAL'),
	)
})

test('rejects invalid patch lifecycle transitions', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'task-transition-'))
	const journal = new TaskJournal()
	const task = await createTask(journal, artifactRoot, 'Invalid transition')

	await assert.rejects(
		journal.append(artifactRoot, task.taskId, {
			type: 'PatchApplied',
			data: {
				runId: '22222222-2222-4222-8222-222222222222',
				changedFileCount: 1,
			},
		}),
		hasHarnessCode('INVALID_TASK_EVENT_TRANSITION'),
	)
})

test('rejects fallback history after a policy failure', async function () {
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'task-fallback-policy-'))
	const journal = new TaskJournal()
	const task = await createTask(journal, artifactRoot, 'Do not bypass policy')
	const firstRunId = randomUUID()
	await journal.append(artifactRoot, task.taskId, {
		type: 'RouteSelected',
		data: {
			strategy: 'balanced',
			candidateWorkerIds: ['worker-one', 'worker-two'],
			maxAttempts: 2,
		},
	})
	await journal.append(artifactRoot, task.taskId, {
		type: 'WorkerStarted',
		data: { runId: firstRunId, workerId: 'worker-one', attemptNumber: 1 },
	})
	await journal.append(artifactRoot, task.taskId, {
		type: 'WorkerCompleted',
		data: {
			runId: firstRunId,
			outcome: 'succeeded',
			failureCode: null,
			requestCount: 1,
		},
	})
	await journal.append(artifactRoot, task.taskId, {
		type: 'ValidationCompleted',
		data: { runId: firstRunId, outcome: 'skipped', commandCount: 0 },
	})
	await journal.append(artifactRoot, task.taskId, {
		type: 'EvaluationCompleted',
		data: {
			runId: firstRunId,
			evaluatorIds: ['deterministic-v1'],
			outcome: 'failed',
			failedDimensions: ['security_policy_compliance'],
			unknownDimensions: [],
		},
	})
	await journal.append(artifactRoot, task.taskId, {
		type: 'AttemptCompleted',
		data: {
			runId: firstRunId,
			status: 'policy_violation',
			failureCode: 'WORKER_POLICY_VIOLATION',
		},
	})

	await assert.rejects(
		journal.append(artifactRoot, task.taskId, {
			type: 'WorkerStarted',
			data: {
				runId: randomUUID(),
				workerId: 'worker-two',
				attemptNumber: 2,
			},
		}),
		hasHarnessCode('INVALID_TASK_EVENT_TRANSITION'),
	)
})
