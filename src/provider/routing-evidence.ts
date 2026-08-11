import { createHash } from 'node:crypto'
import type {
	RoutingEvidenceSnapshot,
	RoutingEvidenceTaskSource,
	RunStatus,
	TaskTimeline,
	WorkerMode,
	WorkerRoutingEvidence,
} from '../domain/types.js'
import { TaskJournal } from '../artifacts/task-journal.js'
import { HarnessError } from '../lib/errors.js'

type RoutingObservation = {
	workerId: string
	status: RunStatus
	evaluationPassed: boolean
	evaluationRecorded: boolean
	patchProduced: boolean
	patchApplied: boolean
	durationMs: number
	providerLatencyMs: number
	totalTokens: number
	estimatedCostMicroUsd: number | null
}

export type CollectRoutingEvidenceInput = {
	artifactRoot: string
	repositoryPath: string
	mode: WorkerMode
	workerIds: Array<string>
	taskLimit: number
	signal?: AbortSignal
}

export class RoutingEvidenceStore {
	private readonly taskJournal: TaskJournal

	constructor(taskJournal: TaskJournal) {
		this.taskJournal = taskJournal
	}

	async collect(
		input: CollectRoutingEvidenceInput,
	): Promise<RoutingEvidenceSnapshot> {
		input.signal?.throwIfAborted()
		assertCollectInput(input)
		if (input.taskLimit === 0) {
			return createSnapshot(input.mode, 0, 0, [], [])
		}

		const page = await this.taskJournal.list(input.artifactRoot, {
			limit: input.taskLimit,
			cursor: null,
			status: null,
			mode: input.mode,
			workerId: null,
		}, input.signal)
		const observations: Array<RoutingObservation> = []
		const sources: Array<RoutingEvidenceTaskSource> = []
		const includedWorkerIds = new Set(input.workerIds)

		for (const task of page.tasks) {
			input.signal?.throwIfAborted()
			if (task.repositoryPath !== input.repositoryPath) {
				continue
			}
			const timeline = await this.taskJournal.timeline(
				input.artifactRoot,
				task.taskId,
				input.signal,
			)
			sources.push({
				taskId: task.taskId,
				latestEventSha256: timeline.task.latestEventSha256,
			})
			observations.push(...collectTimelineObservations(
				timeline,
				includedWorkerIds,
			))
		}

		const workers = aggregateObservations(input.mode, observations)
		return createSnapshot(
			input.mode,
			input.taskLimit,
			observations.length,
			sources,
			workers,
		)
	}
}

function assertCollectInput(input: CollectRoutingEvidenceInput): void {
	if (
		!Number.isSafeInteger(input.taskLimit) ||
		input.taskLimit < 0 ||
		input.taskLimit > 100 ||
		input.workerIds.length > 64 ||
		new Set(input.workerIds).size !== input.workerIds.length ||
		input.workerIds.some(workerId =>
			!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(workerId),
		)
	) {
		throw new HarnessError(
			'INVALID_ROUTING_EVIDENCE_REQUEST',
			'Routing evidence request exceeds its task or worker bounds',
		)
	}
}

function collectTimelineObservations(
	timeline: TaskTimeline,
	workerIds: Set<string>,
): Array<RoutingObservation> {
	const workerByRun = new Map<string, string>()
	const evaluationByRun = new Map<string, 'passed' | 'failed' | 'inconclusive'>()
	const producedRuns = new Set<string>()
	const appliedRuns = new Set<string>()

	for (const event of timeline.events) {
		switch (event.type) {
			case 'WorkerStarted':
				workerByRun.set(event.data.runId, event.data.workerId)
				break
			case 'EvaluationCompleted':
				evaluationByRun.set(event.data.runId, event.data.outcome)
				break
			case 'PatchProduced':
				producedRuns.add(event.data.runId)
				break
			case 'PatchApplied':
				appliedRuns.add(event.data.runId)
				break
		}
	}

	return timeline.events.flatMap(event => {
		if (
			event.type !== 'AttemptCompleted' ||
			event.schemaVersion < 5 ||
			event.data.durationMs === undefined ||
			event.data.providerLatencyMs === undefined ||
			event.data.totalTokens === undefined ||
			event.data.estimatedCostMicroUsd === undefined
		) {
			return []
		}
		const workerId = workerByRun.get(event.data.runId)
		if (workerId === undefined || !workerIds.has(workerId)) {
			return []
		}
		const evaluation = evaluationByRun.get(event.data.runId)
		return [{
			workerId,
			status: event.data.status,
			evaluationPassed: evaluation === 'passed',
			evaluationRecorded: evaluation !== undefined,
			patchProduced: producedRuns.has(event.data.runId),
			patchApplied: appliedRuns.has(event.data.runId),
			durationMs: event.data.durationMs,
			providerLatencyMs: event.data.providerLatencyMs,
			totalTokens: event.data.totalTokens,
			estimatedCostMicroUsd: event.data.estimatedCostMicroUsd,
		}]
	})
}

function aggregateObservations(
	mode: WorkerMode,
	observations: Array<RoutingObservation>,
): Array<WorkerRoutingEvidence> {
	const workerIds = [...new Set(observations.map(item => item.workerId))].sort()
	return workerIds.map(workerId => {
		const workerObservations = observations.filter(
			item => item.workerId === workerId,
		)
		const evaluations = workerObservations.filter(
			item => item.evaluationRecorded,
		)
		const produced = workerObservations.filter(item => item.patchProduced)
		const costs = workerObservations.flatMap(item =>
			item.estimatedCostMicroUsd === null
				? []
				: [item.estimatedCostMicroUsd],
		)
		return {
			workerId,
			mode,
			sampleSize: workerObservations.length,
			successCount: workerObservations.filter(
				item => item.status === 'completed',
			).length,
			evaluationCount: evaluations.length,
			evaluationPassCount: evaluations.filter(
				item => item.evaluationPassed,
			).length,
			patchProducedCount: produced.length,
			patchAppliedCount: produced.filter(item => item.patchApplied).length,
			medianDurationMs: median(
				workerObservations.map(item => item.durationMs),
			),
			averageProviderLatencyMs: average(
				workerObservations.map(item => item.providerLatencyMs),
			),
			averageTotalTokens: average(
				workerObservations.map(item => item.totalTokens),
			),
			averageEstimatedCostMicroUsd: costs.length === 0
				? null
				: average(costs),
		}
	})
}

function createSnapshot(
	mode: WorkerMode,
	taskLimit: number,
	sampledAttemptCount: number,
	sources: Array<RoutingEvidenceTaskSource>,
	workers: Array<WorkerRoutingEvidence>,
): RoutingEvidenceSnapshot {
	const contents = {
		schemaVersion: 1 as const,
		mode,
		taskLimit,
		sampledTaskCount: sources.length,
		sampledAttemptCount,
		sources,
		workers,
	}
	return {
		...contents,
		sha256: createHash('sha256')
			.update(JSON.stringify(contents))
			.digest('hex'),
	}
}

function average(values: Array<number>): number {
	return Math.round(values.reduce(
		(currentAverage, value, index) =>
			currentAverage + (value - currentAverage) / (index + 1),
		0,
	))
}

function median(values: Array<number>): number {
	const sorted = [...values].sort((left, right) => left - right)
	const middle = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 0
		? Math.round(
			sorted[middle - 1]! +
				(sorted[middle]! - sorted[middle - 1]!) / 2,
		)
		: sorted[middle]!
}
