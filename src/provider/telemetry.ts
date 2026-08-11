import type { WorkerPricing } from '../config.js'
import type { ProviderUsage } from '../domain/types.js'

export class ProviderTelemetry {
	private requestCount = 0
	private inputTokens = 0
	private outputTokens = 0
	private totalLatencyMs = 0
	private completeTokenUsage = true
	private readonly pricing: WorkerPricing

	constructor(pricing: WorkerPricing) {
		this.pricing = pricing
	}

	recordRequest(input: {
		inputTokens?: number
		outputTokens?: number
		durationMs: number
	}): void {
		const inputTokens = normalizeTokenCount(input.inputTokens)
		const outputTokens = normalizeTokenCount(input.outputTokens)
		this.requestCount += 1
		this.inputTokens += inputTokens ?? 0
		this.outputTokens += outputTokens ?? 0
		this.totalLatencyMs += Math.max(0, Math.round(input.durationMs))
		if (inputTokens === null || outputTokens === null) {
			this.completeTokenUsage = false
		}
	}

	getUsage(): ProviderUsage {
		const totalTokens = this.inputTokens + this.outputTokens
		const estimatedCostUsd =
			this.requestCount === 0 ||
			!this.completeTokenUsage ||
			this.pricing.inputPerMillion === null ||
			this.pricing.outputPerMillion === null
				? null
				: (
					this.inputTokens * this.pricing.inputPerMillion +
					this.outputTokens * this.pricing.outputPerMillion
				) / 1_000_000

		return {
			requestCount: this.requestCount,
			inputTokens: this.inputTokens,
			outputTokens: this.outputTokens,
			totalTokens,
			totalLatencyMs: this.totalLatencyMs,
			estimatedCostUsd,
		}
	}
}

function normalizeTokenCount(value: number | undefined): number | null {
	return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value ?? null : null
}
