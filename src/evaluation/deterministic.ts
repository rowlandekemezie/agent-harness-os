import type {
	CommandResult,
	CommandSpec,
	EvaluationDimensionId,
	EvaluationDimensionResult,
	EvaluationInput,
	EvaluationOutcome,
	EvaluationResult,
} from '../domain/types.js'
import type { Evaluator } from './evaluator.js'

type CommandDimension = 'tests' | 'lint' | 'typecheck'

const deterministicDimensions: Array<EvaluationDimensionId> = [
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

export class DeterministicEvaluator implements Evaluator {
	readonly id = 'deterministic-v1'

	async evaluate(input: EvaluationInput): Promise<EvaluationResult> {
		const dimensions = deterministicDimensions.map(dimension =>
			evaluateDimension(dimension, input),
		)
		return {
			schemaVersion: 1,
			evaluatorId: this.id,
			evaluatorKind: 'deterministic',
			evaluatedAt: new Date().toISOString(),
			outcome: getOutcome(dimensions),
			dimensions,
		}
	}
}

export function classifyValidationCommand(
	specification: CommandSpec,
): Array<CommandDimension> {
	const command = commandName(specification.command)
	const args = specification.args.map(argument => argument.toLowerCase())
	const direct = new Set<CommandDimension>()

	if (
		['vitest', 'jest', 'mocha', 'pytest', 'cargo', 'go', 'dotnet'].includes(command) ||
		(command === 'node' && args.includes('--test'))
	) {
		if (
			!['cargo', 'go', 'dotnet'].includes(command) ||
			args[0] === 'test'
		) {
			direct.add('tests')
		}
	}
	if (
		['eslint', 'stylelint', 'ruff', 'golangci-lint'].includes(command) ||
		(command === 'biome' && (args[0] === 'check' || args[0] === 'lint'))
	) {
		direct.add('lint')
	}
	if (['tsc', 'mypy', 'pyright'].includes(command)) {
		direct.add('typecheck')
	}

	const script = packageScript(command, args)
	if (script !== null) {
		if (/(^|[:_-])(test|tests|spec|specs)([:_-]|$)/.test(script)) {
			direct.add('tests')
		}
		if (/(^|[:_-])(lint|eslint|stylelint)([:_-]|$)/.test(script)) {
			direct.add('lint')
		}
		if (/(^|[:_-])(typecheck|type-check|check-types|tsc)([:_-]|$)/.test(script)) {
			direct.add('typecheck')
		}
	}

	return [...direct]
}

function evaluateDimension(
	dimension: EvaluationDimensionId,
	input: EvaluationInput,
): EvaluationDimensionResult {
	switch (dimension) {
		case 'worker_execution':
			return input.runStatus === 'completed'
				? result(dimension, 'passed', 'Worker execution completed', [
					'The harness reached completed status before evaluation.',
				])
				: result(dimension, 'failed', `Worker execution ended ${input.runStatus}`, [
					input.failureCode === null
						? `Run status: ${input.runStatus}`
						: `Run status: ${input.runStatus}; failure: ${input.failureCode}`,
				])
		case 'tests':
		case 'lint':
		case 'typecheck':
			return evaluateCommands(dimension, input)
		case 'changed_files_scope':
			return evaluateChangedFiles(input)
		case 'acceptance_criteria':
			return evaluateAcceptanceCriteria(input)
		case 'patch_size':
			return evaluatePatchSize(input)
		case 'new_warnings':
			return evaluateWarnings(input)
		case 'security_policy_compliance':
			return input.policyViolations.length === 0
				? result(dimension, 'passed', 'No policy violations were captured', [
					'Harness policy violation count: 0',
				])
				: result(dimension, 'failed', 'Harness policy violations were captured', [
					`Harness policy violation count: ${input.policyViolations.length}`,
					...input.policyViolations.slice(0, 19),
				])
		default:
			return result(dimension, 'not_applicable', 'Dimension is not deterministic', [
				'This evaluator does not implement model-based dimensions.',
			])
	}
}

function evaluateCommands(
	dimension: CommandDimension,
	input: EvaluationInput,
): EvaluationDimensionResult {
	const matchingIndexes = input.requiredCommands.flatMap((specification, index) =>
		classifyValidationCommand(specification).includes(dimension) ? [index] : [],
	)
	if (matchingIndexes.length === 0) {
		return result(dimension, 'not_applicable', `No ${dimension} command was required`, [
			'Only explicitly classified harness-run commands count as evidence.',
		])
	}

	const evidence = matchingIndexes.map(index =>
		commandEvidence(
			input.requiredCommands[index],
			input.commandResults[index],
		),
	)
	const failed = matchingIndexes.some(index =>
		commandFailed(input.commandResults[index]),
	)
	return result(
		dimension,
		failed ? 'failed' : 'passed',
		failed ? `${dimension} validation failed` : `${dimension} validation passed`,
		evidence,
	)
}

function evaluateChangedFiles(input: EvaluationInput): EvaluationDimensionResult {
	const scopeViolations = input.policyViolations.filter(isChangedFileViolation)
	if (input.changedFiles.length === 0 && scopeViolations.length === 0) {
		return result(
			'changed_files_scope',
			'not_applicable',
			'No changed files were captured',
			['Changed file count: 0'],
		)
	}
	if (
		input.changedFiles.length > input.maxChangedFiles ||
		scopeViolations.length > 0
	) {
		return result(
			'changed_files_scope',
			'failed',
			'Changed files exceeded the permitted scope',
			[
				`Changed file count: ${input.changedFiles.length}; maximum: ${input.maxChangedFiles}`,
				...scopeViolations.slice(0, 19),
			],
		)
	}
	return result(
		'changed_files_scope',
		'passed',
		'Changed files remained within the validated scope',
		[`Changed file count: ${input.changedFiles.length}; maximum: ${input.maxChangedFiles}`],
	)
}

function evaluateAcceptanceCriteria(
	input: EvaluationInput,
): EvaluationDimensionResult {
	if (input.acceptanceCriteria.length === 0) {
		return result(
			'acceptance_criteria',
			'not_applicable',
			'No acceptance criteria were supplied',
			['Acceptance criterion count: 0'],
		)
	}
	const statuses = input.acceptanceCriteria.map(criterion => criterion.status)
	const status = statuses.includes('failed')
		? 'failed'
		: statuses.every(value => value === 'passed')
			? 'passed'
			: 'unknown'
	return result(
		'acceptance_criteria',
		status,
		status === 'unknown'
			? 'Acceptance criteria need explicit deterministic evidence'
			: `Acceptance criteria ${status}`,
		input.acceptanceCriteria.map(criterion =>
			`${criterion.status}: ${criterion.criterion}`,
		).slice(0, 20),
	)
}

function evaluatePatchSize(input: EvaluationInput): EvaluationDimensionResult {
	if (
		input.failureCode === 'PATCH_TOO_LARGE' ||
		input.failureCode === 'ARTIFACT_FILE_TOO_LARGE'
	) {
		return result('patch_size', 'failed', 'Patch exceeded a bounded capture limit', [
			`Harness failure: ${input.failureCode}`,
			'Exact patch bytes were not retained after the bounded capture failed.',
		])
	}
	if (input.patchBytes === 0) {
		return result('patch_size', 'not_applicable', 'No patch was captured', [
			'Patch bytes: 0',
		])
	}
	const status = input.patchBytes <= input.maxPatchBytes ? 'passed' : 'failed'
	return result(
		'patch_size',
		status,
		status === 'passed'
			? 'Patch size is within the artifact limit'
			: 'Patch size exceeds the artifact limit',
		[`Patch bytes: ${input.patchBytes}; maximum: ${input.maxPatchBytes}`],
	)
}

function evaluateWarnings(input: EvaluationInput): EvaluationDimensionResult {
	const commandWarningCount = input.commandResults.reduce(
		(total, command) => total + countWarnings(command.stdout) + countWarnings(command.stderr),
		0,
	)
	const warningCount = input.warnings.length + commandWarningCount
	if (warningCount === 0) {
		return result('new_warnings', 'passed', 'No warnings were captured', [
			'Harness and validation warning count: 0',
		])
	}
	return result(
		'new_warnings',
		'unknown',
		'Warnings were captured without a trusted baseline',
		[
			`Harness warning count: ${input.warnings.length}`,
			`Validation output warning count: ${commandWarningCount}`,
			'A base-commit warning comparison was not executed.',
		],
	)
}

function commandFailed(command: CommandResult | undefined): boolean {
	return command === undefined ||
		command.exitCode !== 0 ||
		command.signal !== null ||
		command.timedOut
}

function commandEvidence(
	specification: CommandSpec | undefined,
	command: CommandResult | undefined,
): string {
	const label = specification === undefined
		? '[missing command specification]'
		: [specification.command, ...specification.args].join(' ')
	if (command === undefined) {
		return `${label}: no harness result`
	}
	return `${label}: exit=${command.exitCode ?? 'null'} signal=${command.signal ?? 'none'} timedOut=${command.timedOut}`
}

function packageScript(command: string, args: Array<string>): string | null {
	if (!['npm', 'pnpm', 'yarn', 'bun'].includes(command)) {
		return null
	}
	if (args[0] === 'test') {
		return 'test'
	}
	if (args[0] === 'run') {
		return args[1] ?? null
	}
	return args[0] ?? null
}

function commandName(command: string): string {
	return command.split(/[\\/]/).at(-1)?.replace(/\.(?:cmd|exe)$/i, '').toLowerCase() ?? ''
}

function isChangedFileViolation(value: string): boolean {
	return /^(?:CHANGED_FILE_LIMIT|PATH_|SECRET_|CONTROL_|SYMLINK_|HARD_LINK_)/.test(value)
}

function countWarnings(value: string): number {
	return value.match(/\bwarning\b/gi)?.length ?? 0
}

function result(
	id: EvaluationDimensionId,
	status: EvaluationDimensionResult['status'],
	summary: string,
	evidence: Array<string>,
): EvaluationDimensionResult {
	return { id, status, summary, evidence }
}

function getOutcome(
	dimensions: Array<EvaluationDimensionResult>,
): EvaluationOutcome {
	if (dimensions.some(dimension => dimension.status === 'failed')) {
		return 'failed'
	}
	if (dimensions.some(dimension => dimension.status === 'unknown')) {
		return 'inconclusive'
	}
	return 'passed'
}
