import { HarnessError, getErrorMessage } from '../lib/errors.js'
import { isRecord } from '../lib/json.js'
import { Logger } from '../lib/logger.js'

export type JsonRpcId = string | number | null

export type JsonRpcRequest = {
	jsonrpc: '2.0'
	id?: JsonRpcId
	method: string
	params?: unknown
}

export type RequestContext = {
	id: JsonRpcId | undefined
	signal: AbortSignal
}

export type RequestHandler = (
	method: string,
	params: unknown,
	context: RequestContext,
) => Promise<unknown>

export class StdioJsonRpcServer {
	private readonly handler: RequestHandler
	private readonly logger: Logger
	private readonly maxMessageBytes: number
	private readonly maxInFlight: number
	private readonly activeRequests = new Map<string, AbortController>()
	private readonly pendingRequests = new Set<Promise<void>>()

	constructor(
		handler: RequestHandler,
		logger: Logger,
		maxMessageBytes: number,
		maxInFlight: number,
	) {
		this.handler = handler
		this.logger = logger
		this.maxMessageBytes = maxMessageBytes
		this.maxInFlight = maxInFlight
	}

	async listen(): Promise<void> {
		let lineChunks: Array<Buffer> = []
		let lineBytes = 0
		let discardingOversizedLine = false

		for await (const rawChunk of process.stdin) {
			const chunk = Buffer.isBuffer(rawChunk)
				? rawChunk
				: Buffer.from(rawChunk)
			let offset = 0

			while (offset < chunk.byteLength) {
				const newlineIndex = chunk.indexOf(0x0a, offset)
				const segmentEnd = newlineIndex < 0 ? chunk.byteLength : newlineIndex
				const segment = chunk.subarray(offset, segmentEnd)

				if (!discardingOversizedLine) {
					if (lineBytes + segment.byteLength > this.maxMessageBytes) {
						discardingOversizedLine = true
						lineChunks = []
						lineBytes = 0
					} else if (segment.byteLength > 0) {
						lineChunks.push(segment)
						lineBytes += segment.byteLength
					}
				}

				if (newlineIndex < 0) {
					break
				}

				if (discardingOversizedLine) {
					this.writeError(
						null,
						-32600,
						`Request exceeds the ${this.maxMessageBytes}-byte MCP message limit`,
					)
				} else {
					this.dispatchLine(decodeLine(lineChunks, lineBytes))
				}

				lineChunks = []
				lineBytes = 0
				discardingOversizedLine = false
				offset = newlineIndex + 1
			}
		}

		if (discardingOversizedLine) {
			this.writeError(
				null,
				-32600,
				`Request exceeds the ${this.maxMessageBytes}-byte MCP message limit`,
			)
		} else if (lineBytes > 0) {
			this.dispatchLine(decodeLine(lineChunks, lineBytes))
		}

		await Promise.allSettled(this.pendingRequests)
	}

	private dispatchLine(line: string): void {
		if (line.trim() === '') {
			return
		}

		const requestMetadata = getRequestMetadata(line)

		if (
			this.pendingRequests.size >= this.maxInFlight &&
			requestMetadata.method !== 'notifications/cancelled'
		) {
			const requestId = requestMetadata.id

			if (requestId !== undefined) {
				this.writeError(
					requestId ?? null,
					-32000,
					`MCP server has reached the ${this.maxInFlight}-request in-flight limit`,
				)
			}

			return
		}

		const pending = this.handleLine(line)
		this.pendingRequests.add(pending)
		void pending.finally(() => this.pendingRequests.delete(pending))
	}

	private async handleLine(line: string): Promise<void> {
		let rawRequest: unknown

		try {
			rawRequest = JSON.parse(line)
		} catch {
			this.writeError(null, -32700, 'Parse error')
			return
		}

		if (!isValidRequest(rawRequest)) {
			this.writeError(null, -32600, 'Invalid Request')
			return
		}

		if (rawRequest.method === 'notifications/cancelled') {
			this.cancelRequest(rawRequest.params)
			return
		}

		const isNotification = rawRequest.id === undefined
		const controller = new AbortController()
		const requestKey = rawRequest.id === undefined
			? null
			: keyForId(rawRequest.id)

		if (requestKey !== null && this.activeRequests.has(requestKey)) {
			this.writeError(
				rawRequest.id ?? null,
				-32600,
				'Duplicate JSON-RPC request ID while an earlier request is active',
			)
			return
		}

		if (requestKey !== null) {
			this.activeRequests.set(requestKey, controller)
		}

		try {
			const result = await this.handler(rawRequest.method, rawRequest.params, {
				id: rawRequest.id,
				signal: controller.signal,
			})

			if (!isNotification) {
				this.write({ jsonrpc: '2.0', id: rawRequest.id ?? null, result })
			}
		} catch (error) {
			this.logger.error('MCP request failed', error, {
				method: rawRequest.method,
			})

			if (!isNotification) {
				const code = getJsonRpcErrorCode(error)
				this.writeError(
					rawRequest.id ?? null,
					code,
					getErrorMessage(error),
					error instanceof HarnessError
						? { harnessCode: error.code, ...error.details }
						: undefined,
				)
			}
		} finally {
			if (requestKey !== null) {
				this.activeRequests.delete(requestKey)
			}
		}
	}

	private cancelRequest(params: unknown): void {
		if (!isRecord(params)) {
			return
		}

		const requestId = params['requestId']

		if (
			typeof requestId !== 'string' &&
			typeof requestId !== 'number' &&
			requestId !== null
		) {
			return
		}

		this.activeRequests.get(keyForId(requestId))?.abort()
	}

	private writeError(
		id: JsonRpcId,
		code: number,
		message: string,
		data?: unknown,
	): void {
		this.write({
			jsonrpc: '2.0',
			id,
			error: {
				code,
				message,
				...(data === undefined ? {} : { data }),
			},
		})
	}

	private write(value: unknown): void {
		process.stdout.write(`${JSON.stringify(value)}\n`)
	}
}

function decodeLine(chunks: Array<Buffer>, totalBytes: number): string {
	const line = Buffer.concat(chunks, totalBytes)
	const withoutCarriageReturn = line.at(-1) === 0x0d
		? line.subarray(0, -1)
		: line
	return withoutCarriageReturn.toString('utf8')
}

function isValidRequest(value: unknown): value is JsonRpcRequest {
	if (!isRecord(value)) {
		return false
	}

	return value['jsonrpc'] === '2.0' && typeof value['method'] === 'string'
}

function getRequestMetadata(line: string): {
	id: JsonRpcId | undefined
	method: string | undefined
} {
	try {
		const value: unknown = JSON.parse(line)

		if (!isRecord(value)) {
			return { id: null, method: undefined }
		}

		const id = 'id' in value ? value['id'] : undefined
		return {
			id:
				typeof id === 'string' || typeof id === 'number' || id === null
					? id
					: id === undefined
						? undefined
						: null,
			method: typeof value['method'] === 'string' ? value['method'] : undefined,
		}
	} catch {
		return { id: null, method: undefined }
	}
}

function keyForId(id: JsonRpcId): string {
	return `${typeof id}:${String(id)}`
}

function getJsonRpcErrorCode(error: unknown): number {
	if (!(error instanceof HarnessError)) {
		return -32603
	}

	if (error.code === 'METHOD_NOT_FOUND') {
		return -32601
	}

	if (error.code === 'UNSUPPORTED_PROTOCOL_VERSION') {
		return -32022
	}

	return -32602
}
