export class HarnessError extends Error {
	readonly code: string
	readonly details: Record<string, unknown>

	constructor(
		code: string,
		message: string,
		details: Record<string, unknown> = {},
	) {
		super(message)
		this.name = 'HarnessError'
		this.code = code
		this.details = details
	}
}

export function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message
	}

	return String(error)
}

export function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError'
}
