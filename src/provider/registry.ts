import type { HarnessConfig, WorkerConfig } from '../config.js'
import { getConfiguredWorkers, isWorkerConfigured } from '../config.js'
import type {
	RoutingEvidenceSnapshot,
	WorkerMode,
	WorkerProvider,
	WorkerRoutingPolicy,
} from '../domain/types.js'
import { HarnessError } from '../lib/errors.js'
import { Logger } from '../lib/logger.js'
import { AnthropicProvider } from './anthropic.js'
import { CodexCliProvider } from './codex-cli.js'
import { OpenAiCompatibleProvider } from './openai-compatible.js'
import {
	describeWorker,
	routeWorkers,
	type WorkerRoute,
} from './router.js'

export class WorkerRegistry {
	private readonly config: HarnessConfig
	private readonly logger: Logger

	constructor(config: HarnessConfig, logger: Logger) {
		this.config = config
		this.logger = logger
	}

	list(): Array<Record<string, unknown>> {
		return this.config.workers.map(describeWorker)
	}

	configuredCount(): number {
		return getConfiguredWorkers(this.config).length
	}

	route(
		mode: WorkerMode,
		policy?: WorkerRoutingPolicy,
		evidence?: RoutingEvidenceSnapshot,
	): WorkerRoute {
		const route = routeWorkers(
			this.config,
			mode,
			policy ?? defaultRoutingPolicy(this.config),
			evidence,
		)
		this.logger.debug('Routed worker task', {
			mode,
			strategy: route.strategy,
			candidates: route.candidates.map(candidate => candidate.worker.id),
		})
		return route
	}

	createProvider(worker: WorkerConfig): WorkerProvider {
		if (!isWorkerConfigured(worker)) {
			throw new HarnessError(
				'WORKER_NOT_CONFIGURED',
				`Worker ${worker.id} is not configured`,
				{ configurationIssues: worker.configurationIssues },
			)
		}

		const logger = new Logger(
			`worker-provider:${worker.id}`,
			this.config.logLevel,
		)

		switch (worker.adapter) {
			case 'openai-compatible':
				return new OpenAiCompatibleProvider(worker, logger)
			case 'anthropic':
				return new AnthropicProvider(worker, logger)
			case 'codex':
				return new CodexCliProvider(worker, logger)
			default:
				throw new HarnessError(
					'UNSUPPORTED_WORKER_ADAPTER',
					`Unsupported adapter for worker ${worker.id}: ${String(worker.adapter)}`,
				)
		}
	}
}

function defaultRoutingPolicy(
	config: HarnessConfig,
): WorkerRoutingPolicy {
	return {
		preferredWorkerId: null,
		requiredCapabilities: [],
		strategy: config.routing.defaultStrategy,
		maxCostTier: null,
		maxLatencyTier: null,
		allowFallback: true,
		maxAttempts: config.routing.maxAttempts,
	}
}
