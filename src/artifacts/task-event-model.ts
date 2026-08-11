import type {
	EvaluationDimensionId,
	EvaluationOutcome,
	RoutingStrategy,
	RunStatus,
	TaskEvent,
	TaskSummary,
	WorkerMode,
} from '../domain/types.js'
import { HarnessError } from '../lib/errors.js'
import { isRecord } from '../lib/json.js'
import { isWorkflowTaskProvenance } from '../workflow/provenance.js'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const sha256Pattern = /^[a-f0-9]{64}$/i

type AttemptProjection = {
	runId: string
	workerId: string
	attemptNumber: number
	workerCompleted: boolean
	workerOutcome: 'succeeded' | 'failed' | null
	patchSha256: string | null
	patchChangedFileCount: number | null
	validationCompleted: boolean
	validationOutcome: 'passed' | 'failed' | 'skipped' | null
	evaluationCompleted: boolean
	evaluationOutcome: EvaluationOutcome | null
	evaluationPolicy: 'default' | 'strict' | null
	status: RunStatus | null
	failureCode: string | null
}

export type TaskEventProjection = {
	summary: TaskSummary
	strategy: RoutingStrategy | null
	candidateWorkerIds: Array<string>
	maxAttempts: number
	activeAttempt: AttemptProjection | null
	lastAttempt: AttemptProjection | null
	knownRunIds: Set<string>
	applicationRunId: string | null
	eventSchemaVersion: 1 | 2 | 3 | 4 | 5 | 6
}

export function validateTaskEvent(
	value: unknown,
	expectedTaskId: string,
	expectedSequence: number,
): asserts value is TaskEvent {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			'schemaVersion',
			'eventId',
			'taskId',
			'sequence',
			'occurredAt',
			'previousEventSha256',
			'type',
			'data',
		]) ||
		(value['schemaVersion'] !== 1 &&
			value['schemaVersion'] !== 2 &&
			value['schemaVersion'] !== 3 &&
			value['schemaVersion'] !== 4 &&
			value['schemaVersion'] !== 5 &&
			value['schemaVersion'] !== 6) ||
		!isUuid(value['eventId']) ||
		value['taskId'] !== expectedTaskId ||
		value['sequence'] !== expectedSequence ||
		!isIsoDate(value['occurredAt']) ||
		(expectedSequence === 1
			? value['previousEventSha256'] !== null
			: typeof value['previousEventSha256'] !== 'string' ||
				!sha256Pattern.test(value['previousEventSha256'])) ||
		!isRecord(value['data'])
	) {
		throw invalidJournal('Task event has an invalid envelope')
	}

	const data = value['data']
	switch (value['type']) {
		case 'TaskCreated':
			if (
				expectedSequence !== 1 ||
				!hasExactKeys(
					data,
					value['schemaVersion'] >= 6
						? [
							'objective',
							'mode',
							'repositoryPath',
							'baseCommit',
							'policySha256',
							'policySourceCount',
							'workflowProvenance',
						]
						: value['schemaVersion'] >= 4
						? [
							'objective',
							'mode',
							'repositoryPath',
							'baseCommit',
							'policySha256',
							'policySourceCount',
						]
						: [
							'objective',
							'mode',
							'repositoryPath',
							'baseCommit',
						],
				) ||
				!isBoundedString(data['objective'], 4_000) ||
				!isWorkerMode(data['mode']) ||
				!isBoundedString(data['repositoryPath'], 4_096) ||
				!isBoundedString(data['baseCommit'], 1_024) ||
				(value['schemaVersion'] >= 4 &&
					(typeof data['policySha256'] !== 'string' ||
						!sha256Pattern.test(data['policySha256']) ||
						!isIntegerInRange(data['policySourceCount'], 0, 2))) ||
				(value['schemaVersion'] >= 6 &&
					!isWorkflowTaskProvenance(data['workflowProvenance']))
			) {
				throw invalidJournal('TaskCreated event has invalid data')
			}
			return
		case 'RouteSelected':
			if (
				!hasExactKeys(
					data,
					value['schemaVersion'] >= 5
						? [
							'strategy',
							'candidateWorkerIds',
							'maxAttempts',
							'evidenceSha256',
							'evidenceTaskCount',
							'evidenceAttemptCount',
							'decisionSha256',
						]
						: [
							'strategy',
							'candidateWorkerIds',
							'maxAttempts',
						],
				) ||
				!isRoutingStrategy(data['strategy']) ||
				!isBoundedStringArray(data['candidateWorkerIds'], 64, 64) ||
				data['candidateWorkerIds'].length === 0 ||
				new Set(data['candidateWorkerIds']).size !==
					data['candidateWorkerIds'].length ||
				!isIntegerInRange(data['maxAttempts'], 1, 8) ||
				data['maxAttempts'] > data['candidateWorkerIds'].length ||
				(value['schemaVersion'] >= 5 &&
					(typeof data['evidenceSha256'] !== 'string' ||
						!sha256Pattern.test(data['evidenceSha256']) ||
						!isIntegerInRange(data['evidenceTaskCount'], 0, 100) ||
						!isIntegerInRange(data['evidenceAttemptCount'], 0, 800) ||
						typeof data['decisionSha256'] !== 'string' ||
						!sha256Pattern.test(data['decisionSha256'])))
			) {
				throw invalidJournal('RouteSelected event has invalid data')
			}
			return
		case 'WorkerStarted':
			if (
				!hasExactKeys(data, ['runId', 'workerId', 'attemptNumber']) ||
				!isUuid(data['runId']) ||
				!isBoundedString(data['workerId'], 64) ||
				!isIntegerInRange(data['attemptNumber'], 1, 8)
			) {
				throw invalidJournal('WorkerStarted event has invalid data')
			}
			return
		case 'ToolCalled':
			if (
				!hasExactKeys(data, [
					'runId',
					'toolName',
					'iteration',
					'outcome',
					'inputBytes',
					'outputBytes',
					'durationMs',
				]) ||
				!isUuid(data['runId']) ||
				!isBoundedString(data['toolName'], 100) ||
				!isPositiveInteger(data['iteration']) ||
				(data['outcome'] !== 'succeeded' && data['outcome'] !== 'failed') ||
				!isNonNegativeInteger(data['inputBytes']) ||
				!isNonNegativeInteger(data['outputBytes']) ||
				!isNonNegativeInteger(data['durationMs'])
			) {
				throw invalidJournal('ToolCalled event has invalid data')
			}
			return
		case 'WorkerCompleted':
			if (
				!hasExactKeys(data, [
					'runId',
					'outcome',
					'failureCode',
					'requestCount',
				]) ||
				!isUuid(data['runId']) ||
				(data['outcome'] !== 'succeeded' && data['outcome'] !== 'failed') ||
				!isNullableBoundedString(data['failureCode'], 200) ||
				((data['outcome'] === 'succeeded') !== (data['failureCode'] === null)) ||
				!isNonNegativeInteger(data['requestCount'])
			) {
				throw invalidJournal('WorkerCompleted event has invalid data')
			}
			return
		case 'PatchProduced':
			if (
				!hasExactKeys(data, [
					'runId',
					'patchSha256',
					'patchBytes',
					'changedFileCount',
				]) ||
				!isUuid(data['runId']) ||
				typeof data['patchSha256'] !== 'string' ||
				!sha256Pattern.test(data['patchSha256']) ||
				!isPositiveInteger(data['patchBytes']) ||
				!isIntegerInRange(data['changedFileCount'], 1, 10_000)
			) {
				throw invalidJournal('PatchProduced event has invalid data')
			}
			return
		case 'ValidationCompleted':
			if (
				!hasExactKeys(data, ['runId', 'outcome', 'commandCount']) ||
				!isUuid(data['runId']) ||
				(data['outcome'] !== 'passed' &&
					data['outcome'] !== 'failed' &&
					data['outcome'] !== 'skipped') ||
				!isIntegerInRange(data['commandCount'], 0, 20) ||
				(data['outcome'] === 'skipped' && data['commandCount'] !== 0) ||
				(data['outcome'] === 'passed' && data['commandCount'] === 0)
			) {
				throw invalidJournal('ValidationCompleted event has invalid data')
			}
			return
		case 'EvaluationCompleted':
			if (
				(value['schemaVersion'] !== 2 &&
					value['schemaVersion'] !== 3 &&
					value['schemaVersion'] !== 4 &&
					value['schemaVersion'] !== 5 &&
					value['schemaVersion'] !== 6) ||
				!hasExactKeys(
					data,
					value['schemaVersion'] >= 3
						? [
							'runId',
							'evaluatorIds',
							'outcome',
							'evaluationPolicy',
							'failedDimensions',
							'unknownDimensions',
						]
						: [
							'runId',
							'evaluatorIds',
							'outcome',
							'failedDimensions',
							'unknownDimensions',
						],
				) ||
				!isUuid(data['runId']) ||
				!isUniqueBoundedStringArray(data['evaluatorIds'], 8, 100) ||
				data['evaluatorIds'][0] !== 'deterministic-v1' ||
				!isEvaluationOutcome(data['outcome']) ||
				(value['schemaVersion'] >= 3 &&
					data['evaluationPolicy'] !== 'default' &&
					data['evaluationPolicy'] !== 'strict') ||
				!isEvaluationDimensionIds(data['failedDimensions']) ||
				!isEvaluationDimensionIds(data['unknownDimensions']) ||
				!areEvaluationDimensionSetsDisjoint(
					data['failedDimensions'],
					data['unknownDimensions'],
				) ||
				(data['outcome'] === 'passed' &&
					(data['failedDimensions'].length > 0 ||
						data['unknownDimensions'].length > 0)) ||
				(data['outcome'] === 'failed' && data['failedDimensions'].length === 0) ||
				(data['outcome'] === 'inconclusive' &&
					(data['failedDimensions'].length > 0 ||
						data['unknownDimensions'].length === 0))
			) {
				throw invalidJournal('EvaluationCompleted event has invalid data')
			}
			return
		case 'AttemptCompleted':
			if (
				!hasExactKeys(
					data,
					value['schemaVersion'] >= 5
						? [
							'runId',
							'status',
							'failureCode',
							'durationMs',
							'providerLatencyMs',
							'totalTokens',
							'estimatedCostMicroUsd',
						]
						: ['runId', 'status', 'failureCode'],
				) ||
				!isUuid(data['runId']) ||
				!isRunStatus(data['status']) ||
				!isNullableBoundedString(data['failureCode'], 200) ||
				(value['schemaVersion'] >= 5 &&
					(!isNonNegativeInteger(data['durationMs']) ||
						!isNonNegativeInteger(data['providerLatencyMs']) ||
						!isNonNegativeInteger(data['totalTokens']) ||
						(data['estimatedCostMicroUsd'] !== null &&
							!isNonNegativeInteger(data['estimatedCostMicroUsd']))))
			) {
				throw invalidJournal('AttemptCompleted event has invalid data')
			}
			return
		case 'TaskCompleted':
			if (
				!hasExactKeys(data, ['runId', 'status']) ||
				(data['runId'] !== null && !isUuid(data['runId'])) ||
				!isRunStatus(data['status'])
			) {
				throw invalidJournal('TaskCompleted event has invalid data')
			}
			return
		case 'PatchApplicationRequested':
			if (!hasExactKeys(data, ['runId']) || !isUuid(data['runId'])) {
				throw invalidJournal('PatchApplicationRequested event has invalid data')
			}
			return
		case 'PatchApproved':
			if (
				!hasExactKeys(data, ['runId', 'source']) ||
				!isUuid(data['runId']) ||
				data['source'] !== 'mcp_call'
			) {
				throw invalidJournal('PatchApproved event has invalid data')
			}
			return
		case 'PatchApplied':
			if (
				!hasExactKeys(data, ['runId', 'changedFileCount']) ||
				!isUuid(data['runId']) ||
				!isIntegerInRange(data['changedFileCount'], 1, 10_000)
			) {
				throw invalidJournal('PatchApplied event has invalid data')
			}
			return
		case 'PatchApplicationRejected':
			if (
				!hasExactKeys(data, ['runId', 'failureCode']) ||
				!isUuid(data['runId']) ||
				!isBoundedString(data['failureCode'], 200)
			) {
				throw invalidJournal('PatchApplicationRejected event has invalid data')
			}
			return
		default:
			throw invalidJournal('Task event type is unsupported')
	}
}

export function projectTaskEvent(
	current: TaskEventProjection | null,
	event: TaskEvent,
	eventSha256: string,
	appendOperation: boolean,
): TaskEventProjection {
	if (event.type === 'TaskCreated') {
		if (current !== null) {
			throw transitionError('TaskCreated must be the first event', appendOperation)
		}
		return {
			summary: {
				schemaVersion: 1,
				taskId: event.taskId,
				objective: event.data.objective,
				mode: event.data.mode,
				repositoryPath: event.data.repositoryPath,
				baseCommit: event.data.baseCommit,
				createdAt: event.occurredAt,
				updatedAt: event.occurredAt,
				status: 'in_progress',
				attemptCount: 0,
				latestRunId: null,
				workerIds: [],
				eventCount: 1,
				latestEventSha256: eventSha256,
				patchApplicationStatus: 'not_requested',
				policySha256: event.data.policySha256 ?? null,
			},
			strategy: null,
			candidateWorkerIds: [],
			maxAttempts: 0,
			activeAttempt: null,
			lastAttempt: null,
			knownRunIds: new Set(),
			applicationRunId: null,
			eventSchemaVersion: event.schemaVersion,
		}
	}

	if (current === null) {
		throw transitionError('Task journal must begin with TaskCreated', appendOperation)
	}
	if (event.schemaVersion !== current.eventSchemaVersion) {
		throw transitionError('Task event schema version changed', appendOperation)
	}

	const next = cloneProjection(current, event, eventSha256)
	const executionEvent = !isPatchApplicationEvent(event)
	if (next.summary.status !== 'in_progress' && executionEvent) {
		throw transitionError(
			'Execution events cannot follow TaskCompleted',
			appendOperation,
		)
	}

	switch (event.type) {
		case 'RouteSelected':
			if (
				next.strategy !== null ||
				next.activeAttempt !== null ||
				next.lastAttempt !== null
			) {
				throw transitionError('RouteSelected is out of order', appendOperation)
			}
			next.strategy = event.data.strategy
			next.candidateWorkerIds = [...event.data.candidateWorkerIds]
			next.maxAttempts = event.data.maxAttempts
			break
		case 'WorkerStarted':
			if (
				next.strategy === null ||
				next.activeAttempt !== null ||
				next.knownRunIds.has(event.data.runId) ||
				event.data.attemptNumber !== next.summary.attemptCount + 1 ||
				event.data.attemptNumber > next.maxAttempts ||
				next.candidateWorkerIds[event.data.attemptNumber - 1] !==
					event.data.workerId ||
				(next.lastAttempt !== null && !isFallbackEligible(next.lastAttempt))
			) {
				throw transitionError('WorkerStarted is out of order or inconsistent with the route', appendOperation)
			}
			next.activeAttempt = {
				runId: event.data.runId,
				workerId: event.data.workerId,
				attemptNumber: event.data.attemptNumber,
				workerCompleted: false,
				workerOutcome: null,
				patchSha256: null,
				patchChangedFileCount: null,
				validationCompleted: false,
				validationOutcome: null,
				evaluationCompleted: false,
				evaluationOutcome: null,
				evaluationPolicy: null,
				status: null,
				failureCode: null,
			}
			next.knownRunIds.add(event.data.runId)
			next.summary.attemptCount = event.data.attemptNumber
			next.summary.latestRunId = event.data.runId
			if (!next.summary.workerIds.includes(event.data.workerId)) {
				next.summary.workerIds = [
					...next.summary.workerIds,
					event.data.workerId,
				]
			}
			break
		case 'ToolCalled':
			if (getActiveRun(next, event.data.runId, appendOperation).workerCompleted) {
				throw transitionError('ToolCalled cannot follow WorkerCompleted', appendOperation)
			}
			break
		case 'WorkerCompleted': {
			const activeAttempt = getActiveRun(next, event.data.runId, appendOperation)
			if (activeAttempt.workerCompleted) {
				throw transitionError('WorkerCompleted cannot be repeated', appendOperation)
			}
			activeAttempt.workerCompleted = true
			activeAttempt.workerOutcome = event.data.outcome
			break
		}
		case 'PatchProduced': {
			const activeAttempt = getActiveRun(next, event.data.runId, appendOperation)
			if (
				!activeAttempt.workerCompleted ||
				activeAttempt.validationCompleted ||
				activeAttempt.patchSha256 !== null
			) {
				throw transitionError('PatchProduced is out of order', appendOperation)
			}
			activeAttempt.patchSha256 = event.data.patchSha256
			activeAttempt.patchChangedFileCount = event.data.changedFileCount
			break
		}
		case 'ValidationCompleted': {
			const activeAttempt = getActiveRun(next, event.data.runId, appendOperation)
			if (
				!activeAttempt.workerCompleted ||
				activeAttempt.validationCompleted
			) {
				throw transitionError('ValidationCompleted is out of order', appendOperation)
			}
			activeAttempt.validationCompleted = true
			activeAttempt.validationOutcome = event.data.outcome
			break
		}
		case 'EvaluationCompleted': {
			const activeAttempt = getActiveRun(next, event.data.runId, appendOperation)
			if (
				!activeAttempt.validationCompleted ||
				activeAttempt.evaluationCompleted
			) {
				throw transitionError('EvaluationCompleted is out of order', appendOperation)
			}
			activeAttempt.evaluationCompleted = true
			activeAttempt.evaluationOutcome = event.data.outcome
			activeAttempt.evaluationPolicy =
				event.data.evaluationPolicy ?? 'default'
			break
		}
		case 'AttemptCompleted': {
			const activeAttempt = getActiveRun(next, event.data.runId, appendOperation)
			if (
				!activeAttempt.validationCompleted ||
				(next.eventSchemaVersion >= 2 && !activeAttempt.evaluationCompleted)
			) {
				throw transitionError(
					'AttemptCompleted requires validation and evaluation evidence',
					appendOperation,
				)
			}
			if (
				(event.data.status === 'completed' &&
					(activeAttempt.workerOutcome !== 'succeeded' ||
						activeAttempt.validationOutcome === 'failed' ||
						activeAttempt.evaluationOutcome === 'failed' ||
						(activeAttempt.evaluationPolicy === 'strict' &&
							activeAttempt.evaluationOutcome === 'inconclusive') ||
						event.data.failureCode !== null)) ||
				(next.eventSchemaVersion >= 2 &&
					event.data.status !== 'completed' &&
					activeAttempt.evaluationOutcome !== 'failed' &&
					!(next.eventSchemaVersion >= 3 &&
						event.data.status === 'failed' &&
						activeAttempt.evaluationPolicy === 'strict' &&
						activeAttempt.evaluationOutcome === 'inconclusive' &&
						event.data.failureCode === 'EVALUATION_INCONCLUSIVE')) ||
				(event.data.status !== 'completed' && event.data.failureCode === null)
			) {
				throw transitionError('AttemptCompleted outcome evidence is inconsistent', appendOperation)
			}
			activeAttempt.status = event.data.status
			activeAttempt.failureCode = event.data.failureCode
			next.lastAttempt = activeAttempt
			next.activeAttempt = null
			break
		}
		case 'TaskCompleted':
			if (next.strategy === null || next.activeAttempt !== null) {
				throw transitionError('TaskCompleted is out of order', appendOperation)
			}
			if (next.lastAttempt === null) {
				if (event.data.runId !== null || event.data.status !== 'timed_out') {
					throw transitionError('A task without attempts can only time out', appendOperation)
				}
			} else if (
				event.data.runId !== next.lastAttempt.runId ||
				event.data.status !== next.lastAttempt.status
			) {
				throw transitionError('TaskCompleted does not match the last attempt', appendOperation)
			}
			next.summary.status = event.data.status
			next.summary.latestRunId = event.data.runId ?? next.summary.latestRunId
			break
		case 'PatchApplicationRequested':
			assertApplicableRun(next, event.data.runId, appendOperation)
			if (
				next.summary.patchApplicationStatus !== 'not_requested' &&
				next.summary.patchApplicationStatus !== 'rejected'
			) {
				throw transitionError('Patch application request is already active or applied', appendOperation)
			}
			next.applicationRunId = event.data.runId
			next.summary.patchApplicationStatus = 'pending'
			break
		case 'PatchApproved':
			assertApplicationRun(next, event.data.runId, 'pending', appendOperation)
			next.summary.patchApplicationStatus = 'approved'
			break
		case 'PatchApplied':
			assertApplicationRun(next, event.data.runId, 'approved', appendOperation)
			if (event.data.changedFileCount !== next.lastAttempt?.patchChangedFileCount) {
				throw transitionError('PatchApplied changed-file count does not match PatchProduced', appendOperation)
			}
			next.summary.patchApplicationStatus = 'applied'
			break
		case 'PatchApplicationRejected':
			if (
				next.applicationRunId !== event.data.runId ||
				(next.summary.patchApplicationStatus !== 'pending' &&
					next.summary.patchApplicationStatus !== 'approved')
			) {
				throw transitionError('Patch rejection does not match an active application', appendOperation)
			}
			next.summary.patchApplicationStatus = 'rejected'
			break
	}

	return next
}

function cloneProjection(
	current: TaskEventProjection,
	event: TaskEvent,
	eventSha256: string,
): TaskEventProjection {
	return {
		...current,
		summary: {
			...current.summary,
			updatedAt: event.occurredAt,
			eventCount: event.sequence,
			latestEventSha256: eventSha256,
			workerIds: [...current.summary.workerIds],
		},
		candidateWorkerIds: [...current.candidateWorkerIds],
		activeAttempt: current.activeAttempt === null
			? null
			: { ...current.activeAttempt },
		lastAttempt: current.lastAttempt === null
			? null
			: { ...current.lastAttempt },
		knownRunIds: new Set(current.knownRunIds),
	}
}

function getActiveRun(
	projection: TaskEventProjection,
	runId: string,
	appendOperation: boolean,
): AttemptProjection {
	if (projection.activeAttempt?.runId !== runId) {
		throw transitionError('Event run ID does not match the active attempt', appendOperation)
	}
	return projection.activeAttempt
}

function assertApplicableRun(
	projection: TaskEventProjection,
	runId: string,
	appendOperation: boolean,
): void {
	if (
		projection.summary.status !== 'completed' ||
		projection.lastAttempt?.runId !== runId ||
		projection.lastAttempt.status !== 'completed' ||
		projection.lastAttempt.patchSha256 === null
	) {
		throw transitionError('Patch application does not match the completed task patch', appendOperation)
	}
}

function assertApplicationRun(
	projection: TaskEventProjection,
	runId: string,
	expectedStatus: 'pending' | 'approved',
	appendOperation: boolean,
): void {
	if (
		projection.applicationRunId !== runId ||
		projection.summary.patchApplicationStatus !== expectedStatus
	) {
		throw transitionError('Patch application event does not match the active request', appendOperation)
	}
}

function isPatchApplicationEvent(event: TaskEvent): boolean {
	return (
		event.type === 'PatchApplicationRequested' ||
		event.type === 'PatchApproved' ||
		event.type === 'PatchApplied' ||
		event.type === 'PatchApplicationRejected'
	)
}

function isFallbackEligible(attempt: AttemptProjection): boolean {
	const code = attempt.failureCode
	return attempt.status === 'failed' &&
		code !== null &&
		(code.startsWith('PROVIDER_') ||
			code === 'WORKER_EMPTY_RESPONSE')
}

function transitionError(message: string, appendOperation: boolean): HarnessError {
	return new HarnessError(
		appendOperation ? 'INVALID_TASK_EVENT_TRANSITION' : 'INVALID_TASK_JOURNAL',
		message,
	)
}

function hasExactKeys(
	value: Record<string, unknown>,
	expectedKeys: Array<string>,
): boolean {
	const actualKeys = Object.keys(value).sort()
	const sortedExpected = [...expectedKeys].sort()
	return actualKeys.length === sortedExpected.length &&
		actualKeys.every((key, index) => key === sortedExpected[index])
}

function isUuid(value: unknown): value is string {
	return typeof value === 'string' && uuidPattern.test(value)
}

function isWorkerMode(value: unknown): value is WorkerMode {
	return (
		value === 'research' ||
		value === 'implementation' ||
		value === 'testing' ||
		value === 'review'
	)
}

function isRoutingStrategy(value: unknown): value is RoutingStrategy {
	return (
		value === 'balanced' ||
		value === 'cost' ||
		value === 'latency' ||
		value === 'quality'
	)
}

function isRunStatus(value: unknown): value is RunStatus {
	return (
		value === 'completed' ||
		value === 'failed' ||
		value === 'blocked' ||
		value === 'policy_violation' ||
		value === 'timed_out' ||
		value === 'cancelled'
	)
}

function isBoundedString(value: unknown, maxLength: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function isNullableBoundedString(
	value: unknown,
	maxLength: number,
): value is string | null {
	return value === null || isBoundedString(value, maxLength)
}

function isBoundedStringArray(
	value: unknown,
	maxItems: number,
	maxItemLength: number,
): value is Array<string> {
	return (
		Array.isArray(value) &&
		value.length <= maxItems &&
		value.every(item => isBoundedString(item, maxItemLength))
	)
}

function isUniqueBoundedStringArray(
	value: unknown,
	maxItems: number,
	maxItemLength: number,
): value is Array<string> {
	return isBoundedStringArray(value, maxItems, maxItemLength) &&
		value.length > 0 &&
		new Set(value).size === value.length
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isIntegerInRange(
	value: unknown,
	minimum: number,
	maximum: number,
): value is number {
	return (
		typeof value === 'number' &&
		Number.isInteger(value) &&
		value >= minimum &&
		value <= maximum
	)
}

function isIsoDate(value: unknown): value is string {
	return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function isEvaluationOutcome(value: unknown): value is EvaluationOutcome {
	return value === 'passed' || value === 'failed' || value === 'inconclusive'
}

function isEvaluationDimensionIds(
	value: unknown,
): value is Array<EvaluationDimensionId> {
	return Array.isArray(value) &&
		value.length <= 16 &&
		new Set(value).size === value.length &&
		value.every(item =>
			item === 'worker_execution' ||
			item === 'tests' ||
			item === 'lint' ||
			item === 'typecheck' ||
			item === 'changed_files_scope' ||
			item === 'acceptance_criteria' ||
			item === 'patch_size' ||
			item === 'new_warnings' ||
			item === 'security_policy_compliance' ||
			item === 'correctness' ||
			item === 'maintainability' ||
			item === 'architecture_fit' ||
			item === 'test_quality',
		)
}

function areEvaluationDimensionSetsDisjoint(
	first: unknown,
	second: unknown,
): boolean {
	return isEvaluationDimensionIds(first) &&
		isEvaluationDimensionIds(second) &&
		first.every(dimension => !second.includes(dimension))
}

function invalidJournal(message: string): HarnessError {
	return new HarnessError('INVALID_TASK_JOURNAL', message)
}
