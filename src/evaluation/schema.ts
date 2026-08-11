import type {
	EvaluationDimensionId,
	EvaluationResult,
	EvaluationSummary,
} from '../domain/types.js'
import { HarnessError } from '../lib/errors.js'
import { isRecord } from '../lib/json.js'

const dimensionIds = new Set<EvaluationDimensionId>([
	'worker_execution',
	'tests',
	'lint',
	'typecheck',
	'changed_files_scope',
	'acceptance_criteria',
	'patch_size',
	'new_warnings',
	'security_policy_compliance',
	'correctness',
	'maintainability',
	'architecture_fit',
	'test_quality',
])

export function validateEvaluationResult(
	value: unknown,
	expectedEvaluatorId?: string,
): asserts value is EvaluationResult {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			'schemaVersion',
			'evaluatorId',
			'evaluatorKind',
			'evaluatedAt',
			'outcome',
			'dimensions',
		]) ||
		value['schemaVersion'] !== 1 ||
		!isBoundedString(value['evaluatorId'], 100) ||
		(expectedEvaluatorId !== undefined &&
			value['evaluatorId'] !== expectedEvaluatorId) ||
		(value['evaluatorKind'] !== 'deterministic' &&
			value['evaluatorKind'] !== 'model') ||
		!isIsoDate(value['evaluatedAt']) ||
		(value['outcome'] !== 'passed' &&
			value['outcome'] !== 'failed' &&
			value['outcome'] !== 'inconclusive') ||
		!Array.isArray(value['dimensions']) ||
		value['dimensions'].length === 0 ||
		value['dimensions'].length > 16
	) {
		throw invalidEvaluation()
	}

	const seenIds = new Set<string>()
	for (const dimension of value['dimensions']) {
		if (
			!isRecord(dimension) ||
			!hasExactKeys(dimension, ['id', 'status', 'summary', 'evidence']) ||
			typeof dimension['id'] !== 'string' ||
			!dimensionIds.has(dimension['id'] as EvaluationDimensionId) ||
			seenIds.has(dimension['id']) ||
			(dimension['status'] !== 'passed' &&
				dimension['status'] !== 'failed' &&
				dimension['status'] !== 'unknown' &&
				dimension['status'] !== 'not_applicable') ||
			!isBoundedString(dimension['summary'], 500) ||
			!isBoundedStringArray(dimension['evidence'], 20, 1_000)
		) {
			throw invalidEvaluation()
		}
		seenIds.add(dimension['id'])
	}

	const statuses = value['dimensions'].map(dimension =>
		(dimension as { status: string }).status,
	)
	const expectedOutcome = statuses.includes('failed')
		? 'failed'
		: statuses.includes('unknown')
			? 'inconclusive'
			: 'passed'
	if (value['outcome'] !== expectedOutcome) {
		throw invalidEvaluation()
	}
}

export function isEvaluationResult(value: unknown): value is EvaluationResult {
	try {
		validateEvaluationResult(value)
		return true
	} catch {
		return false
	}
}

export function validateEvaluationSummary(
	value: unknown,
): asserts value is EvaluationSummary {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ['schemaVersion', 'evaluatedAt', 'outcome', 'results']) ||
		value['schemaVersion'] !== 1 ||
		!isIsoDate(value['evaluatedAt']) ||
		(value['outcome'] !== 'passed' &&
			value['outcome'] !== 'failed' &&
			value['outcome'] !== 'inconclusive') ||
		!Array.isArray(value['results']) ||
		value['results'].length === 0 ||
		value['results'].length > 8
	) {
		throw invalidEvaluation()
	}

	const evaluatorIds = new Set<string>()
	for (const result of value['results']) {
		validateEvaluationResult(result)
		if (evaluatorIds.has(result.evaluatorId)) {
			throw invalidEvaluation()
		}
		evaluatorIds.add(result.evaluatorId)
	}

	const outcomes = value['results'].map(result => result.outcome)
	const expectedOutcome = outcomes.includes('failed')
		? 'failed'
		: outcomes.includes('inconclusive')
			? 'inconclusive'
			: 'passed'
	if (value['outcome'] !== expectedOutcome) {
		throw invalidEvaluation()
	}
}

export function isEvaluationSummary(value: unknown): value is EvaluationSummary {
	try {
		validateEvaluationSummary(value)
		return true
	} catch {
		return false
	}
}

function hasExactKeys(
	value: Record<string, unknown>,
	expectedKeys: Array<string>,
): boolean {
	const keys = Object.keys(value).sort()
	const expected = [...expectedKeys].sort()
	return keys.length === expected.length &&
		keys.every((key, index) => key === expected[index])
}

function isBoundedString(value: unknown, maxLength: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function isBoundedStringArray(
	value: unknown,
	maxItems: number,
	maxItemLength: number,
): value is Array<string> {
	return Array.isArray(value) &&
		value.length > 0 &&
		value.length <= maxItems &&
		value.every(item => isBoundedString(item, maxItemLength))
}

function isIsoDate(value: unknown): value is string {
	return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function invalidEvaluation(): HarnessError {
	return new HarnessError(
		'INVALID_EVALUATION_RESULT',
		'Evaluator returned an invalid result',
	)
}
