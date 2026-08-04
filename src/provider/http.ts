import { HarnessError, isAbortError } from '../lib/errors.js'

export async function fetchProviderResponse(
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const timeoutController = new AbortController()
	const timer = setTimeout(() => timeoutController.abort(), timeoutMs)
	const signal = combineSignals(init.signal, timeoutController.signal)

	try {
		return await fetch(url, { ...init, signal })
	} catch (error) {
		if (
			timeoutController.signal.aborted &&
			init.signal?.aborted !== true
		) {
			throw new HarnessError(
				'PROVIDER_TIMEOUT',
				`Provider request exceeded ${timeoutMs}ms`,
			)
		}

		throw error
	} finally {
		clearTimeout(timer)
	}
}

export async function readProviderResponseText(
	response: Response,
	maxBytes: number,
): Promise<string> {
	const declaredLength = Number.parseInt(
		response.headers.get('content-length') ?? '',
		10,
	)

	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		await response.body?.cancel()
		throw new HarnessError(
			'PROVIDER_RESPONSE_TOO_LARGE',
			`Provider response exceeded ${maxBytes} bytes`,
		)
	}

	if (response.body === null) {
		return ''
	}

	const reader = response.body.getReader()
	const chunks: Array<Uint8Array> = []
	let totalBytes = 0

	while (true) {
		const { done, value } = await reader.read()

		if (done) {
			break
		}

		totalBytes += value.byteLength

		if (totalBytes > maxBytes) {
			await reader.cancel()
			throw new HarnessError(
				'PROVIDER_RESPONSE_TOO_LARGE',
				`Provider response exceeded ${maxBytes} bytes`,
			)
		}

		chunks.push(value)
	}

	return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
}

export function isRetryableProviderFailure(error: unknown): boolean {
	if (isAbortError(error)) {
		return false
	}

	return !(error instanceof HarnessError) || error.code === 'PROVIDER_TIMEOUT'
}

export async function sleepWithJitter(
	attempt: number,
	signal: AbortSignal,
): Promise<void> {
	if (signal.aborted) {
		throw new DOMException('Retry delay aborted', 'AbortError')
	}

	const baseDelay = Math.min(8_000, 500 * 2 ** attempt)
	const delay = baseDelay + Math.floor(Math.random() * 250)

	await new Promise<void>((resolve, reject) => {
		function cleanup(): void {
			signal.removeEventListener('abort', abort)
		}

		const timer = setTimeout(() => {
			cleanup()
			resolve()
		}, delay)

		function abort(): void {
			clearTimeout(timer)
			cleanup()
			reject(new DOMException('Retry delay aborted', 'AbortError'))
		}

		signal.addEventListener('abort', abort, { once: true })
	})
}

function combineSignals(
	first: AbortSignal | null | undefined,
	second: AbortSignal,
): AbortSignal {
	if (first === undefined || first === null) {
		return second
	}

	return AbortSignal.any([first, second])
}
