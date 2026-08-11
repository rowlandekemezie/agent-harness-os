import assert from 'node:assert/strict'
import test from 'node:test'
import { ProviderTelemetry } from '../../src/provider/telemetry.js'

test('estimates cost only from complete provider usage', function () {
	const telemetry = new ProviderTelemetry({
		inputPerMillion: 1,
		outputPerMillion: 2,
	})
	telemetry.recordRequest({
		inputTokens: 100,
		outputTokens: 50,
		durationMs: 25,
	})

	assert.deepEqual(telemetry.getUsage(), {
		requestCount: 1,
		inputTokens: 100,
		outputTokens: 50,
		totalTokens: 150,
		totalLatencyMs: 25,
		estimatedCostUsd: 0.0002,
	})
})

test('does not price omitted or malformed provider usage', function () {
	for (const usage of [
		{},
		{ inputTokens: Number.NaN, outputTokens: 50 },
		{ inputTokens: 100, outputTokens: -1 },
	]) {
		const telemetry = new ProviderTelemetry({
			inputPerMillion: 1,
			outputPerMillion: 2,
		})
		telemetry.recordRequest({
			...usage,
			durationMs: 25,
		})
		telemetry.recordRequest({
			inputTokens: 100,
			outputTokens: 50,
			durationMs: 25,
		})

		assert.equal(telemetry.getUsage().estimatedCostUsd, null)
	}
})

test('does not estimate zero cost before any provider request', function () {
	const telemetry = new ProviderTelemetry({
		inputPerMillion: 1,
		outputPerMillion: 2,
	})

	assert.equal(telemetry.getUsage().estimatedCostUsd, null)
})
