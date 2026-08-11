import type { HarnessConfig, WorkerConfig } from '../config.js'
import { isWorkerConfigured } from '../config.js'
import type {
	RoutingStrategy,
	WorkerCapability,
	WorkerMode,
	WorkerRoutingPolicy,
} from '../domain/types.js'
import { HarnessError } from '../lib/errors.js'

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
}

export function routeWorkers(
	config: HarnessConfig,
	mode: WorkerMode,
	policy: WorkerRoutingPolicy,
): WorkerRoute {
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
	const candidates = configuredWorkers
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
		.sort(compareCandidates)

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

	return {
		strategy: policy.strategy,
		requiredCapabilities,
		candidates,
		maxAttempts,
		fallbackEnabled,
	}
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
