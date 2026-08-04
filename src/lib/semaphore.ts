export class Semaphore {
	private available: number
	private readonly waiting: Array<() => void> = []

	constructor(limit: number) {
		if (!Number.isInteger(limit) || limit < 1) {
			throw new Error('Semaphore limit must be a positive integer')
		}

		this.available = limit
	}

	async use<Result>(operation: () => Promise<Result>): Promise<Result> {
		await this.acquire()

		try {
			return await operation()
		} finally {
			this.release()
		}
	}

	private async acquire(): Promise<void> {
		if (this.available > 0) {
			this.available -= 1
			return
		}

		await new Promise<void>(resolve => {
			this.waiting.push(resolve)
		})
	}

	private release(): void {
		const next = this.waiting.shift()

		if (next !== undefined) {
			next()
			return
		}

		this.available += 1
	}
}
