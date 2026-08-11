import { createHash, randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import type {
	EvaluationDimensionId,
	EvaluationOutcome,
	ResolvedPolicy,
	RunStatus,
	TaskEvent,
	TaskEventInput,
	TaskListQuery,
	TaskPage,
	TaskSummary,
	TaskTimeline,
	WorkerMode,
	WorkflowTaskProvenance,
} from '../domain/types.js'
import { HarnessError } from '../lib/errors.js'
import { isRecord } from '../lib/json.js'
import { Redactor } from '../lib/redaction.js'
import { workflowProvenanceEquals } from '../workflow/provenance.js'
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
const routingIndexDirectoryName = 'routing-index'
const taskReadyFileName = '.task-ready'
const eventFilePattern = /^([0-9]{12})-([a-f0-9]{64})\.json$/i
const routingIndexFilePattern = /^(\d{13})-([0-9a-f-]{36})-([a-f0-9]{64})\.json$/i
const pendingFilePattern = /^\.publish-[0-9a-f-]{36}-(.+)$/i
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type CreateTaskInput = {
	artifactRoot: string
	objective: string
	mode: WorkerMode
	repositoryPath: string
	baseCommit: string
	policy?: ResolvedPolicy
	workflowProvenance?: WorkflowTaskProvenance
}

export type RunHistoryLink = {
	artifactRoot: string
	taskId: string
	runId: string
	repositoryPath: string
	baseCommit: string
	mode: WorkerMode
	workflowProvenance: WorkflowTaskProvenance | null
	status: RunStatus
	patchSha256: string | null
	changedFileCount: number
	workerId: string
	evaluation: {
		evaluatorIds: Array<string>
		outcome: EvaluationOutcome
		evaluationPolicy: 'default' | 'strict'
		failedDimensions: Array<EvaluationDimensionId>
		unknownDimensions: Array<EvaluationDimensionId>
	} | null
	policySha256?: string | null
	routingEvidenceSha256?: string | null
	routeDecisionSha256?: string | null
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

		const schemaVersion = input.workflowProvenance === undefined
			? input.policy === undefined ? 3 : 5
			: 6
		const event = createEvent(schemaVersion, taskId, 1, null, {
			type: 'TaskCreated',
			data: {
				objective: this.redactor.redact(input.objective),
				mode: input.mode,
				repositoryPath: input.repositoryPath,
				baseCommit: input.baseCommit,
				...(input.workflowProvenance === undefined
					? {}
					: { workflowProvenance: { ...input.workflowProvenance } }),
				...(input.policy === undefined
					? {}
					: {
						policySha256: input.policy.digest,
						policySourceCount: input.policy.sources.length,
					}),
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
		if (event.schemaVersion >= 5) {
			await this.publishRoutingIndexEntry(
				input.artifactRoot,
				event,
				eventSha256,
			)
		}

		return projectTaskEvent(null, event, eventSha256, true).summary
	}

	async append(
		artifactRoot: string,
		taskId: string,
		input: TaskEventInput,
		signal?: AbortSignal,
	): Promise<TaskEvent> {
		signal?.throwIfAborted()
		validateUuid(taskId, 'task ID')
		const current = await this.readTimeline(
			artifactRoot,
			taskId,
			undefined,
			signal,
		)

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
		signal?.throwIfAborted()
		await writeExclusiveRegularFile(
			artifactRoot,
			path.join(
				eventsDirectory,
				eventFileName(event.sequence, digest(serializedEvent)),
			),
			serializedEvent,
			0o600,
			signal,
		)
		return event
	}

	async timeline(
		artifactRoot: string,
		taskId: string,
		signal?: AbortSignal,
	): Promise<TaskTimeline> {
		signal?.throwIfAborted()
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
		return (await this.readTimeline(
			artifactRoot,
			taskId,
			undefined,
			signal,
		)).timeline
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
		const evaluation = timeline.events.find(
			event =>
				event.type === 'EvaluationCompleted' &&
				event.data.runId === input.runId,
		)
		const completed = timeline.events.find(event => event.type === 'TaskCompleted')
		const route = timeline.events.find(event => event.type === 'RouteSelected')
		const patchEvidenceMatches = input.patchSha256 === null
			? input.changedFileCount === 0
				? produced === undefined
				: input.status === 'failed' &&
					input.evaluation?.failedDimensions.includes('patch_size') === true &&
					produced?.type === 'PatchProduced' &&
					produced.data.changedFileCount === input.changedFileCount
			: produced?.type === 'PatchProduced' &&
				produced.data.patchSha256 === input.patchSha256 &&
				produced.data.changedFileCount === input.changedFileCount

		return (
			created?.type === 'TaskCreated' &&
			created.data.repositoryPath === input.repositoryPath &&
			created.data.baseCommit === input.baseCommit &&
			created.data.mode === input.mode &&
			(created.schemaVersion >= 6
				? workflowProvenanceEquals(
					created.data.workflowProvenance ?? null,
					input.workflowProvenance,
				)
				: input.workflowProvenance === null) &&
			(created.schemaVersion >= 4
				? created.data.policySha256 === (input.policySha256 ?? null)
				: (input.policySha256 ?? null) === null) &&
			(created.schemaVersion >= 5
				? route?.type === 'RouteSelected' &&
					route.data.evidenceSha256 ===
						(input.routingEvidenceSha256 ?? null) &&
					route.data.decisionSha256 ===
						(input.routeDecisionSha256 ?? null)
				: (input.routingEvidenceSha256 ?? null) === null) &&
			started?.type === 'WorkerStarted' &&
			started.data.workerId === input.workerId &&
			patchEvidenceMatches &&
			attempt?.type === 'AttemptCompleted' &&
			attempt.data.status === input.status &&
			(input.evaluation === null ||
				(evaluation?.type === 'EvaluationCompleted' &&
					evaluation.data.outcome === input.evaluation.outcome &&
					(evaluation.data.evaluationPolicy ?? 'default') ===
						input.evaluation.evaluationPolicy &&
					arraysEqual(
						evaluation.data.evaluatorIds,
						input.evaluation.evaluatorIds,
					) &&
					arraysEqual(
						evaluation.data.failedDimensions,
						input.evaluation.failedDimensions,
					) &&
					arraysEqual(
						evaluation.data.unknownDimensions,
						input.evaluation.unknownDimensions,
					))) &&
			completed?.type === 'TaskCompleted' &&
			completed.data.runId === input.runId &&
			completed.data.status === input.status
		)
	}

	async list(
		artifactRoot: string,
		query: TaskListQuery,
		signal?: AbortSignal,
	): Promise<TaskPage> {
		signal?.throwIfAborted()
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
			signal?.throwIfAborted()
			if (!entry.isDirectory() || !uuidPattern.test(entry.name)) {
				throw invalidJournal('Task history contains an unexpected entry')
			}
			const marker = await this.readTaskReadyMarker(
				artifactRoot,
				entry.name,
				signal,
			)
			if (marker === null) {
				continue
			}

			const result = await this.readTimeline(
				artifactRoot,
				entry.name,
				marker,
				signal,
			)
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

	async recentTimelines(
		artifactRoot: string,
		mode: WorkerMode,
		limit: number,
		signal?: AbortSignal,
	): Promise<Array<TaskTimeline>> {
		signal?.throwIfAborted()
		if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100) {
			throw new HarnessError(
				'INVALID_TASK_LIMIT',
				'Recent task timeline limit must be between 0 and 100',
			)
		}
		if (limit === 0) {
			return []
		}
		const indexRoot = path.join(artifactRoot, routingIndexDirectoryName)
		const modeDirectory = path.join(indexRoot, mode)
		const tasksRoot = path.join(artifactRoot, taskDirectoryName)
		try {
			await assertPrivateDirectory(artifactRoot, artifactRoot)
			await assertPrivateDirectory(artifactRoot, tasksRoot)
			await assertPrivateDirectory(artifactRoot, indexRoot)
			await assertPrivateDirectory(artifactRoot, modeDirectory)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return []
			}
			throw error
		}

		const entries = await readdir(modeDirectory, { withFileTypes: true })
		if (entries.length > maxTaskDirectories * 2) {
			throw traversalLimit(
				`Routing index exceeds the ${maxTaskDirectories}-task traversal limit`,
			)
		}
		const pendingByFinalName = collectPendingPublications(
			entries,
			routingIndexFilePattern,
		)
		const names = entries.flatMap(entry => {
			if (pendingFilePattern.test(entry.name)) {
				if (!entry.isFile()) {
					throw invalidJournal('Routing index staging entry is not a file')
				}
				return []
			}
			if (!entry.isFile() || !routingIndexFilePattern.test(entry.name)) {
				throw invalidJournal('Routing index contains an unexpected entry')
			}
			return [entry.name]
		}).sort((left, right) => left === right ? 0 : left < right ? 1 : -1)
		if (names.length > maxTaskDirectories) {
			throw traversalLimit(
				`Routing index exceeds the ${maxTaskDirectories}-task traversal limit`,
			)
		}

		const timelines: Array<TaskTimeline> = []
		let includedEvents = 0
		let includedBytes = 0
		for (const name of names.slice(0, limit)) {
			signal?.throwIfAborted()
			const match = routingIndexFilePattern.exec(name)
			if (match === null) {
				throw invalidJournal('Routing index entry name is invalid')
			}
			const entryPath = path.join(modeDirectory, name)
			const pendingName = pendingByFinalName.get(name)
			const contents = pendingName === undefined
				? await readBoundedRegularFile(artifactRoot, entryPath, maxEventBytes)
				: await readBoundedPublicationFile(
					artifactRoot,
					entryPath,
					path.join(modeDirectory, pendingName),
					maxEventBytes,
				)
			if (digest(contents) !== match[3]?.toLowerCase()) {
				throw invalidJournal('Routing index entry digest does not match its name')
			}
			const entry = parseRoutingIndexEntry(contents, mode)
			if (
				entry.taskId !== match[2] ||
				Date.parse(entry.createdAt) !== Number(match[1])
			) {
				throw invalidJournal('Routing index entry does not match its name')
			}
			const marker = await this.readTaskReadyMarker(
				artifactRoot,
				entry.taskId,
				signal,
			)
			if (marker === null || marker.firstEventSha256 !== entry.firstEventSha256) {
				throw invalidJournal('Routing index entry does not match a published task')
			}
			const result = await this.readTimeline(
				artifactRoot,
				entry.taskId,
				marker,
				signal,
			)
			if (
				result.timeline.task.mode !== mode ||
				result.timeline.task.createdAt !== entry.createdAt
			) {
				throw invalidJournal('Routing index entry does not match TaskCreated')
			}
			if (
				timelines.length > 0 &&
				(includedEvents + result.timeline.events.length > maxEventsPerList ||
					includedBytes + result.bytesRead > maxListBytes)
			) {
				break
			}
			timelines.push(result.timeline)
			includedEvents += result.timeline.events.length
			includedBytes += result.bytesRead
		}
		return timelines
	}

	private async readTimeline(
		artifactRoot: string,
		taskId: string,
		knownMarker?: TaskReadyMarker,
		signal?: AbortSignal,
	): Promise<TimelineReadResult> {
		signal?.throwIfAborted()
		validateUuid(taskId, 'task ID')
		const marker = knownMarker ??
			await this.readTaskReadyMarker(artifactRoot, taskId, signal)
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
			signal?.throwIfAborted()
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
		signal?: AbortSignal,
	): Promise<TaskReadyMarker | null> {
		signal?.throwIfAborted()
		const taskDirectory = path.join(
			artifactRoot,
			taskDirectoryName,
			taskId,
		)
		try {
			await assertPrivateDirectory(artifactRoot, taskDirectory)
			signal?.throwIfAborted()
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

	private async publishRoutingIndexEntry(
		artifactRoot: string,
		event: TaskEvent,
		firstEventSha256: string,
	): Promise<void> {
		if (event.type !== 'TaskCreated') {
			throw invalidJournal('Routing index requires TaskCreated')
		}
		const indexRoot = path.join(artifactRoot, routingIndexDirectoryName)
		const modeDirectory = path.join(indexRoot, event.data.mode)
		await ensurePrivateDirectory(artifactRoot, indexRoot, { recursive: true })
		await ensurePrivateDirectory(artifactRoot, modeDirectory, { recursive: true })
		const contents = serializeRoutingIndexEntry({
			schemaVersion: 1,
			taskId: event.taskId,
			mode: event.data.mode,
			createdAt: event.occurredAt,
			firstEventSha256,
		})
		await writeExclusiveRegularFile(
			artifactRoot,
			path.join(
				modeDirectory,
				routingIndexFileName(
					event.occurredAt,
					event.taskId,
					digest(contents),
				),
			),
			contents,
		)
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

type RoutingIndexEntry = {
	schemaVersion: 1
	taskId: string
	mode: WorkerMode
	createdAt: string
	firstEventSha256: string
}

function routingIndexFileName(
	createdAt: string,
	taskId: string,
	entrySha256: string,
): string {
	return `${String(Date.parse(createdAt)).padStart(13, '0')}-${taskId}-${entrySha256}.json`
}

function serializeRoutingIndexEntry(entry: RoutingIndexEntry): string {
	return `${JSON.stringify(entry)}\n`
}

function parseRoutingIndexEntry(
	contents: Buffer,
	expectedMode: WorkerMode,
): RoutingIndexEntry {
	try {
		const value: unknown = JSON.parse(contents.toString('utf8'))
		if (
			!isRecord(value) ||
			Object.keys(value).sort().join(',') !==
				'createdAt,firstEventSha256,mode,schemaVersion,taskId' ||
			value['schemaVersion'] !== 1 ||
			!uuidPattern.test(String(value['taskId'])) ||
			value['mode'] !== expectedMode ||
			typeof value['createdAt'] !== 'string' ||
			!Number.isFinite(Date.parse(value['createdAt'])) ||
			typeof value['firstEventSha256'] !== 'string' ||
			!/^[a-f0-9]{64}$/i.test(value['firstEventSha256'])
		) {
			throw invalidJournal('Routing index entry has an invalid shape')
		}
		return value as RoutingIndexEntry
	} catch (error) {
		if (error instanceof HarnessError) {
			throw error
		}
		throw invalidJournal('Routing index entry does not contain valid JSON')
	}
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
	schemaVersion: 1 | 2 | 3 | 4 | 5 | 6,
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

function arraysEqual(left: Array<string>, right: Array<string>): boolean {
	return left.length === right.length &&
		left.every((value, index) => value === right[index])
}

function traversalLimit(message: string): HarnessError {
	return new HarnessError('TASK_TRAVERSAL_LIMIT', message)
}
