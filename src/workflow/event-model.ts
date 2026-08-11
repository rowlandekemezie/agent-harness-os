import { createHash, randomUUID } from 'node:crypto'
import type {
	CommandSpec,
	RunStatus,
	WorkflowDefinition,
	WorkflowEvent,
	WorkflowEventInput,
	WorkflowStageName,
	WorkflowSummary,
	WorkflowTimeline,
	WorkflowWorkerStage,
	WorkflowWorkerStageName,
} from '../domain/types.js'
import { HarnessError } from '../lib/errors.js'
import { isRecord } from '../lib/json.js'
import {
	isRepairableWorkflowFailure,
	isRetryableWorkflowFailure,
	nextCandidateStage,
} from './transitions.js'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const sha256Pattern = /^[a-f0-9]{64}$/i
const gitCommitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i
const stageNames: Array<WorkflowWorkerStageName> = [
	'plan',
	'implement',
	'test',
	'review',
	'repair',
]

export type WorkflowProjection = {
	definition: WorkflowDefinition
	summary: WorkflowSummary
	approvalRequested: boolean
}

export function createWorkflowEvent(
	workflowId: string,
	sequence: number,
	previousEventSha256: string | null,
	input: WorkflowEventInput,
): WorkflowEvent {
	return {
		schemaVersion: 1,
		eventId: randomUUID(),
		workflowId,
		sequence,
		occurredAt: new Date().toISOString(),
		previousEventSha256,
		...input,
	} as WorkflowEvent
}

export function serializeWorkflowEvent(event: WorkflowEvent): string {
	return `${JSON.stringify(event)}\n`
}

export function workflowEventSha256(value: string | Buffer): string {
	return createHash('sha256').update(value).digest('hex')
}

export function validateWorkflowEvent(
	value: unknown,
	expectedWorkflowId: string,
	expectedSequence: number,
): WorkflowEvent {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			'schemaVersion',
			'eventId',
			'workflowId',
			'sequence',
			'occurredAt',
			'previousEventSha256',
			'type',
			'data',
		]) ||
		value['schemaVersion'] !== 1 ||
		!isUuid(value['eventId']) ||
		value['workflowId'] !== expectedWorkflowId ||
		value['sequence'] !== expectedSequence ||
		!isIsoDate(value['occurredAt']) ||
		(value['previousEventSha256'] !== null &&
			(typeof value['previousEventSha256'] !== 'string' ||
				!sha256Pattern.test(value['previousEventSha256']))) ||
		!isRecord(value['data'])
	) {
		throw invalidWorkflow('Workflow event has an invalid envelope')
	}

	validateWorkflowEventData(value['type'], value['data'])
	return value as WorkflowEvent
}

export function validateWorkflowDefinition(
	value: unknown,
): value is WorkflowDefinition {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			'schemaVersion',
			'objective',
			'repositoryPath',
			'baseCommit',
			'deadlineAt',
			'maxTransitions',
			'maxRepairAttempts',
			'dependencyWorkflowIds',
			'stages',
		]) ||
		value['schemaVersion'] !== 1 ||
		!isBoundedString(value['objective'], 4_000) ||
		!isBoundedString(value['repositoryPath'], 4_096) ||
		typeof value['baseCommit'] !== 'string' ||
		!gitCommitPattern.test(value['baseCommit']) ||
		!isIsoDate(value['deadlineAt']) ||
		!isIntegerInRange(value['maxTransitions'], 1, 64) ||
		!isIntegerInRange(value['maxRepairAttempts'], 0, 5) ||
		!isUniqueUuidArray(value['dependencyWorkflowIds'], 16) ||
		!isRecord(value['stages']) ||
		!hasExactKeys(value['stages'], [
			'plan',
			'implement',
			'test',
			'review',
			'repair',
		]) ||
		!isNullableWorkflowStage(value['stages']['plan'], 'plan') ||
		!isWorkflowStage(value['stages']['implement'], 'implement') ||
		!isNullableWorkflowStage(value['stages']['test'], 'test') ||
		!isNullableWorkflowStage(value['stages']['review'], 'review') ||
		!isNullableWorkflowStage(value['stages']['repair'], 'repair')
	) {
		return false
	}

	return value['maxRepairAttempts'] === 0
		? value['stages']['repair'] === null
		: value['stages']['repair'] !== null
}

export function projectWorkflowEvent(
	current: WorkflowProjection | null,
	event: WorkflowEvent,
	eventSha256: string,
	appendOperation: boolean,
): WorkflowProjection {
	if (event.type === 'WorkflowCreated') {
		if (current !== null || !validateWorkflowDefinition(event.data.definition)) {
			throw transitionError(
				'WorkflowCreated must be the first valid event',
				appendOperation,
			)
		}
		const firstStage = event.data.definition.stages.plan === null
			? 'implement'
			: 'plan'
		return {
			definition: event.data.definition,
			summary: {
				schemaVersion: 1,
				workflowId: event.workflowId,
				objective: event.data.definition.objective,
				repositoryPath: event.data.definition.repositoryPath,
				baseCommit: event.data.definition.baseCommit,
				createdAt: event.occurredAt,
				updatedAt: event.occurredAt,
				deadlineAt: event.data.definition.deadlineAt,
				status: 'pending',
				currentStage: firstStage,
				activeExecutionId: null,
				candidateRunId: null,
				transitionCount: 0,
				repairAttemptCount: 0,
				stageAttempts: {},
				approvalDecision: null,
				lastFailureCode: null,
				eventCount: 1,
				latestEventSha256: eventSha256,
			},
			approvalRequested: false,
		}
	}

	if (current === null) {
		throw transitionError(
			'Workflow journal must begin with WorkflowCreated',
			appendOperation,
		)
	}
	if (isTerminalWorkflowStatus(current.summary.status)) {
		throw transitionError(
			'Workflow events cannot follow WorkflowCompleted',
			appendOperation,
		)
	}

	const next = cloneProjection(current, event, eventSha256)
	switch (event.type) {
		case 'WorkflowDependencyStateChanged':
			projectDependencyStateChanged(next, event, appendOperation)
			break
		case 'WorkflowStageStarted':
			projectStageStarted(next, event, appendOperation)
			break
		case 'WorkflowStageInterrupted':
			if (
				next.summary.activeExecutionId !== event.data.executionId ||
				next.summary.currentStage !== event.data.stage
			) {
				throw transitionError(
					'Interrupted stage does not match active execution',
					appendOperation,
				)
			}
			next.summary.activeExecutionId = null
			next.summary.status = 'pending'
			break
		case 'WorkflowStageCompleted':
			projectStageCompleted(next, event, appendOperation)
			break
		case 'WorkflowApprovalRequested':
			if (
				next.summary.currentStage !== 'approval' ||
				next.summary.activeExecutionId !== null ||
				event.data.candidateRunId !== next.summary.candidateRunId ||
				next.approvalRequested
			) {
				throw transitionError(
					'Approval request is out of order or has the wrong candidate',
					appendOperation,
				)
			}
			next.approvalRequested = true
			next.summary.approvalDecision = null
			next.summary.status = 'waiting_for_approval'
			break
		case 'WorkflowApprovalDecided':
			projectApprovalDecided(next, event, appendOperation)
			break
		case 'WorkflowCompleted':
			projectWorkflowCompleted(next, event, appendOperation)
			break
	}

	return next
}

function projectDependencyStateChanged(
	next: WorkflowProjection,
	event: Extract<WorkflowEvent, { type: 'WorkflowDependencyStateChanged' }>,
	appendOperation: boolean,
): void {
	if (
		next.definition.dependencyWorkflowIds.length === 0 ||
		next.summary.activeExecutionId !== null ||
		next.approvalRequested ||
		(event.data.state === 'waiting' && next.summary.status !== 'pending') ||
		(event.data.state === 'ready' &&
			next.summary.status !== 'waiting_for_dependency')
	) {
		throw transitionError(
			'Workflow dependency state change is out of order',
			appendOperation,
		)
	}
	next.summary.status = event.data.state === 'waiting'
		? 'waiting_for_dependency'
		: 'pending'
}

export function workflowTimeline(
	projection: WorkflowProjection,
	events: Array<WorkflowEvent>,
): WorkflowTimeline {
	return {
		definition: projection.definition,
		summary: projection.summary,
		events,
	}
}

function projectStageStarted(
	next: WorkflowProjection,
	event: Extract<WorkflowEvent, { type: 'WorkflowStageStarted' }>,
	appendOperation: boolean,
): void {
	const previousAttempts = next.summary.stageAttempts[event.data.stage] ?? 0
	const expectedSource = event.data.stage === 'plan' || event.data.stage === 'implement'
		? null
		: next.summary.candidateRunId
	const stage = next.definition.stages[event.data.stage]
	const attemptLimit = event.data.stage === 'repair'
		? next.definition.maxRepairAttempts
		: (stage?.retryLimit ?? 0) + 1
	if (
		stage === null ||
		next.summary.currentStage !== event.data.stage ||
		next.summary.activeExecutionId !== null ||
		next.approvalRequested ||
		event.data.attemptNumber !== previousAttempts + 1 ||
		event.data.attemptNumber > attemptLimit ||
		event.data.sourceRunId !== expectedSource ||
		next.summary.transitionCount >= next.definition.maxTransitions
	) {
		throw transitionError(
			'Workflow stage start is out of order or exceeds its bound',
			appendOperation,
		)
	}
	next.summary.stageAttempts[event.data.stage] = event.data.attemptNumber
	next.summary.transitionCount += 1
	if (event.data.stage === 'repair') {
		next.summary.repairAttemptCount += 1
	}
	next.summary.activeExecutionId = event.data.executionId
	next.summary.status = 'running'
}

function projectStageCompleted(
	next: WorkflowProjection,
	event: Extract<WorkflowEvent, { type: 'WorkflowStageCompleted' }>,
	appendOperation: boolean,
): void {
	if (
		next.summary.currentStage !== event.data.stage ||
		next.summary.activeExecutionId !== event.data.executionId ||
		(event.data.runId === null) !== (event.data.taskId === null) ||
		(event.data.status === 'completed' && event.data.runId === null) ||
		(event.data.runId !== null && !isUuid(event.data.runId)) ||
		(event.data.taskId !== null && !isUuid(event.data.taskId)) ||
		(event.data.status === 'completed' && event.data.failureCode !== null) ||
		(event.data.status !== 'completed' && event.data.failureCode === null) ||
		(event.data.status === 'completed' &&
			event.data.stage !== 'plan' &&
			event.data.candidateRunId === null) ||
		(event.data.status === 'completed' &&
			(event.data.stage === 'implement' || event.data.stage === 'repair') &&
			event.data.candidateRunId !== event.data.runId) ||
		(event.data.status === 'completed' &&
			(event.data.stage === 'test' || event.data.stage === 'review') &&
			event.data.candidateRunId !== event.data.runId &&
			event.data.candidateRunId !== next.summary.candidateRunId) ||
		(event.data.stage === 'plan' &&
			event.data.candidateRunId !== next.summary.candidateRunId) ||
		(event.data.status !== 'completed' &&
			event.data.nextStage !== 'repair' &&
			event.data.candidateRunId !== next.summary.candidateRunId) ||
		(event.data.status !== 'completed' &&
			event.data.nextStage === 'repair' &&
			event.data.candidateRunId === null) ||
		(event.data.status !== 'completed' &&
			event.data.nextStage === 'repair' &&
			event.data.candidateRunId !== next.summary.candidateRunId &&
			event.data.candidateRunId !== event.data.runId) ||
		!isAllowedNextStage(
			next.definition,
			next.summary,
			event.data.stage,
			event.data.status,
			event.data.failureCode,
			event.data.nextStage,
		)
	) {
		throw transitionError(
			'Workflow stage completion is inconsistent',
			appendOperation,
		)
	}
	next.summary.activeExecutionId = null
	next.summary.candidateRunId = event.data.candidateRunId
	next.summary.currentStage = event.data.nextStage
	next.summary.lastFailureCode = event.data.failureCode
	next.summary.status = 'pending'
}

function projectApprovalDecided(
	next: WorkflowProjection,
	event: Extract<WorkflowEvent, { type: 'WorkflowApprovalDecided' }>,
	appendOperation: boolean,
): void {
	if (
		!next.approvalRequested ||
		next.summary.status !== 'waiting_for_approval' ||
		next.summary.currentStage !== 'approval' ||
		(event.data.decision === 'approved' && event.data.nextStage !== null) ||
		(event.data.decision === 'rejected' &&
			event.data.nextStage !== null &&
			event.data.nextStage !== 'repair') ||
		(event.data.nextStage === 'repair' &&
			(next.definition.stages.repair === null ||
				next.summary.repairAttemptCount >= next.definition.maxRepairAttempts))
	) {
		throw transitionError('Approval decision is out of order', appendOperation)
	}
	next.approvalRequested = false
	next.summary.approvalDecision = event.data.decision
	next.summary.currentStage = event.data.nextStage
	next.summary.status = 'pending'
	if (event.data.decision === 'rejected') {
		next.summary.lastFailureCode = 'WORKFLOW_APPROVAL_REJECTED'
	}
}

function projectWorkflowCompleted(
	next: WorkflowProjection,
	event: Extract<WorkflowEvent, { type: 'WorkflowCompleted' }>,
	appendOperation: boolean,
): void {
	if (
		next.summary.activeExecutionId !== null ||
		(next.approvalRequested && event.data.status === 'completed') ||
		event.data.candidateRunId !== next.summary.candidateRunId ||
		(event.data.status === 'completed' &&
			(next.summary.approvalDecision !== 'approved' ||
				next.summary.candidateRunId === null ||
				event.data.failureCode !== null)) ||
		(event.data.status !== 'completed' && event.data.failureCode === null)
	) {
		throw transitionError(
			'Workflow completion is inconsistent with recorded state',
			appendOperation,
		)
	}
	next.summary.currentStage = null
	next.approvalRequested = false
	next.summary.status = event.data.status
	next.summary.lastFailureCode = event.data.failureCode
}

function cloneProjection(
	current: WorkflowProjection,
	event: WorkflowEvent,
	eventSha256: string,
): WorkflowProjection {
	return {
		definition: current.definition,
		approvalRequested: current.approvalRequested,
		summary: {
			...current.summary,
			stageAttempts: { ...current.summary.stageAttempts },
			updatedAt: event.occurredAt,
			eventCount: event.sequence,
			latestEventSha256: eventSha256,
		},
	}
}

function validateWorkflowEventData(type: unknown, data: Record<string, unknown>): void {
	switch (type) {
		case 'WorkflowCreated':
			if (
				!hasExactKeys(data, ['definition']) ||
				!validateWorkflowDefinition(data['definition'])
			) {
				throw invalidWorkflow('WorkflowCreated data is invalid')
			}
			return
		case 'WorkflowStageStarted':
			if (
				!hasExactKeys(data, [
					'stage',
					'executionId',
					'attemptNumber',
					'sourceRunId',
				]) ||
				!isWorkerStageName(data['stage']) ||
				!isUuid(data['executionId']) ||
				!isIntegerInRange(data['attemptNumber'], 1, 64) ||
				!isNullableUuid(data['sourceRunId'])
			) {
				throw invalidWorkflow('WorkflowStageStarted data is invalid')
			}
			return
		case 'WorkflowDependencyStateChanged':
			if (
				!hasExactKeys(data, ['state']) ||
				(data['state'] !== 'waiting' && data['state'] !== 'ready')
			) {
				throw invalidWorkflow('Workflow dependency state change is invalid')
			}
			return
		case 'WorkflowStageInterrupted':
			if (
				!hasExactKeys(data, ['stage', 'executionId', 'reason']) ||
				!isWorkerStageName(data['stage']) ||
				!isUuid(data['executionId']) ||
				data['reason'] !== 'resume' &&
				data['reason'] !== 'cancel' &&
				data['reason'] !== 'deadline'
			) {
				throw invalidWorkflow('WorkflowStageInterrupted data is invalid')
			}
			return
		case 'WorkflowStageCompleted':
			if (
				!hasExactKeys(data, [
					'stage',
					'executionId',
					'taskId',
					'runId',
					'status',
					'failureCode',
					'candidateRunId',
					'nextStage',
				]) ||
				!isWorkerStageName(data['stage']) ||
				!isUuid(data['executionId']) ||
				!isNullableUuid(data['taskId']) ||
				!isNullableUuid(data['runId']) ||
				!isRunStatus(data['status']) ||
				!isNullableBoundedString(data['failureCode'], 200) ||
				!isNullableUuid(data['candidateRunId']) ||
				!isNullableStageName(data['nextStage'])
			) {
				throw invalidWorkflow('WorkflowStageCompleted data is invalid')
			}
			return
		case 'WorkflowApprovalRequested':
			if (
				!hasExactKeys(data, ['candidateRunId']) ||
				!isUuid(data['candidateRunId'])
			) {
				throw invalidWorkflow('WorkflowApprovalRequested data is invalid')
			}
			return
		case 'WorkflowApprovalDecided':
			if (
				!hasExactKeys(data, ['decision', 'feedback', 'source', 'nextStage']) ||
				(data['decision'] !== 'approved' && data['decision'] !== 'rejected') ||
				typeof data['feedback'] !== 'string' ||
				Buffer.byteLength(data['feedback'], 'utf8') > 4_000 ||
				data['source'] !== 'mcp_call' ||
				!isNullableStageName(data['nextStage'])
			) {
				throw invalidWorkflow('WorkflowApprovalDecided data is invalid')
			}
			return
		case 'WorkflowCompleted':
			if (
				!hasExactKeys(data, ['status', 'failureCode', 'candidateRunId']) ||
				!isTerminalStoredStatus(data['status']) ||
				!isNullableBoundedString(data['failureCode'], 200) ||
				!isNullableUuid(data['candidateRunId'])
			) {
				throw invalidWorkflow('WorkflowCompleted data is invalid')
			}
			return
		default:
			throw invalidWorkflow('Workflow event type is unsupported')
	}
}

function isAllowedNextStage(
	definition: WorkflowDefinition,
	summary: WorkflowSummary,
	stage: WorkflowWorkerStageName,
	status: RunStatus,
	failureCode: string | null,
	nextStage: WorkflowStageName | null,
): boolean {
	if (status === 'cancelled' || status === 'timed_out' || status === 'policy_violation') {
		return nextStage === null
	}
	if (status !== 'completed') {
		if (nextStage === null) {
			return true
		}
		if (failureCode === null) {
			return false
		}
		if (nextStage === stage) {
			const retryLimit = definition.stages[stage]?.retryLimit ?? 0
			return stage !== 'repair' &&
				isRetryableWorkflowFailure(failureCode) &&
				(summary.stageAttempts[stage] ?? 0) <= retryLimit
		}
		return nextStage === 'repair' &&
			definition.stages.repair !== null &&
			isRepairableWorkflowFailure(failureCode) &&
			summary.repairAttemptCount < definition.maxRepairAttempts
	}
	switch (stage) {
		case 'plan':
			return nextStage === 'implement'
		case 'implement':
			return nextStage === nextCandidateStage(definition)
		case 'test':
			return nextStage === (definition.stages.review === null ? 'approval' : 'review')
		case 'review':
			return nextStage === 'approval'
		case 'repair':
			return nextStage === nextCandidateStage(definition)
	}
}

function isWorkflowStage(
	value: unknown,
	stageName: WorkflowWorkerStageName,
): value is WorkflowWorkerStage {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			'objective',
			'allowedPaths',
			'prohibitedPaths',
			'acceptanceCriteria',
			'requiredCommands',
			'maxIterations',
			'timeoutSeconds',
			'allowNetwork',
			'routing',
			'retryLimit',
		]) ||
		!isBoundedString(value['objective'], 4_000) ||
		!isBoundedStringArray(value['allowedPaths'], 1, 100, 1_024) ||
		!isBoundedStringArray(value['prohibitedPaths'], 0, 100, 1_024) ||
		!isBoundedStringArray(value['acceptanceCriteria'], 0, 100, 2_000) ||
		!isCommandSpecs(value['requiredCommands']) ||
		!isIntegerInRange(value['maxIterations'], 1, 64) ||
		!isIntegerInRange(value['timeoutSeconds'], 30, 3_600) ||
		typeof value['allowNetwork'] !== 'boolean' ||
		!isRoutingPolicy(value['routing']) ||
		!isIntegerInRange(value['retryLimit'], 0, 2)
	) {
		return false
	}
	return ((stageName !== 'plan' && stageName !== 'review') ||
		(value['requiredCommands'] as Array<unknown>).length === 0) &&
		(stageName !== 'repair' || value['retryLimit'] === 0)
}

function isNullableWorkflowStage(
	value: unknown,
	stageName: WorkflowWorkerStageName,
): boolean {
	return value === null || isWorkflowStage(value, stageName)
}

function isRoutingPolicy(value: unknown): boolean {
	return isRecord(value) &&
		hasExactKeys(value, [
			'preferredWorkerId',
			'requiredCapabilities',
			'strategy',
			'maxCostTier',
			'maxLatencyTier',
			'allowFallback',
			'maxAttempts',
		]) &&
		(value['preferredWorkerId'] === null ||
			isBoundedString(value['preferredWorkerId'], 64)) &&
		Array.isArray(value['requiredCapabilities']) &&
		value['requiredCapabilities'].length <= 16 &&
		new Set(value['requiredCapabilities']).size === value['requiredCapabilities'].length &&
		value['requiredCapabilities'].every(isWorkerCapability) &&
		(value['strategy'] === 'balanced' ||
			value['strategy'] === 'cost' ||
			value['strategy'] === 'latency' ||
			value['strategy'] === 'quality') &&
		isNullableTier(value['maxCostTier']) &&
		isNullableLatency(value['maxLatencyTier']) &&
		typeof value['allowFallback'] === 'boolean' &&
		isIntegerInRange(value['maxAttempts'], 1, 8)
}

function isCommandSpecs(value: unknown): value is Array<CommandSpec> {
	return Array.isArray(value) && value.length <= 20 && value.every(item =>
		isRecord(item) &&
		Object.keys(item).every(key => key === 'command' || key === 'args' || key === 'timeoutMs') &&
		hasOwn(item, 'command') &&
		hasOwn(item, 'args') &&
		isBoundedString(item['command'], 100) &&
		Array.isArray(item['args']) &&
		item['args'].length <= 100 &&
		item['args'].every(argument =>
			typeof argument === 'string' && argument.length <= 2_000
		) &&
		(item['timeoutMs'] === undefined ||
			isIntegerInRange(item['timeoutMs'], 1_000, 900_000))
	)
}

function isWorkerCapability(value: unknown): boolean {
	return value === 'research' ||
		value === 'implementation' ||
		value === 'testing' ||
		value === 'review' ||
		value === 'tool-calling' ||
		value === 'long-context' ||
		value === 'private'
}

function isRunStatus(value: unknown): boolean {
	return value === 'completed' ||
		value === 'failed' ||
		value === 'blocked' ||
		value === 'policy_violation' ||
		value === 'timed_out' ||
		value === 'cancelled'
}

function isTerminalStoredStatus(value: unknown): boolean {
	return value === 'completed' ||
		value === 'failed' ||
		value === 'blocked' ||
		value === 'timed_out' ||
		value === 'cancelled'
}

function isTerminalWorkflowStatus(value: WorkflowSummary['status']): boolean {
	return isTerminalStoredStatus(value)
}

function isWorkerStageName(value: unknown): value is WorkflowWorkerStageName {
	return typeof value === 'string' &&
		stageNames.includes(value as WorkflowWorkerStageName)
}

function isNullableStageName(value: unknown): value is WorkflowStageName | null {
	return value === null || value === 'approval' || isWorkerStageName(value)
}

function isUniqueUuidArray(value: unknown, maximum: number): boolean {
	return Array.isArray(value) &&
		value.length <= maximum &&
		value.every(isUuid) &&
		new Set(value).size === value.length
}

function isBoundedStringArray(
	value: unknown,
	minimum: number,
	maximum: number,
	maxItemLength: number,
): boolean {
	return Array.isArray(value) &&
		value.length >= minimum &&
		value.length <= maximum &&
		value.every(item => isBoundedString(item, maxItemLength))
}

function isBoundedString(value: unknown, maximum: number): value is string {
	return typeof value === 'string' &&
		value.length > 0 &&
		value.length <= maximum
}

function isNullableBoundedString(value: unknown, maximum: number): boolean {
	return value === null || isBoundedString(value, maximum)
}

function isUuid(value: unknown): value is string {
	return typeof value === 'string' && uuidPattern.test(value)
}

function isNullableUuid(value: unknown): value is string | null {
	return value === null || isUuid(value)
}

function isIsoDate(value: unknown): value is string {
	return typeof value === 'string' &&
		Number.isFinite(Date.parse(value)) &&
		new Date(value).toISOString() === value
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): boolean {
	return Number.isSafeInteger(value) &&
		(value as number) >= minimum &&
		(value as number) <= maximum
}

function isNullableTier(value: unknown): boolean {
	return value === null || value === 'low' || value === 'medium' || value === 'high'
}

function isNullableLatency(value: unknown): boolean {
	return value === null || value === 'fast' || value === 'standard' || value === 'slow'
}

function hasExactKeys(value: Record<string, unknown>, keys: Array<string>): boolean {
	return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key)
}

function invalidWorkflow(message: string): HarnessError {
	return new HarnessError('INVALID_WORKFLOW_JOURNAL', message)
}

function transitionError(message: string, appendOperation: boolean): HarnessError {
	return new HarnessError(
		appendOperation ? 'INVALID_WORKFLOW_TRANSITION' : 'INVALID_WORKFLOW_JOURNAL',
		message,
	)
}
