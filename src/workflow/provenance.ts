import { createHash } from 'node:crypto'
import type {
	WorkflowTaskProvenance,
	WorkflowWorkerStage,
	WorkflowWorkerStageName,
} from '../domain/types.js'
import { isRecord } from '../lib/json.js'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const sha256Pattern = /^[a-f0-9]{64}$/i

export function createWorkflowTaskProvenance(
	workflowId: string,
	stage: WorkflowWorkerStageName,
	executionId: string,
	stageContract: WorkflowWorkerStage,
	sourceRunId: string | null,
): WorkflowTaskProvenance {
	return {
		workflowId,
		stage,
		executionId,
		stageContractSha256: workflowStageContractSha256(stageContract),
		sourceRunId,
	}
}

export function isWorkflowTaskProvenance(
	value: unknown,
): value is WorkflowTaskProvenance {
	return isRecord(value) &&
		Object.keys(value).length === 5 &&
		isUuid(value['workflowId']) &&
		isWorkflowStage(value['stage']) &&
		isUuid(value['executionId']) &&
		typeof value['stageContractSha256'] === 'string' &&
		sha256Pattern.test(value['stageContractSha256']) &&
		(value['sourceRunId'] === null || isUuid(value['sourceRunId']))
}

export function workflowProvenanceEquals(
	left: WorkflowTaskProvenance | null,
	right: WorkflowTaskProvenance | null,
): boolean {
	return left === null
		? right === null
		: right !== null &&
			left.workflowId === right.workflowId &&
			left.stage === right.stage &&
			left.executionId === right.executionId &&
			left.stageContractSha256 === right.stageContractSha256 &&
			left.sourceRunId === right.sourceRunId
}

export function workflowStageContractSha256(
	stage: WorkflowWorkerStage,
): string {
	const contract = {
		objective: stage.objective,
		allowedPaths: stage.allowedPaths,
		prohibitedPaths: stage.prohibitedPaths,
		acceptanceCriteria: stage.acceptanceCriteria,
		requiredCommands: stage.requiredCommands.map(command => ({
			command: command.command,
			args: command.args,
			...(command.timeoutMs === undefined
				? {}
				: { timeoutMs: command.timeoutMs }),
		})),
		maxIterations: stage.maxIterations,
		timeoutSeconds: stage.timeoutSeconds,
		allowNetwork: stage.allowNetwork,
		routing: {
			preferredWorkerId: stage.routing.preferredWorkerId,
			requiredCapabilities: stage.routing.requiredCapabilities,
			strategy: stage.routing.strategy,
			maxCostTier: stage.routing.maxCostTier,
			maxLatencyTier: stage.routing.maxLatencyTier,
			allowFallback: stage.routing.allowFallback,
			maxAttempts: stage.routing.maxAttempts,
		},
		retryLimit: stage.retryLimit,
	}
	return createHash('sha256').update(JSON.stringify(contract)).digest('hex')
}

function isUuid(value: unknown): value is string {
	return typeof value === 'string' && uuidPattern.test(value)
}

function isWorkflowStage(value: unknown): value is WorkflowWorkerStageName {
	return value === 'plan' ||
		value === 'implement' ||
		value === 'test' ||
		value === 'review' ||
		value === 'repair'
}
