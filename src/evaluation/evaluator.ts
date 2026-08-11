import type {
	EvaluationInput,
	EvaluationResult,
} from '../domain/types.js'

export interface Evaluator {
	readonly id: string
	evaluate(input: EvaluationInput): Promise<EvaluationResult>
}
