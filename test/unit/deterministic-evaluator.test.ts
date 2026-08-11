import assert from 'node:assert/strict'
import test from 'node:test'
import type {
	CommandResult,
	EvaluationInput,
} from '../../src/domain/types.js'
import {
	classifyValidationCommand,
	DeterministicEvaluator,
} from '../../src/evaluation/deterministic.js'
import {
	validateEvaluationResult,
	validateEvaluationSummary,
} from '../../src/evaluation/schema.js'

function commandResult(
	command: string,
	args: Array<string>,
	exitCode = 0,
	stderr = '',
): CommandResult {
	return {
		command,
		args,
		exitCode,
		signal: null,
		stdout: '',
		stderr,
		durationMs: 1,
		timedOut: false,
		outputTruncated: false,
	}
}

function evaluationInput(overrides: Partial<EvaluationInput> = {}): EvaluationInput {
	return {
		runId: '11111111-1111-4111-8111-111111111111',
		mode: 'implementation',
		runStatus: 'completed',
		failureCode: null,
		requiredCommands: [
			{ command: 'npm', args: ['test'] },
			{ command: 'npm', args: ['run', 'lint'] },
			{ command: 'tsc', args: ['--noEmit'] },
		],
		commandResults: [
			commandResult('npm', ['test']),
			commandResult('npm', ['run', 'lint']),
			commandResult('tsc', ['--noEmit']),
		],
		changedFiles: ['src/example.ts'],
		patchBytes: 100,
		acceptanceCriteria: [],
		policyViolations: [],
		warnings: [],
		maxChangedFiles: 200,
		maxPatchBytes: 20_000_000,
		...overrides,
	}
}

test('classifies only explicit test, lint, and typecheck commands', function () {
	assert.deepEqual(
		classifyValidationCommand({ command: 'npm', args: ['run', 'test:unit'] }),
		['tests'],
	)
	assert.deepEqual(
		classifyValidationCommand({ command: 'eslint', args: ['.'] }),
		['lint'],
	)
	assert.deepEqual(
		classifyValidationCommand({ command: 'pyright', args: [] }),
		['typecheck'],
	)
	assert.deepEqual(
		classifyValidationCommand({ command: 'npm', args: ['run', 'check'] }),
		[],
	)
})

test('evaluates all deterministic dimensions from harness evidence', async function () {
	const evaluation = await new DeterministicEvaluator().evaluate(evaluationInput())

	validateEvaluationResult(evaluation, 'deterministic-v1')
	assert.equal(evaluation.outcome, 'passed')
	assert.deepEqual(
		evaluation.dimensions.map(dimension => dimension.id),
		[
			'worker_execution',
			'tests',
			'lint',
			'typecheck',
			'changed_files_scope',
			'acceptance_criteria',
			'patch_size',
			'new_warnings',
			'security_policy_compliance',
		],
	)
	assert.equal(
		evaluation.dimensions.find(dimension =>
			dimension.id === 'acceptance_criteria'
		)?.status,
		'not_applicable',
	)
})

test('fails commands, scope, patch size, and security policy deterministically', async function () {
	const evaluation = await new DeterministicEvaluator().evaluate(evaluationInput({
		commandResults: [
			commandResult('npm', ['test'], 1),
			commandResult('npm', ['run', 'lint']),
			commandResult('tsc', ['--noEmit']),
		],
		changedFiles: ['src/one.ts', 'src/two.ts'],
		patchBytes: 101,
		policyViolations: [
			'CHANGED_FILE_LIMIT: Worker changed 2 files, exceeding the limit of 1',
		],
		maxChangedFiles: 1,
		maxPatchBytes: 100,
	}))

	assert.equal(evaluation.outcome, 'failed')
	assert.deepEqual(
		evaluation.dimensions.flatMap(dimension =>
			dimension.status === 'failed' ? [dimension.id] : [],
		),
		['tests', 'changed_files_scope', 'patch_size', 'security_policy_compliance'],
	)
})

test('records an oversized patch even when bounded capture cannot retain its bytes', async function () {
	const evaluation = await new DeterministicEvaluator().evaluate(evaluationInput({
		runStatus: 'failed',
		failureCode: 'PATCH_TOO_LARGE',
		patchBytes: 0,
	}))

	assert.equal(
		evaluation.dimensions.find(dimension => dimension.id === 'patch_size')?.status,
		'failed',
	)
})

test('keeps warnings and unverified criteria explicitly inconclusive', async function () {
	const evaluation = await new DeterministicEvaluator().evaluate(evaluationInput({
		acceptanceCriteria: [{
			criterion: 'The feature behaves correctly',
			status: 'unknown',
			evidence: ['No criterion-specific command was supplied.'],
		}],
		commandResults: [
			commandResult('npm', ['test'], 0, 'warning: deprecated fixture'),
			commandResult('npm', ['run', 'lint']),
			commandResult('tsc', ['--noEmit']),
		],
	}))

	assert.equal(evaluation.outcome, 'inconclusive')
	assert.deepEqual(
		evaluation.dimensions.flatMap(dimension =>
			dimension.status === 'unknown' ? [dimension.id] : [],
		),
		['acceptance_criteria', 'new_warnings'],
	)
})

test('rejects evaluator output with an inconsistent outcome or extra fields', function () {
	const invalid = {
		schemaVersion: 1,
		evaluatorId: 'model-review',
		evaluatorKind: 'model',
		evaluatedAt: new Date().toISOString(),
		outcome: 'passed',
		dimensions: [{
			id: 'correctness',
			status: 'failed',
			summary: 'A defect was found',
			evidence: ['deterministic evidence reference'],
			providerPayload: 'must not persist',
		}],
	}

	assert.throws(
		() => validateEvaluationResult(invalid, 'model-review'),
		(error: unknown) =>
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'INVALID_EVALUATION_RESULT',
	)
})

test('rejects aggregate evaluations with duplicate evaluators or inconsistent outcomes', async function () {
	const result = await new DeterministicEvaluator().evaluate(evaluationInput())
	const duplicate = {
		schemaVersion: 1,
		evaluatedAt: new Date().toISOString(),
		outcome: 'passed',
		results: [result, result],
	}
	const inconsistent = {
		schemaVersion: 1,
		evaluatedAt: new Date().toISOString(),
		outcome: 'failed',
		results: [result],
	}

	assert.throws(() => validateEvaluationSummary(duplicate))
	assert.throws(() => validateEvaluationSummary(inconsistent))
})
