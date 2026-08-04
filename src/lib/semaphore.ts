type SemaphoreWaiter = {
	resolve(): void
	reject(error: unknown): void
	signal?: AbortSignal
	abort?: () => void
	settled: boolean
}

export class Semaphore {
	private available: number
	private readonly waiting: Array<SemaphoreWaiter> = []

	constructor(limit: number) {
		if (!Number.isInteger(limit) || limit < 1) {
			throw new Error('Semaphore limit must be a positive integer')
		}

		this.available = limit
	}

	async use<Result>(
		operation: () => Promise<Result>,
		signal?: AbortSignal,
	): Promise<Result> {
		await this.acquire(signal)

		try {
			return await operation()
		} finally {
			this.release()
		}
	}

	private async acquire(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted === true) {
			throw new DOMException('Semaphore wait aborted', 'AbortError')
		}

		if (this.available > 0) {
			this.available -= 1
			return
		}

		await new Promise<void>((resolve, reject) => {
			const waiter: SemaphoreWaiter = {
				resolve,
				reject,
				...(signal === undefined ? {} : { signal }),
				settled: false,
			}

			if (signal !== undefined) {
				waiter.abort = () => {
					if (waiter.settled) {
						return
					}

					waiter.settled = true
					const index = this.waiting.indexOf(waiter)

					if (index >= 0) {
						this.waiting.splice(index, 1)
					}

					reject(new DOMException('Semaphore wait aborted', 'AbortError'))
				}
				signal.addEventListener('abort', waiter.abort, { once: true })
			}

			this.waiting.push(waiter)
		})
	}

	private release(): void {
		while (this.waiting.length > 0) {
			const next = this.waiting.shift()

			if (next === undefined || next.settled) {
				continue
			}

			if (next.signal?.aborted === true) {
				next.settled = true
				next.signal.removeEventListener('abort', next.abort as () => void)
				next.reject(new DOMException('Semaphore wait aborted', 'AbortError'))
				continue
			}

			next.settled = true

			if (next.signal !== undefined && next.abort !== undefined) {
				next.signal.removeEventListener('abort', next.abort)
			}

			next.resolve()
			return
		}

		this.available += 1
	}
}
