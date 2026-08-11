import { createHash } from 'node:crypto'
import path from 'node:path'
import type {
	AcceptanceCriterionResult,
	CommandResult,
	RunStatus,
	WorkerMode,
	WorkerRunReport,
} from '../domain/types.js'
import { HarnessError } from '../lib/errors.js'
import { isRecord } from '../lib/json.js'
import { Redactor } from '../lib/redaction.js'
import { truncateUtf8 } from '../lib/text.js'
import { isEvaluationSummary } from '../evaluation/schema.js'
import { isResolvedPolicy } from '../policy/engine.js'
import {
	createPrivateDirectory,
	ensurePrivateDirectory,
	readBoundedRegularFile,
	writeExclusiveRegularFile,
} from './secure-io.js'

const maxReportBytes = 4_194_304
export const maxArtifactPatchBytes = 20_000_000

export type PersistRunInput = {
	artifactRoot: string
	report: WorkerRunReport
	patch: string
	workerTranscript: string
	signal?: AbortSignal
}

export class ArtifactStore {
	private readonly redactor: Redactor

	constructor(redactor = new Redactor()) {
		this.redactor = redactor
	}

	async persist(input: PersistRunInput): Promise<WorkerRunReport> {
		input.signal?.throwIfAborted()
		const runDirectory = path.join(input.artifactRoot, input.report.runId)
		const patchPath = path.join(runDirectory, 'changes.patch')
		const reportPath = path.join(runDirectory, 'report.json')
		const transcriptPath = path.join(runDirectory, 'worker-transcript.txt')

		if (input.patch !== '') {
			if (Buffer.byteLength(input.patch, 'utf8') > maxArtifactPatchBytes) {
				throw new HarnessError(
					'ARTIFACT_FILE_TOO_LARGE',
					`Worker patch exceeds the ${maxArtifactPatchBytes}-byte artifact limit`,
				)
			}
		}

		const persistedReport: WorkerRunReport = {
			...redactReport(input.report, this.redactor),
			patchPath: input.patch === '' ? null : patchPath,
			patchSha256: input.patch === '' ? null : sha256(input.patch),
			reportPath,
		}
		validateReport(persistedReport, reportPath, input.report.runId)
		const reportContents = `${JSON.stringify(persistedReport, null, 2)}\n`
		if (Buffer.byteLength(reportContents, 'utf8') > maxReportBytes) {
			throw new HarnessError(
				'ARTIFACT_FILE_TOO_LARGE',
				`Run report exceeds the ${maxReportBytes}-byte artifact limit`,
			)
		}
		await ensurePrivateDirectory(input.artifactRoot, input.artifactRoot, {
			recursive: true,
		})
		try {
			await createPrivateDirectory(input.artifactRoot, runDirectory)
		} catch (error) {
			throw new HarnessError(
				'ARTIFACT_RUN_COLLISION',
				`Artifact run directory already exists or cannot be created: ${input.report.runId}`,
				{ cause: error instanceof Error ? error.message : String(error) },
			)
		}

		if (input.patch !== '') {
			// Patches must remain byte-faithful. Access is restricted by file mode.
			await writeExclusiveRegularFile(
				input.artifactRoot,
				patchPath,
				input.patch,
			)
		}

		await writeExclusiveRegularFile(
			input.artifactRoot,
			transcriptPath,
			this.redactor.redact(input.workerTranscript),
		)

		input.signal?.throwIfAborted()
		await writeExclusiveRegularFile(
			input.artifactRoot,
			reportPath,
			reportContents,
			0o600,
			input.signal,
		)

		return persistedReport
	}

	async loadReport(
		artifactRoot: string,
		runId: string,
	): Promise<WorkerRunReport> {
		validateRunId(runId)
		const reportPath = path.join(artifactRoot, runId, 'report.json')

		let contents: Buffer

		try {
			contents = await readBoundedRegularFile(
				artifactRoot,
				reportPath,
				maxReportBytes,
			)
		} catch (error) {
			if (error instanceof HarnessError) {
				throw error
			}

			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				throw new HarnessError(
					'RUN_NOT_FOUND',
					`Worker run report was not found: ${runId}`,
				)
			}

			throw new HarnessError(
				'ARTIFACT_READ_FAILED',
				`Worker run report could not be read: ${runId}`,
				{ cause: error instanceof Error ? error.message : String(error) },
			)
		}

		try {
			const parsed: unknown = JSON.parse(contents.toString('utf8'))
			return validateReport(parsed, reportPath, runId)
		} catch (error) {
			if (error instanceof HarnessError) {
				throw error
			}

			throw new HarnessError(
				'INVALID_RUN_REPORT',
				'Run report does not contain valid JSON',
			)
		}
	}

	async loadPatch(
		artifactRoot: string,
		report: WorkerRunReport,
	): Promise<Buffer> {
		if (report.patchPath === null || report.patchSha256 === null) {
			throw new HarnessError('RUN_HAS_NO_PATCH', 'Worker run does not contain a patch')
		}

		const expectedPatchPath = path.join(
			artifactRoot,
			report.runId,
			'changes.patch',
		)

		if (path.resolve(report.patchPath) !== path.resolve(expectedPatchPath)) {
			throw new HarnessError(
				'ARTIFACT_PATH_INVALID',
				'Run report references an unexpected patch path',
			)
		}

		return await readBoundedRegularFile(
			artifactRoot,
			expectedPatchPath,
			maxArtifactPatchBytes,
		)
	}
}

function redactReport(
	report: WorkerRunReport,
	redactor: Redactor,
): WorkerRunReport {
	return {
		...report,
		objective: redactor.redact(report.objective),
		workerSummary: redactor.redact(report.workerSummary),
		commandResults: report.commandResults.map(result => ({
			...result,
			stdout: redactor.redact(result.stdout),
			stderr: redactor.redact(result.stderr),
		})),
		acceptanceCriteria: report.acceptanceCriteria.map(criterion => ({
			...criterion,
			criterion: redactor.redact(criterion.criterion),
			evidence: criterion.evidence.map(value => redactor.redact(value)),
		})),
		policyViolations: report.policyViolations.map(value => redactor.redact(value)),
		warnings: report.warnings.map(value => redactor.redact(value)),
		...(report.evaluation === undefined
			? {}
			: { evaluation: {
				...report.evaluation,
				results: report.evaluation.results.map(result => ({
					...result,
					dimensions: result.dimensions.map(dimension => ({
						...dimension,
						summary: truncateUtf8(
							redactor.redact(dimension.summary),
							500,
						),
						evidence: dimension.evidence.map(value =>
							truncateUtf8(redactor.redact(value), 1_000),
						),
					})),
				})),
			} }),
		provider: {
			...report.provider,
			baseUrl: redactor.redact(report.provider.baseUrl),
		},
	}
}

export function sha256(value: string | Buffer): string {
	return createHash('sha256').update(value).digest('hex')
}

function validateRunId(runId: string): void {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
		throw new HarnessError('INVALID_RUN_ID', 'Run ID must be a UUID')
	}
}

function validateReport(
	value: unknown,
	expectedPath: string,
	expectedRunId: string,
): WorkerRunReport {
	if (!isRecord(value)) {
		throw invalidReport()
	}

	const runId = requireReportString(value['runId'])
	validateRunId(runId)
	const schemaVersion = value['schemaVersion']
	const patchPath = nullableString(value['patchPath'])
	const patchSha256 = nullableString(value['patchSha256'])
	const requiredKeys = [
		'schemaVersion',
		'runId',
		'status',
		'objective',
		'mode',
		'repositoryPath',
		'baseRef',
		'startedAt',
		'completedAt',
		'durationMs',
		'workerSummary',
		'changedFiles',
		'patchPath',
		'patchSha256',
		'reportPath',
		'commandResults',
		'acceptanceCriteria',
		'policyViolations',
		'warnings',
		'provider',
	]

	if (
		runId !== expectedRunId ||
		(schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== 3) ||
		!hasExpectedKeys(
			value,
			schemaVersion === 1
				? requiredKeys
				: schemaVersion === 2
					? [...requiredKeys, 'taskId']
					: [...requiredKeys, 'taskId', 'evaluation'],
			schemaVersion === 3
				? ['failureCode', 'routing', 'policy']
				: ['failureCode', 'routing'],
		) ||
		(schemaVersion === 1 &&
			(value['taskId'] !== undefined || value['evaluation'] !== undefined)) ||
		(schemaVersion === 2 &&
			(!isUuid(value['taskId']) || value['evaluation'] !== undefined)) ||
		(schemaVersion === 3 &&
			(!isUuid(value['taskId']) || !isEvaluationSummary(value['evaluation']))) ||
		(value['policy'] !== undefined && !isResolvedPolicy(value['policy'])) ||
		!isRunStatus(value['status']) ||
		!isReportEvaluationConsistent(
			schemaVersion,
			value['status'],
			value['failureCode'],
			value['evaluation'],
			value['provider'],
		) ||
		!isWorkerMode(value['mode']) ||
		requireReportString(value['reportPath']) !== expectedPath ||
		!isIsoDate(value['startedAt']) ||
		!isIsoDate(value['completedAt']) ||
		!isNonNegativeInteger(value['durationMs']) ||
		!isStringArray(value['changedFiles']) ||
		!isStringArray(value['policyViolations']) ||
		!isStringArray(value['warnings']) ||
		!isCommandResults(value['commandResults']) ||
		!isAcceptanceResults(value['acceptanceCriteria']) ||
		!isProviderMetadata(value['provider'], schemaVersion === 3) ||
		!isOptionalRoutingMetadata(value['routing']) ||
		!isOptionalNullableString(value['failureCode']) ||
		(patchPath === null) !== (patchSha256 === null) ||
		(patchSha256 !== null && !/^[a-f0-9]{64}$/i.test(patchSha256))
	) {
		throw invalidReport()
	}

	for (const field of [
		'objective',
		'repositoryPath',
		'baseRef',
		'workerSummary',
	] as const) {
		requireReportString(value[field])
	}

	return value as WorkerRunReport
}

function isReportEvaluationConsistent(
	schemaVersion: unknown,
	status: unknown,
	failureCode: unknown,
	evaluation: unknown,
	provider: unknown,
): boolean {
	if (schemaVersion !== 3) {
		return true
	}
	if (!isRunStatus(status) || !isEvaluationSummary(evaluation)) {
		return false
	}
	if (status === 'completed') {
		return evaluation.outcome !== 'failed' &&
			(!isStrictWorkerProfile(provider) || evaluation.outcome === 'passed')
	}
	if (evaluation.outcome === 'failed') {
		return true
	}
	return (
		status === 'failed' &&
		failureCode === 'EVALUATION_INCONCLUSIVE' &&
		isStrictWorkerProfile(provider)
	)
}

function isStrictWorkerProfile(provider: unknown): boolean {
	return isRecord(provider) &&
		isRecord(provider['profile']) &&
		provider['profile']['evaluationPolicy'] === 'strict'
}

function isUuid(value: unknown): value is string {
	return typeof value === 'string' &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function isCommandResults(value: unknown): value is Array<CommandResult> {
	return Array.isArray(value) && value.every(item => {
		if (!isRecord(item)) {
			return false
		}

		return (
			hasExpectedKeys(item, [
				'command',
				'args',
				'exitCode',
				'signal',
				'stdout',
				'stderr',
				'durationMs',
				'timedOut',
				'outputTruncated',
			], []) &&
			typeof item['command'] === 'string' &&
			isStringArray(item['args']) &&
			(item['exitCode'] === null || Number.isInteger(item['exitCode'])) &&
			(item['signal'] === null || typeof item['signal'] === 'string') &&
			typeof item['stdout'] === 'string' &&
			typeof item['stderr'] === 'string' &&
			isNonNegativeInteger(item['durationMs']) &&
			typeof item['timedOut'] === 'boolean' &&
			typeof item['outputTruncated'] === 'boolean'
		)
	})
}

function isAcceptanceResults(
	value: unknown,
): value is Array<AcceptanceCriterionResult> {
	return Array.isArray(value) && value.every(item => {
		if (!isRecord(item)) {
			return false
		}

		return (
			hasExpectedKeys(item, ['criterion', 'status', 'evidence'], []) &&
			typeof item['criterion'] === 'string' &&
			(item['status'] === 'passed' ||
				item['status'] === 'failed' ||
				item['status'] === 'unknown') &&
			isStringArray(item['evidence'])
		)
	})
}

function isProviderMetadata(
	value: unknown,
	requireIdentity: boolean,
): boolean {
	if (
		!isRecord(value) ||
		!hasExpectedKeys(
			value,
			['baseUrl', 'model', 'requestCount'],
			[
				'workerId',
				'adapter',
				'profile',
				'inputTokens',
				'outputTokens',
				'totalTokens',
				'totalLatencyMs',
				'estimatedCostUsd',
			],
		) ||
		typeof value['baseUrl'] !== 'string' ||
		typeof value['model'] !== 'string' ||
		!isNonNegativeInteger(value['requestCount'])
	) {
		return false
	}

	return (
		(requireIdentity
			? isWorkerId(value['workerId']) && isWorkerAdapter(value['adapter'])
			: isOptionalString(value['workerId']) &&
				(value['adapter'] === undefined || isWorkerAdapter(value['adapter']))) &&
		isOptionalWorkerProfile(value['profile']) &&
		isOptionalNonNegativeInteger(value['inputTokens']) &&
		isOptionalNonNegativeInteger(value['outputTokens']) &&
		isOptionalNonNegativeInteger(value['totalTokens']) &&
		isOptionalNonNegativeInteger(value['totalLatencyMs']) &&
		(value['estimatedCostUsd'] === undefined ||
			value['estimatedCostUsd'] === null ||
			(typeof value['estimatedCostUsd'] === 'number' &&
				Number.isFinite(value['estimatedCostUsd']) &&
				value['estimatedCostUsd'] >= 0))
	)
}

function isWorkerId(value: unknown): value is string {
	return typeof value === 'string' &&
		/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)
}

function isWorkerAdapter(value: unknown): boolean {
	return value === 'openai-compatible' ||
		value === 'anthropic' ||
		value === 'codex'
}

function isOptionalWorkerProfile(value: unknown): boolean {
	if (value === undefined) {
		return true
	}
	return (
		isRecord(value) &&
		hasExpectedKeys(value, [
			'backingWorkerId',
			'role',
			'maxIterations',
			'evaluationPolicy',
		], []) &&
		typeof value['backingWorkerId'] === 'string' &&
		/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value['backingWorkerId']) &&
		isWorkerMode(value['role']) &&
		isPositiveInteger(value['maxIterations']) &&
		(value['maxIterations'] as number) <= 64 &&
		(value['evaluationPolicy'] === 'default' ||
			value['evaluationPolicy'] === 'strict')
	)
}

function isOptionalRoutingMetadata(value: unknown): boolean {
	if (value === undefined) {
		return true
	}
	if (!isRecord(value)) {
		return false
	}

	return (
		hasExpectedKeys(value, [
			'strategy',
			'requiredCapabilities',
			'candidateWorkerIds',
			'selectedWorkerId',
			'attemptNumber',
			'maxAttempts',
			'fallbackEnabled',
			'previousAttempts',
		], []) &&
		(value['strategy'] === 'balanced' ||
			value['strategy'] === 'cost' ||
			value['strategy'] === 'latency' ||
			value['strategy'] === 'quality') &&
		isWorkerCapabilities(value['requiredCapabilities']) &&
		isStringArray(value['candidateWorkerIds']) &&
		typeof value['selectedWorkerId'] === 'string' &&
		isPositiveInteger(value['attemptNumber']) &&
		isPositiveInteger(value['maxAttempts']) &&
		typeof value['fallbackEnabled'] === 'boolean' &&
		Array.isArray(value['previousAttempts']) &&
		value['previousAttempts'].every(isWorkerAttempt) &&
		(value['attemptNumber'] as number) <= (value['maxAttempts'] as number) &&
		(value['previousAttempts'] as Array<unknown>).length ===
			(value['attemptNumber'] as number) - 1 &&
		(value['candidateWorkerIds'] as Array<string>).includes(
			value['selectedWorkerId'] as string,
		)
	)
}

function isWorkerAttempt(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasExpectedKeys(
			value,
			['runId', 'workerId', 'status', 'failureCode'],
			[],
		) &&
		typeof value['runId'] === 'string' &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value['runId']) &&
		typeof value['workerId'] === 'string' &&
		isRunStatus(value['status']) &&
		(value['failureCode'] === null || typeof value['failureCode'] === 'string')
	)
}

function isWorkerCapabilities(value: unknown): boolean {
	return Array.isArray(value) && value.every(item =>
		item === 'research' ||
		item === 'implementation' ||
		item === 'testing' ||
		item === 'review' ||
		item === 'tool-calling' ||
		item === 'long-context' ||
		item === 'private',
	)
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === 'string'
}

function isOptionalNullableString(value: unknown): boolean {
	return value === undefined || value === null || typeof value === 'string'
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
	return value === undefined || isNonNegativeInteger(value)
}

function isPositiveInteger(value: unknown): boolean {
	return typeof value === 'number' && Number.isInteger(value) && value > 0
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

function isWorkerMode(value: unknown): value is WorkerMode {
	return (
		value === 'research' ||
		value === 'implementation' ||
		value === 'testing' ||
		value === 'review'
	)
}

function isStringArray(value: unknown): value is Array<string> {
	return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function nullableString(value: unknown): string | null {
	if (value === null || typeof value === 'string') {
		return value
	}

	throw invalidReport()
}

function requireReportString(value: unknown): string {
	if (typeof value !== 'string') {
		throw invalidReport()
	}

	return value
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isIsoDate(value: unknown): value is string {
	return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function hasExpectedKeys(
	value: Record<string, unknown>,
	requiredKeys: Array<string>,
	optionalKeys: Array<string>,
): boolean {
	const keys = Object.keys(value)
	const allowedKeys = new Set([...requiredKeys, ...optionalKeys])
	return requiredKeys.every(key => Object.hasOwn(value, key)) &&
		keys.every(key => allowedKeys.has(key))
}

function invalidReport(): HarnessError {
	return new HarnessError('INVALID_RUN_REPORT', 'Run report has an invalid shape')
}
