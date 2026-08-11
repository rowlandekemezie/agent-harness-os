import type { EvaluationDimensionId } from '../domain/types.js'

export const deterministicEvaluationDimensionIds: Array<EvaluationDimensionId> = [
	'worker_execution',
	'tests',
	'lint',
	'typecheck',
	'changed_files_scope',
	'acceptance_criteria',
	'patch_size',
	'new_warnings',
	'security_policy_compliance',
]
