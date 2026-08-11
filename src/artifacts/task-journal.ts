import { createHash, randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import type {
	TaskEvent,
	TaskEventInput,
	TaskListQuery,
	TaskPage,
	TaskSummary,
	TaskTimeline,
	WorkerMode,
} from '../domain/types.js'
import { HarnessError } from '../lib/errors.js'
import { isRecord } from '../lib/json.js'
import { Redactor } from '../lib/redaction.js'
import {
	projectTaskEvent,
	type TaskEventProjection,
	validateTaskEvent,
} from './task-event-model.js'
import {
	assertPrivateDirectory,
	createPrivateDirectory,
	ensurePrivateDirectory,
	readBoundedPublicationFile,
	readBoundedRegularFile,
	writeExclusiveRegularFile,
} from './secure-io.js'

const maxEventBytes = 65_536
const maxEventsPerTask = 10_000
const maxTimelineBytes = 8_388_608
const maxTaskDirectories = 10_000
const maxEventsPerList = 25_000
const maxListBytes = 8_388_608
const taskDirectoryName = 'tasks'
const taskReadyFileName = '.task-ready'
const eventFilePattern = /^([0-9]{12})-([a-f0-9]{64})\.json$/i
const pendingFilePattern = /^\.publish-[0-9a-f-]{36}-(.+)$/i
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type CreateTaskInput = {
	artifactRoot: string
	objective: string
	mode: WorkerMode
	repositoryPath: string
	baseCommit: string
}

export type RunHistoryLink = {
	artifactRoot: string
	taskId: string
	runId: string
	repositoryPath: string
	baseCommit: string
	status: 'completed'
	patchSha256: string
	changedFileCount: number
	workerId: string
}

type TimelineReadResult = {
	timeline: TaskTimeline
	projection: TaskEventProjection
	bytesRead: number
}

export class TaskJournal {
	private readonly redactor: Redactor

	constructor(redactor = new Redactor()) {
		this.redactor = redactor
	}

	async create(input: CreateTaskInput): Promise<TaskSummary> {
		const taskId = randomUUID()
		const tasksRoot = path.join(input.artifactRoot, taskDirectoryName)
		const taskDirectory = path.join(tasksRoot, taskId)
		const eventsDirectory = path.join(taskDirectory, 'events')

		await ensurePrivateDirectory(input.artifactRoot, input.artifactRoot, {
			recursive: true,
		})
		await ensurePrivateDirectory(input.artifactRoot, tasksRoot, {
			recursive: true,
		})
		try {
			await createPrivateDirectory(input.artifactRoot, taskDirectory)
		} catch (error) {
			throw new HarnessError(
				'TASK_ID_COLLISION',
				`Task directory already exists or cannot be created: ${taskId}`,
				{ cause: error instanceof Error ? error.message : String(error) },
			)
		}
		await createPrivateDirectory(input.artifactRoot, eventsDirectory)

		const event = createEvent(2, taskId, 1, null, {
			type: 'TaskCreated',
			data: {
				objective: this.redactor.redact(input.objective),
				mode: input.mode,
				repositoryPath: input.repositoryPath,
				baseCommit: input.baseCommit,
			},
		})
		const serializedEvent = serializeEvent(event)
		const eventSha256 = digest(serializedEvent)
		await writeExclusiveRegularFile(
			input.artifactRoot,
			path.join(eventsDirectory, eventFileName(1, eventSha256)),
			serializedEvent,
		)

		await writeExclusiveRegularFile(
			input.artifactRoot,
			path.join(taskDirectory, taskReadyFileName),
			serializeTaskReadyMarker(taskId, eventSha256),
		)

		return projectTaskEvent(null, event, eventSha256, true).summary
	}

	async append(
		artifactRoot: string,
		taskId: string,
		input: TaskEventInput,
	): Promise<TaskEvent> {
		validateUuid(taskId, 'task ID')
		const current = await this.readTimeline(artifactRoot, taskId)

		if (current.timeline.events.length >= maxEventsPerTask) {
			throw new HarnessError(
				'TASK_EVENT_LIMIT',
				`Task exceeds the ${maxEventsPerTask}-event journal limit`,
			)
		}

		const redactedInput = redactEventInput(input, this.redactor)
		const event = createEvent(
			current.projection.eventSchemaVersion,
			taskId,
			current.timeline.events.length + 1,
			current.timeline.task.latestEventSha256,
			redactedInput,
		)
		const serializedEvent = serializeEvent(event)
		projectTaskEvent(current.projection, event, digest(serializedEvent), true)

		if (current.bytesRead + Buffer.byteLength(serializedEvent) > maxTimelineBytes) {
			throw new HarnessError(
				'TASK_EVENT_LIMIT',
				`Task history exceeds the ${maxTimelineBytes}-byte timeline limit`,
			)
		}

		const eventsDirectory = path.join(
			artifactRoot,
			taskDirectoryName,
			taskId,
			'events',
		)
		await writeExclusiveRegularFile(
			artifactRoot,
			path.join(
				eventsDirectory,
				eventFileName(event.sequence, digest(serializedEvent)),
			),
			serializedEvent,
		)
		return event
	}

	async timeline(
		artifactRoot: string,
		taskId: string,
	): Promise<TaskTimeline> {
		validateUuid(taskId, 'task ID')
		try {
			await assertPrivateDirectory(artifactRoot, artifactRoot)
			await assertPrivateDirectory(
				artifactRoot,
				path.join(artifactRoot, taskDirectoryName),
			)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				throw new HarnessError(
					'TASK_NOT_FOUND',
					`Task history is not published: ${taskId}`,
				)
			}
			throw error
		}
		return (await this.readTimeline(artifactRoot, taskId)).timeline
	}

	async isRunLinked(input: RunHistoryLink): Promise<boolean> {
		const timeline = await this.timeline(input.artifactRoot, input.taskId)
		const created = timeline.events[0]
		const started = timeline.events.find(
			event => event.type === 'WorkerStarted' && event.data.runId === input.runId,
		)
		const produced = timeline.events.find(
			event => event.type === 'PatchProduced' && event.data.runId === input.runId,
		)
		const attempt = timeline.events.find(
			event => event.type === 'AttemptCompleted' && event.data.runId === input.runId,
		)
		const completed = timeline.events.find(event => event.type === 'TaskCompleted')

		return (
			created?.type === 'TaskCreated' &&
			created.data.repositoryPath === input.repositoryPath &&
			created.data.baseCommit === input.baseCommit &&
			started?.type === 'WorkerStarted' &&
			started.data.workerId === input.workerId &&
			produced?.type === 'PatchProduced' &&
			produced.data.patchSha256 === input.patchSha256 &&
			produced.data.changedFileCount === input.changedFileCount &&
			attempt?.type === 'AttemptCompleted' &&
			attempt.data.status === input.status &&
			completed?.type === 'TaskCompleted' &&
			completed.data.runId === input.runId &&
			completed.data.status === input.status
		)
	}

	async list(
		artifactRoot: string,
		query: TaskListQuery,
	): Promise<TaskPage> {
		const tasksRoot = path.join(artifactRoot, taskDirectoryName)

		try {
			await assertPrivateDirectory(artifactRoot, artifactRoot)
			await assertPrivateDirectory(artifactRoot, tasksRoot)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return { tasks: [], nextCursor: null }
			}
			throw error
		}

		const entries = await readdir(tasksRoot, { withFileTypes: true })
		if (entries.length > maxTaskDirectories) {
			throw traversalLimit(
				`Task history exceeds the ${maxTaskDirectories}-directory traversal limit`,
			)
		}

		const summaries: Array<TaskSummary> = []
		let traversedEvents = 0
		let traversedBytes = 0

		for (const entry of entries) {
			if (!entry.isDirectory() || !uuidPattern.test(entry.name)) {
				throw invalidJournal('Task history contains an unexpected entry')
			}
			const marker = await this.readTaskReadyMarker(artifactRoot, entry.name)
			if (marker === null) {
				continue
			}

			const result = await this.readTimeline(artifactRoot, entry.name, marker)
			traversedEvents += result.timeline.events.length
			traversedBytes += result.bytesRead
			if (
				traversedEvents > maxEventsPerList ||
				traversedBytes > maxListBytes
			) {
				throw traversalLimit(
					`Task listing exceeds ${maxEventsPerList} events or ${maxListBytes} bytes`,
				)
			}

			const summary = result.timeline.task
			if (
				(query.status === null || summary.status === query.status) &&
				(query.mode === null || summary.mode === query.mode) &&
				(query.workerId === null || summary.workerIds.includes(query.workerId))
			) {
				summaries.push(summary)
			}
		}

		summaries.sort((left, right) =>
			right.createdAt.localeCompare(left.createdAt) ||
			right.taskId.localeCompare(left.taskId),
		)
		let startIndex = 0

		if (query.cursor !== null) {
			validateUuid(query.cursor, 'task cursor')
			const cursorIndex = summaries.findIndex(
				summary => summary.taskId === query.cursor,
			)
			if (cursorIndex === -1) {
				throw new HarnessError(
					'INVALID_TASK_CURSOR',
					'Task cursor is not present in the filtered result set',
				)
			}
			startIndex = cursorIndex + 1
		}

		const tasks = summaries.slice(startIndex, startIndex + query.limit)
		const hasMore = startIndex + tasks.length < summaries.length
		return {
			tasks,
			nextCursor: hasMore ? tasks.at(-1)?.taskId ?? null : null,
		}
	}

	private async readTimeline(
		artifactRoot: string,
		taskId: string,
		knownMarker?: TaskReadyMarker,
	): Promise<TimelineReadResult> {
		validateUuid(taskId, 'task ID')
		const marker = knownMarker ??
			await this.readTaskReadyMarker(artifactRoot, taskId)
		if (marker === null) {
			throw new HarnessError(
				'TASK_NOT_FOUND',
				`Task history is not published: ${taskId}`,
			)
		}
		const eventsDirectory = path.join(
			artifactRoot,
			taskDirectoryName,
			taskId,
			'events',
		)

		try {
			await assertPrivateDirectory(artifactRoot, eventsDirectory)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				throw invalidJournal('Published task is missing its events directory')
			}
			throw error
		}

		const entries = await readdir(eventsDirectory, { withFileTypes: true })
		if (entries.length > maxEventsPerTask * 2) {
			throw new HarnessError(
				'TASK_EVENT_LIMIT',
				`Task exceeds the ${maxEventsPerTask}-event journal limit`,
			)
		}
		const pendingByFinalName = collectPendingPublications(
			entries,
			eventFilePattern,
		)
		const names = entries.flatMap(entry => {
			if (pendingFilePattern.test(entry.name)) {
				if (!entry.isFile()) {
					throw invalidJournal('Task journal staging entry is not a file')
				}
				return []
			}
			if (!entry.isFile() || !eventFilePattern.test(entry.name)) {
				throw invalidJournal('Task journal contains an unexpected entry')
			}
			return [entry.name]
		}).sort()

		if (names.length === 0) {
			throw invalidJournal('Published task journal contains no events')
		}
		if (names.length > maxEventsPerTask) {
			throw new HarnessError(
				'TASK_EVENT_LIMIT',
				`Task exceeds the ${maxEventsPerTask}-event journal limit`,
			)
		}

		const events: Array<TaskEvent> = []
		let projection: TaskEventProjection | null = null
		let previousEventSha256: string | null = null
		let bytesRead = 0

		for (const [index, name] of names.entries()) {
			const expectedSequence = index + 1
			const match = eventFilePattern.exec(name)
			if (match === null || Number(match[1]) !== expectedSequence) {
				throw invalidJournal('Task journal event sequence is not contiguous')
			}

			const eventPath = path.join(eventsDirectory, name)
			const pendingName = pendingByFinalName.get(name)
			const contents = pendingName === undefined
				? await readBoundedRegularFile(
					artifactRoot,
					eventPath,
					maxEventBytes,
				)
				: await readBoundedPublicationFile(
					artifactRoot,
					eventPath,
					path.join(eventsDirectory, pendingName),
					maxEventBytes,
				)
			bytesRead += contents.length
			if (bytesRead > maxTimelineBytes) {
				throw new HarnessError(
					'TASK_EVENT_LIMIT',
					`Task history exceeds the ${maxTimelineBytes}-byte timeline limit`,
				)
			}

			const event = parseEvent(contents, taskId, expectedSequence)
			const eventSha256 = digest(contents)
			if (eventSha256 !== match[2]?.toLowerCase()) {
				throw invalidJournal('Task journal event digest does not match its name')
			}
			if (event.previousEventSha256 !== previousEventSha256) {
				throw invalidJournal('Task journal event digest chain is broken')
			}
			if (expectedSequence === 1 && eventSha256 !== marker.firstEventSha256) {
				throw invalidJournal('Task ready marker does not match TaskCreated')
			}

			projection = projectTaskEvent(projection, event, eventSha256, false)
			events.push(event)
			previousEventSha256 = eventSha256
		}

		if (projection === null) {
			throw invalidJournal('Task journal could not be projected')
		}

		return {
			timeline: {
				task: projection.summary,
				events,
				incomplete: projection.summary.status === 'in_progress',
			},
			projection,
			bytesRead,
		}
	}

	private async readTaskReadyMarker(
		artifactRoot: string,
		taskId: string,
	): Promise<TaskReadyMarker | null> {
		const taskDirectory = path.join(
			artifactRoot,
			taskDirectoryName,
			taskId,
		)
		try {
			await assertPrivateDirectory(artifactRoot, taskDirectory)
			const entries = await readdir(taskDirectory, { withFileTypes: true })
			if (entries.length > 4) {
				throw invalidJournal('Task directory contains too many entries')
			}
			const pendingByFinalName = collectPendingPublications(
				entries,
				/^\.task-ready$/,
			)
			let pendingMarker = false
			for (const entry of entries) {
				const match = pendingFilePattern.exec(entry.name)
				if (entry.isDirectory() && entry.name === 'events') {
					continue
				}
				if (entry.isFile() && entry.name === taskReadyFileName) {
					continue
				}
				if (entry.isFile() && match?.[1] === taskReadyFileName) {
					pendingMarker = true
					continue
				}
				throw invalidJournal('Task directory contains an unexpected entry')
			}
			if (
				pendingMarker &&
				!entries.some(entry =>
					entry.isFile() && entry.name === taskReadyFileName,
				)
			) {
				return null
			}
			const markerPath = path.join(taskDirectory, taskReadyFileName)
			const pendingName = pendingByFinalName.get(taskReadyFileName)
			const contents = pendingName === undefined
				? await readBoundedRegularFile(artifactRoot, markerPath, 256)
				: await readBoundedPublicationFile(
					artifactRoot,
					markerPath,
					path.join(taskDirectory, pendingName),
					256,
				)
			return parseTaskReadyMarker(contents, taskId)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return null
			}
			throw error
		}
	}
}

function collectPendingPublications(
	entries: Array<Dirent>,
	finalNamePattern: RegExp,
): Map<string, string> {
	const pendingByFinalName = new Map<string, string>()

	for (const entry of entries) {
		const match = pendingFilePattern.exec(entry.name)
		if (match === null) {
			continue
		}
		const finalName = match[1]
		if (
			!entry.isFile() ||
			finalName === undefined ||
			!finalNamePattern.test(finalName)
		) {
			throw invalidJournal('Task journal contains an invalid staging entry')
		}
		if (pendingByFinalName.has(finalName)) {
			throw invalidJournal('Task journal contains duplicate staging entries')
		}
		pendingByFinalName.set(finalName, entry.name)
	}

	return pendingByFinalName
}

type TaskReadyMarker = {
	schemaVersion: 1
	taskId: string
	firstEventSha256: string
}

function serializeTaskReadyMarker(
	taskId: string,
	firstEventSha256: string,
): string {
	return `${JSON.stringify({
		schemaVersion: 1,
		taskId,
		firstEventSha256,
	})}\n`
}

function parseTaskReadyMarker(
	contents: Buffer,
	expectedTaskId: string,
): TaskReadyMarker {
	try {
		const value: unknown = JSON.parse(contents.toString('utf8'))
		if (
			!isRecord(value) ||
			Object.keys(value).sort().join(',') !==
				'firstEventSha256,schemaVersion,taskId' ||
			value['schemaVersion'] !== 1 ||
			value['taskId'] !== expectedTaskId ||
			typeof value['firstEventSha256'] !== 'string' ||
			!/^[a-f0-9]{64}$/i.test(value['firstEventSha256'])
		) {
			throw invalidJournal('Task ready marker has an invalid shape')
		}
		return value as TaskReadyMarker
	} catch (error) {
		if (error instanceof HarnessError) {
			throw error
		}
		throw invalidJournal('Task ready marker does not contain valid JSON')
	}
}

function createEvent(
	schemaVersion: 1 | 2,
	taskId: string,
	sequence: number,
	previousEventSha256: string | null,
	input: TaskEventInput,
): TaskEvent {
	const event = {
		schemaVersion,
		eventId: randomUUID(),
		taskId,
		sequence,
		occurredAt: new Date().toISOString(),
		previousEventSha256,
		...input,
	} as TaskEvent
	validateTaskEvent(event, taskId, sequence)
	return event
}

function serializeEvent(event: TaskEvent): string {
	const serialized = `${JSON.stringify(event)}\n`
	if (Buffer.byteLength(serialized, 'utf8') > maxEventBytes) {
		throw new HarnessError(
			'TASK_EVENT_TOO_LARGE',
			`Task event exceeds the ${maxEventBytes}-byte limit`,
		)
	}
	return serialized
}

function parseEvent(
	contents: Buffer,
	taskId: string,
	sequence: number,
): TaskEvent {
	try {
		const value: unknown = JSON.parse(contents.toString('utf8'))
		validateTaskEvent(value, taskId, sequence)
		return value
	} catch (error) {
		if (error instanceof HarnessError) {
			throw error
		}
		throw invalidJournal('Task event does not contain valid JSON')
	}
}

function redactEventInput(
	input: TaskEventInput,
	redactor: Redactor,
): TaskEventInput {
	switch (input.type) {
		case 'ToolCalled':
			return {
				...input,
				data: {
					...input.data,
					toolName: redactor.redact(input.data.toolName),
				},
			}
		case 'WorkerCompleted':
			return {
				...input,
				data: {
					...input.data,
					failureCode: input.data.failureCode === null
						? null
						: redactor.redact(input.data.failureCode),
				},
			}
		case 'AttemptCompleted':
			return {
				...input,
				data: {
					...input.data,
					failureCode: input.data.failureCode === null
						? null
						: redactor.redact(input.data.failureCode),
				},
			}
		case 'PatchApplicationRejected':
			return {
				...input,
				data: {
					...input.data,
					failureCode: redactor.redact(input.data.failureCode),
				},
			}
		default:
			return input
	}
}

function eventFileName(sequence: number, eventSha256: string): string {
	return `${String(sequence).padStart(12, '0')}-${eventSha256}.json`
}

function digest(value: string | Buffer): string {
	return createHash('sha256').update(value).digest('hex')
}

function validateUuid(value: string, description: string): void {
	if (!uuidPattern.test(value)) {
		throw new HarnessError(
			'INVALID_TASK_ID',
			`${description} must be a UUID`,
		)
	}
}

function invalidJournal(message: string): HarnessError {
	return new HarnessError('INVALID_TASK_JOURNAL', message)
}

function traversalLimit(message: string): HarnessError {
	return new HarnessError('TASK_TRAVERSAL_LIMIT', message)
}
