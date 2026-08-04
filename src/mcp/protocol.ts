import { createInterface } from 'node:readline'
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
	private readonly activeRequests = new Map<string, AbortController>()
	private readonly pendingRequests = new Set<Promise<void>>()

	constructor(handler: RequestHandler, logger: Logger) {
		this.handler = handler
		this.logger = logger
	}

	async listen(): Promise<void> {
		const lines = createInterface({
			input: process.stdin,
			crlfDelay: Number.POSITIVE_INFINITY,
		})

		for await (const line of lines) {
			if (line.trim() === '') {
				continue
			}

			if (isLongRunningToolCall(line)) {
				const pending = this.handleLine(line)
				this.pendingRequests.add(pending)
				void pending.finally(() => this.pendingRequests.delete(pending))
				continue
			}

			await this.handleLine(line)
		}

		await Promise.allSettled(this.pendingRequests)
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

function isValidRequest(value: unknown): value is JsonRpcRequest {
	if (!isRecord(value)) {
		return false
	}

	return value['jsonrpc'] === '2.0' && typeof value['method'] === 'string'
}

function isLongRunningToolCall(line: string): boolean {
	try {
		const value: unknown = JSON.parse(line)
		return isRecord(value) && value['method'] === 'tools/call'
	} catch {
		return false
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
