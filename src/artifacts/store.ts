import { createHash, randomUUID } from 'node:crypto'
import {
	chmod,
	lstat,
	mkdir,
	readFile,
	realpath,
	rename,
	writeFile,
} from 'node:fs/promises'
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

export type PersistRunInput = {
	artifactRoot: string
	report: WorkerRunReport
	patch: string
	workerTranscript: string
}

export class ArtifactStore {
	private readonly redactor: Redactor

	constructor(redactor = new Redactor()) {
		this.redactor = redactor
	}

	async persist(input: PersistRunInput): Promise<WorkerRunReport> {
		const runDirectory = path.join(input.artifactRoot, input.report.runId)
		await mkdir(input.artifactRoot, { recursive: true, mode: 0o700 })
		await chmod(input.artifactRoot, 0o700)
		try {
			await mkdir(runDirectory, { mode: 0o700 })
		} catch (error) {
			throw new HarnessError(
				'ARTIFACT_RUN_COLLISION',
				`Artifact run directory already exists or cannot be created: ${input.report.runId}`,
				{ cause: error instanceof Error ? error.message : String(error) },
			)
		}
		await chmod(runDirectory, 0o700)
		const patchPath = path.join(runDirectory, 'changes.patch')
		const reportPath = path.join(runDirectory, 'report.json')
		const transcriptPath = path.join(runDirectory, 'worker-transcript.txt')

		if (input.patch !== '') {
			// Patches must remain byte-faithful. Access is restricted by file mode.
			await atomicWrite(patchPath, input.patch, 0o600)
		}

		await atomicWrite(
			transcriptPath,
			this.redactor.redact(input.workerTranscript),
			0o600,
		)

		const persistedReport: WorkerRunReport = {
			...redactReport(input.report, this.redactor),
			patchPath: input.patch === '' ? null : patchPath,
			patchSha256: input.patch === '' ? null : sha256(input.patch),
			reportPath,
		}

		await atomicWrite(
			reportPath,
			`${JSON.stringify(persistedReport, null, 2)}\n`,
			0o600,
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
			contents = await readSecureArtifactFile(artifactRoot, reportPath)
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
			return validateReport(parsed, reportPath)
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

		return await readSecureArtifactFile(artifactRoot, expectedPatchPath)
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

function validateReport(value: unknown, expectedPath: string): WorkerRunReport {
	if (!isRecord(value)) {
		throw invalidReport()
	}

	const runId = requireReportString(value['runId'])
	validateRunId(runId)
	const patchPath = nullableString(value['patchPath'])
	const patchSha256 = nullableString(value['patchSha256'])

	if (
		value['schemaVersion'] !== 1 ||
		!isRunStatus(value['status']) ||
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
		!isProviderMetadata(value['provider']) ||
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

function isCommandResults(value: unknown): value is Array<CommandResult> {
	return Array.isArray(value) && value.every(item => {
		if (!isRecord(item)) {
			return false
		}

		return (
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
			typeof item['criterion'] === 'string' &&
			(item['status'] === 'passed' ||
				item['status'] === 'failed' ||
				item['status'] === 'unknown') &&
			isStringArray(item['evidence'])
		)
	})
}

function isProviderMetadata(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value['baseUrl'] === 'string' &&
		typeof value['model'] === 'string' &&
		isNonNegativeInteger(value['requestCount'])
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

function invalidReport(): HarnessError {
	return new HarnessError('INVALID_RUN_REPORT', 'Run report has an invalid shape')
}

async function readSecureArtifactFile(
	artifactRoot: string,
	filePath: string,
): Promise<Buffer> {
	assertPathInside(artifactRoot, filePath)
	const fileStats = await lstat(filePath)

	if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
		throw new HarnessError(
			'ARTIFACT_FILE_INVALID',
			'Artifact must be a regular file and cannot be a symbolic link',
		)
	}

	const [resolvedRoot, resolvedFile] = await Promise.all([
		realpath(artifactRoot),
		realpath(filePath),
	])
	assertPathInside(resolvedRoot, resolvedFile)

	return await readFile(resolvedFile)
}

function assertPathInside(rootPath: string, candidatePath: string): void {
	const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath))

	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new HarnessError(
			'ARTIFACT_PATH_INVALID',
			'Artifact path escapes the configured artifact root',
		)
	}
}

async function atomicWrite(
	filePath: string,
	contents: string,
	mode: number,
): Promise<void> {
	const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`
	await writeFile(temporaryPath, contents, { encoding: 'utf8', mode, flag: 'wx' })
	await rename(temporaryPath, filePath)
}
