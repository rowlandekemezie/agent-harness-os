import type { HarnessConfig } from '../config.js'
import { HarnessError } from '../lib/errors.js'
import { isRecord, requireRecord, requireString } from '../lib/json.js'
import { Logger } from '../lib/logger.js'
import { StdioJsonRpcServer } from './protocol.js'
import { McpTools } from './tools.js'

const modernProtocolVersion = '2026-07-28'
const legacyProtocolVersions = new Set(['2025-11-25', '2025-06-18'])
const supportedProtocolVersions = [modernProtocolVersion, ...legacyProtocolVersions]
const serverInfo = { name: 'agent-harness-os', version: '0.1.0' }
const serverInstructions = 'Delegate bounded tasks to an isolated Qwen worker. Review reports before separately calling apply_worker_patch.'

export async function startMcpServer(config: HarnessConfig): Promise<void> {
	const logger = new Logger('mcp-server', config.logLevel)
	const tools = new McpTools(config)
	let initialized = false

	const server = new StdioJsonRpcServer(async (method, params, context) => {
		switch (method) {
			case 'server/discover':
				assertModernRequest(params)
				return {
					resultType: 'complete',
					supportedVersions: supportedProtocolVersions,
					capabilities: { tools: { listChanged: false } },
					_meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
					instructions: serverInstructions,
					ttlMs: 300000,
					cacheScope: 'private',
				}
			case 'initialize': {
				const input = requireRecord(params, 'initialize params')
				const requestedVersion = requireString(input['protocolVersion'], 'protocolVersion')
				const protocolVersion = legacyProtocolVersions.has(requestedVersion)
					? requestedVersion
					: '2025-11-25'

				return {
					protocolVersion,
					capabilities: { tools: { listChanged: false } },
					serverInfo,
					instructions: serverInstructions,
				}
			}
			case 'notifications/initialized':
				initialized = true
				return {}
			case 'ping':
				return isModernRequest(params) ? { resultType: 'complete' } : {}
			case 'tools/list': {
				const modern = authorizeRequest(initialized, params)
				return modern
					? {
						resultType: 'complete',
						tools: tools.list(),
						ttlMs: 300000,
						cacheScope: 'private',
					}
					: { tools: tools.list() }
			}
			case 'tools/call': {
				const modern = authorizeRequest(initialized, params)
				const input = requireRecord(params, 'tools/call params')
				const name = requireString(input['name'], 'name')
				const result = await tools.call(name, input['arguments'] ?? {}, context.signal)
				return modern ? { resultType: 'complete', ...result } : result
			}
			default:
				throw new HarnessError('METHOD_NOT_FOUND', `Unsupported MCP method: ${method}`)
		}
	}, logger)

	logger.info('Starting MCP server')
	await server.listen()
}

function authorizeRequest(initialized: boolean, params: unknown): boolean {
	if (isModernRequest(params)) {
		assertModernRequest(params)
		return true
	}

	if (!initialized) {
		throw new HarnessError('MCP_NOT_INITIALIZED', 'MCP client must initialize the server first')
	}

	return false
}

function isModernRequest(params: unknown): boolean {
	if (!isRecord(params)) {
		return false
	}

	const meta = params['_meta']
	return isRecord(meta) && meta['io.modelcontextprotocol/protocolVersion'] !== undefined
}

function assertModernRequest(params: unknown): void {
	const input = requireRecord(params, 'request params')
	const meta = requireRecord(input['_meta'], '_meta')
	const requestedVersion = requireString(
		meta['io.modelcontextprotocol/protocolVersion'],
		'io.modelcontextprotocol/protocolVersion',
	)

	if (requestedVersion !== modernProtocolVersion) {
		throw new HarnessError(
			'UNSUPPORTED_PROTOCOL_VERSION',
			'Unsupported protocol version',
			{ supported: supportedProtocolVersions, requested: requestedVersion },
		)
	}

	requireRecord(
		meta['io.modelcontextprotocol/clientCapabilities'],
		'io.modelcontextprotocol/clientCapabilities',
	)
}
