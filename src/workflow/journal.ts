import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import type {
	WorkflowDefinition,
	WorkflowEvent,
	WorkflowEventInput,
	WorkflowPage,
	WorkflowSummary,
	WorkflowTimeline,
} from '../domain/types.js'
import { HarnessError } from '../lib/errors.js'
import { isRecord } from '../lib/json.js'
import { Redactor } from '../lib/redaction.js'
import {
	assertPrivateDirectory,
	createPrivateDirectory,
	ensurePrivateDirectory,
	readBoundedPublicationFile,
	readBoundedRegularFile,
	removePublicationStagingIfContentsMatch,
	removeRegularFileIfContentsMatch,
	writeExclusiveRegularFile,
} from '../artifacts/secure-io.js'
import {
	createWorkflowEvent,
	projectWorkflowEvent,
	serializeWorkflowEvent,
	validateWorkflowDefinition,
	validateWorkflowEvent,
	workflowEventSha256,
	workflowTimeline,
	type WorkflowProjection,
} from './event-model.js'

const workflowsDirectoryName = 'workflows'
const readyFileName = '.workflow-ready'
const maxEventBytes = 65_536
const maxEventsPerWorkflow = 512
const maxTimelineBytes = 2_097_152
const maxWorkflowDirectories = 10_000
const maxListEvents = 25_000
const maxListBytes = 8_388_608
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const eventFilePattern = /^([0-9]{12})-([a-f0-9]{64})\.json$/i
const pendingFilePattern = /^\.publish-[0-9a-f-]{36}-(.+)$/i
const maxPublicationReconciliationPasses = 4

type WorkflowReadResult = {
	timeline: WorkflowTimeline
	projection: WorkflowProjection
	bytesRead: number
}

type WorkflowReadyMarker = {
	schemaVersion: 1
	workflowId: string
	firstEventSha256: string
}

export async function reconcileWorkflowEventPublications(
	artifactRoot: string,
	workflowId: string,
): Promise<void> {
	validateUuid(workflowId)
	const eventsDirectory = path.join(
		artifactRoot,
		workflowsDirectoryName,
		workflowId,
		'events',
	)
	try {
		await assertPrivateDirectory(artifactRoot, eventsDirectory)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return
		}
		throw error
	}

	for (let pass = 0; pass < maxPublicationReconciliationPasses; pass += 1) {
		const entries = await readdir(eventsDirectory, { withFileTypes: true })
		if (entries.length > maxEventsPerWorkflow * 2) {
			throw new HarnessError('WORKFLOW_EVENT_LIMIT', 'Workflow has too many events')
		}
		const pendingByFinalName = collectPendingPublications(entries)
		if (pendingByFinalName.size === 0) {
			return
		}

		for (const [finalName, pendingName] of pendingByFinalName) {
			const finalPath = path.join(eventsDirectory, finalName)
			const pendingPath = path.join(eventsDirectory, pendingName)
			const finalExists = entries.some(entry => entry.name === finalName)
			try {
				const contents = finalExists
					? await readBoundedPublicationFile(
						artifactRoot,
						finalPath,
						pendingPath,
						maxEventBytes,
					)
					: await readBoundedRegularFile(
						artifactRoot,
						pendingPath,
						maxEventBytes,
					)
				assertRecoverableEvent(contents, workflowId, finalName)
				const removed = finalExists
					? await removePublicationStagingIfContentsMatch(
						artifactRoot,
						finalPath,
						pendingPath,
						contents,
						maxEventBytes,
					)
					: await removeRegularFileIfContentsMatch(
						artifactRoot,
						pendingPath,
						contents,
						maxEventBytes,
					)
				if (!removed) {
					throw invalidJournal('Workflow event staging changed during recovery')
				}
			} catch (error) {
				if (!isPublicationRace(error)) {
					throw error
				}
			}
		}
	}

	throw new HarnessError(
		'WORKFLOW_BUSY',
		'Workflow event publication did not settle during recovery',
	)
}

export class WorkflowJournal {
	private readonly redactor: Redactor

	constructor(redactor = new Redactor()) {
		this.redactor = redactor
	}

	async create(
		artifactRoot: string,
		definition: WorkflowDefinition,
	): Promise<WorkflowTimeline> {
		if (!validateWorkflowDefinition(definition)) {
			throw new HarnessError(
				'INVALID_WORKFLOW_DEFINITION',
				'Workflow definition does not satisfy the durable execution contract',
			)
		}
		if (this.redactor.containsCredentialMaterial(definition)) {
			throw new HarnessError(
				'WORKFLOW_CONTAINS_SECRET',
				'Workflow configuration contains credential material and cannot be persisted',
			)
		}
		const workflowId = randomUUID()
		const workflowsRoot = path.join(artifactRoot, workflowsDirectoryName)
		const workflowDirectory = path.join(workflowsRoot, workflowId)
		const eventsDirectory = path.join(workflowDirectory, 'events')
		const event = createWorkflowEvent(workflowId, 1, null, {
			type: 'WorkflowCreated',
			data: { definition },
		})
		const serializedEvent = serializeWorkflowEvent(event)
		this.assertSafeToPersist(event)
		assertEventSize(serializedEvent)
		const eventSha256 = workflowEventSha256(serializedEvent)
		const projection = projectWorkflowEvent(null, event, eventSha256, true)
		await ensurePrivateDirectory(artifactRoot, artifactRoot, { recursive: true })
		await ensurePrivateDirectory(artifactRoot, workflowsRoot, { recursive: true })
		try {
			await createPrivateDirectory(artifactRoot, workflowDirectory)
		} catch (error) {
			throw new HarnessError(
				'WORKFLOW_ID_COLLISION',
				`Workflow directory already exists or cannot be created: ${workflowId}`,
				{ cause: error instanceof Error ? error.message : String(error) },
			)
		}
		await createPrivateDirectory(artifactRoot, eventsDirectory)

		await writeExclusiveRegularFile(
			artifactRoot,
			path.join(eventsDirectory, eventFileName(1, eventSha256)),
			serializedEvent,
		)
		await writeExclusiveRegularFile(
			artifactRoot,
			path.join(workflowDirectory, readyFileName),
			serializeReadyMarker(workflowId, eventSha256),
		)
		return workflowTimeline(projection, [event])
	}

	async append(
		artifactRoot: string,
		workflowId: string,
		input: WorkflowEventInput,
		signal?: AbortSignal,
	): Promise<WorkflowEvent> {
		signal?.throwIfAborted()
		validateUuid(workflowId)
		const current = await this.readTimeline(
			artifactRoot,
			workflowId,
			undefined,
			signal,
		)
		if (current.timeline.events.length >= maxEventsPerWorkflow) {
			throw new HarnessError(
				'WORKFLOW_EVENT_LIMIT',
				`Workflow exceeds the ${maxEventsPerWorkflow}-event journal limit`,
			)
		}

		const event = createWorkflowEvent(
			workflowId,
			current.timeline.events.length + 1,
			current.timeline.summary.latestEventSha256,
			input,
		)
		const serializedEvent = serializeWorkflowEvent(event)
		this.assertSafeToPersist(event)
		assertEventSize(serializedEvent)
		validateWorkflowEvent(
			event,
			workflowId,
			current.timeline.events.length + 1,
		)
		const eventSha256 = workflowEventSha256(serializedEvent)
		projectWorkflowEvent(current.projection, event, eventSha256, true)
		if (current.bytesRead + Buffer.byteLength(serializedEvent) > maxTimelineBytes) {
			throw new HarnessError(
				'WORKFLOW_EVENT_LIMIT',
				`Workflow history exceeds the ${maxTimelineBytes}-byte limit`,
			)
		}

		const eventsDirectory = path.join(
			artifactRoot,
			workflowsDirectoryName,
			workflowId,
			'events',
		)
		await writeExclusiveRegularFile(
			artifactRoot,
			path.join(eventsDirectory, eventFileName(event.sequence, eventSha256)),
			serializedEvent,
			0o600,
			signal,
		)
		return event
	}

	private assertSafeToPersist(event: WorkflowEvent): void {
		if (this.redactor.containsCredentialMaterial(event)) {
			throw new HarnessError(
				'WORKFLOW_CONTAINS_SECRET',
				'Workflow history contains credential material and cannot be persisted',
			)
		}
	}

	async timeline(
		artifactRoot: string,
		workflowId: string,
		signal?: AbortSignal,
	): Promise<WorkflowTimeline> {
		signal?.throwIfAborted()
		validateUuid(workflowId)
		await this.assertJournalAncestors(artifactRoot, workflowId)
		return (await this.readTimeline(
			artifactRoot,
			workflowId,
			undefined,
			signal,
		)).timeline
	}

	async list(
		artifactRoot: string,
		limit: number,
		cursor: string | null,
		signal?: AbortSignal,
	): Promise<WorkflowPage> {
		signal?.throwIfAborted()
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			throw new HarnessError(
				'INVALID_WORKFLOW_LIMIT',
				'Workflow list limit must be between 1 and 100',
			)
		}
		if (cursor !== null) {
			validateUuid(cursor)
		}
		const workflowsRoot = path.join(artifactRoot, workflowsDirectoryName)
		try {
			await assertPrivateDirectory(artifactRoot, artifactRoot)
			await assertPrivateDirectory(artifactRoot, workflowsRoot)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return { workflows: [], nextCursor: null }
			}
			throw error
		}

		const entries = await readdir(workflowsRoot, { withFileTypes: true })
		if (entries.length > maxWorkflowDirectories) {
			throw traversalLimit('Workflow history contains too many directories')
		}
		const summaries: Array<WorkflowSummary> = []
		let eventCount = 0
		let byteCount = 0
		for (const entry of entries) {
			signal?.throwIfAborted()
			if (!entry.isDirectory() || !uuidPattern.test(entry.name)) {
				throw invalidJournal('Workflow history contains an unexpected entry')
			}
			const marker = await this.readReadyMarker(
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
			eventCount += result.timeline.events.length
			byteCount += result.bytesRead
			if (eventCount > maxListEvents || byteCount > maxListBytes) {
				throw traversalLimit('Workflow listing exceeds its aggregate read bound')
			}
			summaries.push(result.timeline.summary)
		}

		summaries.sort((left, right) =>
			right.createdAt.localeCompare(left.createdAt) ||
			right.workflowId.localeCompare(left.workflowId),
		)
		let startIndex = 0
		if (cursor !== null) {
			const cursorIndex = summaries.findIndex(item => item.workflowId === cursor)
			if (cursorIndex === -1) {
				throw new HarnessError(
					'INVALID_WORKFLOW_CURSOR',
					'Workflow cursor is not present in the result set',
				)
			}
			startIndex = cursorIndex + 1
		}
		const workflows = summaries.slice(startIndex, startIndex + limit)
		return {
			workflows,
			nextCursor: startIndex + workflows.length < summaries.length
				? workflows.at(-1)?.workflowId ?? null
				: null,
		}
	}

	workflowDirectory(artifactRoot: string, workflowId: string): string {
		validateUuid(workflowId)
		return path.join(artifactRoot, workflowsDirectoryName, workflowId)
	}

	private async assertJournalAncestors(
		artifactRoot: string,
		workflowId: string,
	): Promise<void> {
		try {
			await assertPrivateDirectory(artifactRoot, artifactRoot)
			await assertPrivateDirectory(
				artifactRoot,
				path.join(artifactRoot, workflowsDirectoryName),
			)
			await assertPrivateDirectory(
				artifactRoot,
				path.join(artifactRoot, workflowsDirectoryName, workflowId),
			)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				throw new HarnessError(
					'WORKFLOW_NOT_FOUND',
					`Workflow history is not published: ${workflowId}`,
				)
			}
			throw error
		}
	}

	private async readTimeline(
		artifactRoot: string,
		workflowId: string,
		knownMarker?: WorkflowReadyMarker,
		signal?: AbortSignal,
	): Promise<WorkflowReadResult> {
		signal?.throwIfAborted()
		validateUuid(workflowId)
		const marker = knownMarker ??
			await this.readReadyMarker(artifactRoot, workflowId, signal)
		if (marker === null) {
			throw new HarnessError(
				'WORKFLOW_NOT_FOUND',
				`Workflow history is not published: ${workflowId}`,
			)
		}
		const eventsDirectory = path.join(
			artifactRoot,
			workflowsDirectoryName,
			workflowId,
			'events',
		)
		try {
			await assertPrivateDirectory(artifactRoot, eventsDirectory)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				throw invalidJournal('Published workflow is missing its event directory')
			}
			throw error
		}

		const entries = await readdir(eventsDirectory, { withFileTypes: true })
		if (entries.length > maxEventsPerWorkflow * 2) {
			throw new HarnessError('WORKFLOW_EVENT_LIMIT', 'Workflow has too many events')
		}
		const pendingByFinalName = collectPendingPublications(entries)
		const names = entries.flatMap(entry => {
			if (pendingFilePattern.test(entry.name)) {
				if (!entry.isFile()) {
					throw invalidJournal('Workflow staging entry is not a file')
				}
				return []
			}
			if (!entry.isFile() || !eventFilePattern.test(entry.name)) {
				throw invalidJournal('Workflow event directory contains an unexpected entry')
			}
			return [entry.name]
		}).sort()
		if (names.length === 0) {
			throw invalidJournal('Published workflow contains no events')
		}
		if (names.length > maxEventsPerWorkflow) {
			throw new HarnessError('WORKFLOW_EVENT_LIMIT', 'Workflow has too many events')
		}

		const events: Array<WorkflowEvent> = []
		let projection: WorkflowProjection | null = null
		let previousEventSha256: string | null = null
		let bytesRead = 0
		for (const [index, name] of names.entries()) {
			signal?.throwIfAborted()
			const expectedSequence = index + 1
			const match = eventFilePattern.exec(name)
			if (match === null || Number(match[1]) !== expectedSequence) {
				throw invalidJournal('Workflow event sequence is not contiguous')
			}
			const eventPath = path.join(eventsDirectory, name)
			const pendingName = pendingByFinalName.get(name)
			const contents = pendingName === undefined
				? await readBoundedRegularFile(artifactRoot, eventPath, maxEventBytes)
				: await readBoundedPublicationFile(
					artifactRoot,
					eventPath,
					path.join(eventsDirectory, pendingName),
					maxEventBytes,
				)
			bytesRead += contents.length
			if (bytesRead > maxTimelineBytes) {
				throw new HarnessError(
					'WORKFLOW_EVENT_LIMIT',
					'Workflow timeline exceeds its byte bound',
				)
			}
			const eventSha256 = workflowEventSha256(contents)
			if (eventSha256 !== match[2]?.toLowerCase()) {
				throw invalidJournal('Workflow event digest does not match its name')
			}
			const event = parseEvent(contents, workflowId, expectedSequence)
			this.assertSafeToPersist(event)
			if (event.previousEventSha256 !== previousEventSha256) {
				throw invalidJournal('Workflow event digest chain is broken')
			}
			if (expectedSequence === 1 && eventSha256 !== marker.firstEventSha256) {
				throw invalidJournal('Workflow ready marker does not match WorkflowCreated')
			}
			projection = projectWorkflowEvent(
				projection,
				event,
				eventSha256,
				false,
			)
			events.push(event)
			previousEventSha256 = eventSha256
		}
		if (projection === null) {
			throw invalidJournal('Workflow journal could not be projected')
		}
		return {
			timeline: workflowTimeline(projection, events),
			projection,
			bytesRead,
		}
	}

	private async readReadyMarker(
		artifactRoot: string,
		workflowId: string,
		signal?: AbortSignal,
	): Promise<WorkflowReadyMarker | null> {
		signal?.throwIfAborted()
		const workflowDirectory = path.join(
			artifactRoot,
			workflowsDirectoryName,
			workflowId,
		)
		try {
			await assertPrivateDirectory(artifactRoot, workflowDirectory)
			const entries = await readdir(workflowDirectory, { withFileTypes: true })
			if (entries.length > 4) {
				throw invalidJournal('Workflow directory contains too many entries')
			}
			const pendingByFinalName = collectPendingPublications(entries, /^\.workflow-ready$/)
			let stagingOnly = false
			for (const entry of entries) {
				const match = pendingFilePattern.exec(entry.name)
				if (entry.isDirectory() && entry.name === 'events') {
					continue
				}
				if (entry.isFile() && entry.name === readyFileName) {
					continue
				}
				if (entry.isFile() && match?.[1] === readyFileName) {
					stagingOnly = true
					continue
				}
				throw invalidJournal('Workflow directory contains an unexpected entry')
			}
			if (
				stagingOnly &&
				!entries.some(entry => entry.isFile() && entry.name === readyFileName)
			) {
				return null
			}
			const finalPath = path.join(workflowDirectory, readyFileName)
			const pendingName = pendingByFinalName.get(readyFileName)
			const contents = pendingName === undefined
				? await readBoundedRegularFile(artifactRoot, finalPath, 256)
				: await readBoundedPublicationFile(
					artifactRoot,
					finalPath,
					path.join(workflowDirectory, pendingName),
					256,
				)
			return parseReadyMarker(contents, workflowId)
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
	finalPattern = eventFilePattern,
): Map<string, string> {
	const pending = new Map<string, string>()
	for (const entry of entries) {
		const match = pendingFilePattern.exec(entry.name)
		if (match === null) {
			continue
		}
		const finalName = match[1]
		if (
			!entry.isFile() ||
			finalName === undefined ||
			!finalPattern.test(finalName) ||
			pending.has(finalName)
		) {
			throw invalidJournal('Workflow journal contains invalid staging state')
		}
		pending.set(finalName, entry.name)
	}
	return pending
}

function assertRecoverableEvent(
	contents: Buffer,
	workflowId: string,
	finalName: string,
): void {
	const match = eventFilePattern.exec(finalName)
	if (
		match === null ||
		workflowEventSha256(contents) !== match[2]?.toLowerCase()
	) {
		throw invalidJournal('Workflow event staging digest is invalid')
	}
	parseEvent(contents, workflowId, Number(match[1]))
}

function isPublicationRace(error: unknown): boolean {
	if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
		return true
	}
	return error instanceof HarnessError &&
		(error.code === 'ARTIFACT_HARD_LINK_DENIED' ||
			error.code === 'ARTIFACT_WRITE_FAILED')
}

function eventFileName(sequence: number, sha256: string): string {
	return `${String(sequence).padStart(12, '0')}-${sha256}.json`
}

function serializeReadyMarker(workflowId: string, firstEventSha256: string): string {
	return `${JSON.stringify({
		schemaVersion: 1,
		workflowId,
		firstEventSha256,
	})}\n`
}

function parseReadyMarker(
	contents: Buffer,
	expectedWorkflowId: string,
): WorkflowReadyMarker {
	try {
		const value: unknown = JSON.parse(decodeUtf8(contents))
		if (
			!isRecord(value) ||
			Object.keys(value).sort().join(',') !==
				'firstEventSha256,schemaVersion,workflowId' ||
			value['schemaVersion'] !== 1 ||
			value['workflowId'] !== expectedWorkflowId ||
			typeof value['firstEventSha256'] !== 'string' ||
			!/^[a-f0-9]{64}$/i.test(value['firstEventSha256'])
		) {
			throw invalidJournal('Workflow ready marker has an invalid shape')
		}
		return value as WorkflowReadyMarker
	} catch (error) {
		if (error instanceof HarnessError) {
			throw error
		}
		throw invalidJournal('Workflow ready marker is not valid UTF-8 JSON')
	}
}

function parseEvent(
	contents: Buffer,
	workflowId: string,
	sequence: number,
): WorkflowEvent {
	try {
		return validateWorkflowEvent(
			JSON.parse(decodeUtf8(contents)),
			workflowId,
			sequence,
		)
	} catch (error) {
		if (error instanceof HarnessError) {
			throw error
		}
		throw invalidJournal('Workflow event is not valid UTF-8 JSON')
	}
}

function decodeUtf8(contents: Buffer): string {
	return new TextDecoder('utf-8', { fatal: true }).decode(contents)
}

function assertEventSize(serializedEvent: string): void {
	if (Buffer.byteLength(serializedEvent) > maxEventBytes) {
		throw new HarnessError(
			'WORKFLOW_EVENT_LIMIT',
			`Workflow event exceeds the ${maxEventBytes}-byte limit`,
		)
	}
}

function validateUuid(value: string): void {
	if (!uuidPattern.test(value)) {
		throw new HarnessError('INVALID_WORKFLOW_ID', 'Workflow ID must be a UUID')
	}
}

function invalidJournal(message: string): HarnessError {
	return new HarnessError('INVALID_WORKFLOW_JOURNAL', message)
}

function traversalLimit(message: string): HarnessError {
	return new HarnessError('WORKFLOW_TRAVERSAL_LIMIT', message)
}
