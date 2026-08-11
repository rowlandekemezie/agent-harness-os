import { createHash } from 'node:crypto'
import type { HarnessConfig, WorkerConfig } from '../config.js'
import { isWorkerConfigured } from '../config.js'
import type {
	RoutingEvidenceSnapshot,
	RoutingStrategy,
	WorkerCapability,
	WorkerMode,
	WorkerRoutingEvidence,
	WorkerRoutingPolicy,
} from '../domain/types.js'
import { HarnessError } from '../lib/errors.js'

const evidenceWeights: Record<RoutingStrategy, {
	performance: number
	cost: number
	latency: number
}> = {
	balanced: { performance: 75_000, cost: 30_000, latency: 30_000 },
	cost: { performance: 20_000, cost: 60_000, latency: 0 },
	latency: { performance: 20_000, cost: 0, latency: 60_000 },
	quality: { performance: 300_000, cost: 0, latency: 0 },
}

export type WorkerRouteCandidate = {
	worker: WorkerConfig
	score: number
	reasons: Array<string>
}

export type WorkerRoute = {
	strategy: RoutingStrategy
	requiredCapabilities: Array<WorkerCapability>
	candidates: Array<WorkerRouteCandidate>
	maxAttempts: number
	fallbackEnabled: boolean
	evidence?: RoutingEvidenceSnapshot
	decisionSha256: string
}

export function routeWorkers(
	config: HarnessConfig,
	mode: WorkerMode,
	policy: WorkerRoutingPolicy,
	evidence?: RoutingEvidenceSnapshot,
): WorkerRoute {
	if (evidence !== undefined && evidence.mode !== mode) {
		throw new HarnessError(
			'ROUTING_EVIDENCE_MODE_MISMATCH',
			'Historical routing evidence does not match the requested task mode',
		)
	}
	const requiredCapabilities = uniqueCapabilities([
		mode,
		'tool-calling',
		...policy.requiredCapabilities,
	])
	const configuredWorkers = config.workers.filter(isWorkerConfigured)
	const preferredWorker = policy.preferredWorkerId === null
		? null
		: config.workers.find(worker => worker.id === policy.preferredWorkerId) ?? null

	if (policy.preferredWorkerId !== null && preferredWorker === null) {
		throw new HarnessError(
			'WORKER_NOT_FOUND',
			`Preferred worker does not exist: ${policy.preferredWorkerId}`,
		)
	}

	if (
		preferredWorker !== null &&
		!workerSatisfiesPolicy(preferredWorker, mode, requiredCapabilities, policy)
	) {
		throw new HarnessError(
			'WORKER_DOES_NOT_SATISFY_ROUTE',
			`Preferred worker ${preferredWorker.id} does not satisfy the routing contract`,
			{
				configurationIssues: preferredWorker.configurationIssues,
				requiredCapabilities,
				workerCapabilities: preferredWorker.capabilities,
				profile: preferredWorker.profile,
				maxCostTier: policy.maxCostTier,
				maxLatencyTier: policy.maxLatencyTier,
			},
		)
	}

	const defaultWorkerId = policy.preferredWorkerId ?? config.routing.defaultWorkerId
	const declaredCandidates = configuredWorkers
		.filter(worker => workerSatisfiesPolicy(
			worker,
			mode,
			requiredCapabilities,
			policy,
		))
		.map(worker => scoreWorker(
			worker,
			policy.strategy,
			defaultWorkerId,
		))
	const candidates = applyRoutingEvidence(
		declaredCandidates,
		policy.strategy,
		evidence,
	).sort((left, right) => compareCandidatesWithPreference(
		left,
		right,
		policy.preferredWorkerId,
	))

	if (candidates.length === 0) {
		throw new HarnessError(
			'NO_WORKER_ROUTE',
			'No configured worker satisfies the routing contract',
			{
				requiredCapabilities,
				strategy: policy.strategy,
				maxCostTier: policy.maxCostTier,
				maxLatencyTier: policy.maxLatencyTier,
				workers: config.workers.map(worker => ({
					id: worker.id,
					profile: worker.profile,
					enabled: worker.enabled,
					configured: isWorkerConfigured(worker),
					capabilities: worker.capabilities,
					configurationIssues: worker.configurationIssues,
				})),
			},
		)
	}

	const fallbackEnabled = policy.allowFallback && candidates.length > 1
	const maxAttempts = fallbackEnabled
		? Math.min(
			policy.maxAttempts,
			config.routing.maxAttempts,
			candidates.length,
		)
		: 1

	const routeWithoutDigest = {
		strategy: policy.strategy,
		requiredCapabilities,
		candidates,
		maxAttempts,
		fallbackEnabled,
		...(evidence === undefined ? {} : { evidence }),
	}
	return {
		...routeWithoutDigest,
		decisionSha256: routeDecisionSha256(routeWithoutDigest),
	}
}

export function routeDecisionSha256(
	route: Omit<WorkerRoute, 'decisionSha256'>,
): string {
	return createHash('sha256').update(JSON.stringify({
		schemaVersion: 1,
		strategy: route.strategy,
		requiredCapabilities: route.requiredCapabilities,
		candidates: route.candidates.map(candidate => ({
			workerId: candidate.worker.id,
			score: candidate.score,
			reasons: candidate.reasons,
		})),
		maxAttempts: route.maxAttempts,
		fallbackEnabled: route.fallbackEnabled,
		evidenceSha256: route.evidence?.sha256 ?? null,
	})).digest('hex')
}

function applyRoutingEvidence(
	candidates: Array<WorkerRouteCandidate>,
	strategy: RoutingStrategy,
	evidence: RoutingEvidenceSnapshot | undefined,
): Array<WorkerRouteCandidate> {
	if (evidence === undefined) {
		return candidates
	}
	const evidenceByWorker = new Map(
		evidence.workers.map(item => [item.workerId, item]),
	)
	const weights = evidenceWeights[strategy]
	const costAdjustments = rankMetricAdjustments(
		candidates,
		evidenceByWorker,
		item => item.averageEstimatedCostMicroUsd,
		weights.cost,
	)
	const latencyAdjustments = rankMetricAdjustments(
		candidates,
		evidenceByWorker,
		item => item.medianDurationMs,
		weights.latency,
	)

	return candidates.map(candidate => {
		const workerEvidence = evidenceByWorker.get(candidate.worker.id)
		if (workerEvidence === undefined) {
			return candidate
		}
		const performanceAdjustment = scorePerformance(
			workerEvidence,
			weights.performance,
		)
		const costAdjustment = costAdjustments.get(candidate.worker.id) ?? 0
		const latencyAdjustment = latencyAdjustments.get(candidate.worker.id) ?? 0
		return {
			...candidate,
			score: candidate.score + performanceAdjustment +
				costAdjustment + latencyAdjustment,
			reasons: [
				...candidate.reasons,
				formatEvidenceReason(workerEvidence),
			],
		}
	})
}

function scorePerformance(
	evidence: WorkerRoutingEvidence,
	maximumAdjustment: number,
): number {
	const successRate = evidence.successCount / evidence.sampleSize
	const evaluationRate = evidence.evaluationCount === 0
		? successRate
		: evidence.evaluationPassCount / evidence.evaluationCount
	const performance = (successRate + evaluationRate) / 2
	return Math.round(
		(performance - 0.5) * 2 * maximumAdjustment * evidenceConfidence(evidence),
	)
}

function rankMetricAdjustments(
	candidates: Array<WorkerRouteCandidate>,
	evidenceByWorker: Map<string, WorkerRoutingEvidence>,
	readMetric: (evidence: WorkerRoutingEvidence) => number | null,
	maximumAdjustment: number,
): Map<string, number> {
	if (maximumAdjustment === 0) {
		return new Map()
	}
	const metrics = candidates.flatMap(candidate => {
		const evidence = evidenceByWorker.get(candidate.worker.id)
		const value = evidence === undefined ? null : readMetric(evidence)
		return value === null || evidence === undefined
			? []
			: [{ workerId: candidate.worker.id, value, evidence }]
	})
	const uniqueValues = [...new Set(metrics.map(metric => metric.value))]
		.sort((left, right) => left - right)
	if (uniqueValues.length < 2) {
		return new Map()
	}

	return new Map(metrics.map(metric => {
		const rank = uniqueValues.indexOf(metric.value)
		const relative = 1 - (2 * rank) / (uniqueValues.length - 1)
		return [
			metric.workerId,
			Math.round(
				relative * maximumAdjustment * evidenceConfidence(metric.evidence),
			),
		]
	}))
}

function evidenceConfidence(evidence: WorkerRoutingEvidence): number {
	return Math.min(evidence.sampleSize, 20) / 20
}

function formatEvidenceReason(evidence: WorkerRoutingEvidence): string {
	const successPercent = Math.round(
		(evidence.successCount / evidence.sampleSize) * 100,
	)
	const evaluationPercent = evidence.evaluationCount === 0
		? null
		: Math.round(
			(evidence.evaluationPassCount / evidence.evaluationCount) * 100,
		)
	const patchAcceptance = evidence.patchProducedCount === 0
		? 'no produced patches'
		: `${evidence.patchAppliedCount}/${evidence.patchProducedCount} patches applied`
	const cost = evidence.averageEstimatedCostMicroUsd === null
		? 'cost unavailable'
		: `average cost $${(
			evidence.averageEstimatedCostMicroUsd / 1_000_000
		).toFixed(6)}`
	return `history ${evidence.sampleSize}: ${successPercent}% completed, ${
		evaluationPercent === null ? 'evaluation unavailable' : `${evaluationPercent}% evaluation passed`
	}, median ${evidence.medianDurationMs} ms, ${cost}, ${patchAcceptance}`
}

export function describeWorker(worker: WorkerConfig): Record<string, unknown> {
	return {
		id: worker.id,
		profile: worker.profile,
		enabled: worker.enabled,
		configured: isWorkerConfigured(worker),
		adapter: worker.adapter,
		model: worker.model,
		baseUrl: displayWorkerUrl(worker),
		capabilities: worker.capabilities,
		priority: worker.priority,
		costTier: worker.costTier,
		latencyTier: worker.latencyTier,
		pricing: worker.pricing,
		configurationIssues: worker.configurationIssues,
	}
}

function workerSatisfiesPolicy(
	worker: WorkerConfig,
	mode: WorkerMode,
	requiredCapabilities: Array<WorkerCapability>,
	policy: WorkerRoutingPolicy,
): boolean {
	return (
		isWorkerConfigured(worker) &&
		(worker.profile === null || worker.profile.role === mode) &&
		requiredCapabilities.every(capability =>
			worker.capabilities.includes(capability),
		) &&
		(policy.maxCostTier === null ||
			costRank(worker.costTier) <= costRank(policy.maxCostTier)) &&
		(policy.maxLatencyTier === null ||
			latencyRank(worker.latencyTier) <= latencyRank(policy.maxLatencyTier))
	)
}

function scoreWorker(
	worker: WorkerConfig,
	strategy: RoutingStrategy,
	preferredWorkerId: string | null,
): WorkerRouteCandidate {
	const reasons: Array<string> = []
	let score = worker.priority * 100

	if (worker.id === preferredWorkerId) {
		score += 1_000_000
		reasons.push('preferred worker')
	}

	switch (strategy) {
		case 'cost':
			score += (2 - costRank(worker.costTier)) * 20_000
			score += (2 - latencyRank(worker.latencyTier)) * 500
			reasons.push(`cost tier ${worker.costTier}`)
			break
		case 'latency':
			score += (2 - latencyRank(worker.latencyTier)) * 20_000
			score += (2 - costRank(worker.costTier)) * 500
			reasons.push(`latency tier ${worker.latencyTier}`)
			break
		case 'quality':
			score += worker.priority * 20_000
			reasons.push(`quality priority ${worker.priority}`)
			break
		case 'balanced':
			score += (2 - costRank(worker.costTier)) * 5_000
			score += (2 - latencyRank(worker.latencyTier)) * 5_000
			reasons.push(
				`balanced priority ${worker.priority}, cost ${worker.costTier}, latency ${worker.latencyTier}`,
			)
			break
	}

	return { worker, score, reasons }
}

function compareCandidates(
	left: WorkerRouteCandidate,
	right: WorkerRouteCandidate,
): number {
	return right.score - left.score || left.worker.id.localeCompare(right.worker.id)
}

function compareCandidatesWithPreference(
	left: WorkerRouteCandidate,
	right: WorkerRouteCandidate,
	preferredWorkerId: string | null,
): number {
	if (left.worker.id === preferredWorkerId) {
		return -1
	}
	if (right.worker.id === preferredWorkerId) {
		return 1
	}
	return compareCandidates(left, right)
}

function uniqueCapabilities(
	capabilities: Array<WorkerCapability>,
): Array<WorkerCapability> {
	return [...new Set(capabilities)]
}

function costRank(value: WorkerConfig['costTier']): number {
	return value === 'low' ? 0 : value === 'medium' ? 1 : 2
}

function latencyRank(value: WorkerConfig['latencyTier']): number {
	return value === 'fast' ? 0 : value === 'standard' ? 1 : 2
}

function displayWorkerUrl(worker: WorkerConfig): string | null {
	const value = worker.endpointUrl ?? worker.baseUrl
	if (value === '') {
		return null
	}

	const parsed = new URL(value)
	for (const key of parsed.searchParams.keys()) {
		parsed.searchParams.set(key, '[redacted]')
	}
	return parsed.toString()
}
