export type OperationTimer = {
	startedAt: string
	startedMonotonicNs: bigint
}

export type OperationTiming = {
	startedAt: string
	completedAt: string
	durationMs: number
}

export function startOperationTimer(): OperationTimer {
	return {
		startedAt: new Date().toISOString(),
		startedMonotonicNs: process.hrtime.bigint(),
	}
}

export function finishOperationTimer(timer: OperationTimer): OperationTiming {
	const elapsedNs = process.hrtime.bigint() - timer.startedMonotonicNs
	const durationMs = Number(elapsedNs / 1_000_000n)
	const startedAtMs = Date.parse(timer.startedAt)
	const completedAtMs = Math.max(Date.now(), startedAtMs)

	return {
		startedAt: timer.startedAt,
		completedAt: new Date(completedAtMs).toISOString(),
		durationMs: Number.isSafeInteger(durationMs) && durationMs >= 0
			? durationMs
			: Number.MAX_SAFE_INTEGER,
	}
}
