#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.js'
import { getErrorMessage } from './lib/errors.js'
import { McpTools } from './mcp/tools.js'
import { startMcpServer } from './mcp/server.js'

const command = process.argv[2] ?? 'help'

try {
	switch (command) {
		case 'mcp':
			await startMcpServer(loadConfig())
			break
		case 'doctor': {
			const tools = new McpTools(loadConfig())
			const health = await tools.call('health_check', {})
			process.stdout.write(`${health.content[0]?.text ?? '{}'}\n`)
			process.exitCode =
				health.isError === true ||
				health.structuredContent?.['status'] !== 'ready'
					? 1
					: 0
			break
		}
		case 'codex-config':
			process.stdout.write(renderCodexConfig(loadConfig()))
			break
		case '--version':
		case 'version':
			process.stdout.write('0.2.0\n')
			break
		case 'help':
		case '--help':
		case '-h':
			process.stdout.write(renderHelp())
			break
		default:
			process.stderr.write(`Unknown command: ${command}\n`)
			process.stderr.write(renderHelp())
			process.exitCode = 1
	}
} catch (error) {
	process.stderr.write(`${getErrorMessage(error)}\n`)
	process.exitCode = 1
}

function renderCodexConfig(config: ReturnType<typeof loadConfig>): string {
	const cliPath = fileURLToPath(import.meta.url).replaceAll('\\', '\\\\').replaceAll('"', '\\"')
	const nodePath = process.execPath.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
	const envVars = [...new Set([
		'AGENT_OS_WORKERS_JSON',
		'AGENT_OS_DEFAULT_WORKER',
		'AGENT_OS_ROUTING_STRATEGY',
		'AGENT_OS_MAX_WORKER_ATTEMPTS',
		'CODEX_HOME',
		'HOME',
		'USERPROFILE',
		'XDG_CONFIG_HOME',
		'XDG_DATA_HOME',
		'XDG_RUNTIME_DIR',
		'APPDATA',
		'LOCALAPPDATA',
		'HTTPS_PROXY',
		'HTTP_PROXY',
		'ALL_PROXY',
		'NO_PROXY',
		'SSL_CERT_FILE',
		'SSL_CERT_DIR',
		'OPENAI_API_KEY',
		'ANTHROPIC_API_KEY',
		'GEMINI_API_KEY',
		'OPENROUTER_API_KEY',
		'QWEN_API_KEY',
		'QWEN_BASE_URL',
		'QWEN_CHAT_COMPLETIONS_URL',
		'QWEN_MODEL',
		'QWEN_HEADERS_JSON',
		'QWEN_TIMEOUT_MS',
		'QWEN_MAX_RETRIES',
		'QWEN_MAX_RESPONSE_BYTES',
		'QWEN_ALLOW_INSECURE_HTTP',
		'AGENT_HARNESS_EXECUTION_BACKEND',
		'AGENT_HARNESS_ALLOW_UNSANDBOXED_LOCAL',
		'AGENT_HARNESS_DOCKER_IMAGE',
		'AGENT_HARNESS_DOCKER_NETWORK',
		'AGENT_HARNESS_REQUIRE_PINNED_DOCKER_IMAGE',
		'AGENT_HARNESS_ALLOWED_COMMANDS',
		'AGENT_HARNESS_COMMAND_TIMEOUT_MS',
		'AGENT_HARNESS_MAX_CONCURRENCY',
		'AGENT_HARNESS_MAX_FILE_BYTES',
		'AGENT_HARNESS_MAX_TOOL_OUTPUT_BYTES',
		'AGENT_HARNESS_MAX_MCP_MESSAGE_BYTES',
		'AGENT_HARNESS_MAX_MCP_IN_FLIGHT',
		'AGENT_HARNESS_MAX_CHANGED_FILES',
		'AGENT_HARNESS_MAX_SEARCH_BYTES',
		'AGENT_HARNESS_MAX_TRAVERSAL_ENTRIES',
		'AGENT_HARNESS_MAX_TOTAL_TOOL_CALLS',
		'AGENT_HARNESS_MAX_PROVIDER_CONTEXT_BYTES',
		'AGENT_HARNESS_ARTIFACT_ROOT',
		'AGENT_HARNESS_LOG_LEVEL',
		...config.workers.flatMap(worker => [
			...(worker.apiKeyEnv === null ? [] : [worker.apiKeyEnv]),
			...worker.headerEnvNames,
		]),
	])].sort()

	return `[mcp_servers.agent_os]
command = "${nodePath}"
args = ["${cliPath}", "mcp"]
env_vars = ${JSON.stringify(envVars)}
startup_timeout_sec = 20
tool_timeout_sec = 3600
required = true
default_tools_approval_mode = "writes"

[mcp_servers.agent_os.tools.health_check]
approval_mode = "approve"

[mcp_servers.agent_os.tools.list_workers]
approval_mode = "approve"

[mcp_servers.agent_os.tools.route_worker]
approval_mode = "approve"

[mcp_servers.agent_os.tools.get_worker_run]
approval_mode = "approve"

[mcp_servers.agent_os.tools.delegate_to_worker]
approval_mode = "prompt"

[mcp_servers.agent_os.tools.apply_worker_patch]
approval_mode = "prompt"
`
}

function renderHelp(): string {
	return `agent-harness-os

Commands:
	mcp           Start the STDIO MCP server
	doctor        Inspect worker registry, routing, Git, Docker, and execution configuration
	codex-config  Print a Codex MCP configuration block
	version       Print the package version
	help          Show this help
`
}
