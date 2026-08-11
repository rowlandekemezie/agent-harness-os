import type {
	WorkflowDefinition,
	WorkflowStageName,
	WorkflowWorkerStageName,
} from '../domain/types.js'

export function nextCandidateStage(
	definition: WorkflowDefinition,
): WorkflowStageName {
	if (definition.stages.test !== null) {
		return 'test'
	}
	if (definition.stages.review !== null) {
		return 'review'
	}
	return 'approval'
}

export function nextSuccessfulStage(
	definition: WorkflowDefinition,
	stageName: WorkflowWorkerStageName,
): WorkflowStageName {
	if (stageName === 'plan') {
		return 'implement'
	}
	if (stageName === 'test') {
		return definition.stages.review === null ? 'approval' : 'review'
	}
	if (stageName === 'review') {
		return 'approval'
	}
	return nextCandidateStage(definition)
}

export function isRetryableWorkflowFailure(code: string): boolean {
	return code.startsWith('PROVIDER_') ||
		code === 'WORKER_EMPTY_RESPONSE' ||
		code === 'WORKER_NO_CHANGES'
}

export function isRepairableWorkflowFailure(code: string): boolean {
	return code === 'VALIDATION_COMMAND_FAILED' ||
		code === 'EVALUATION_FAILED' ||
		code === 'EVALUATION_INCONCLUSIVE'
}
