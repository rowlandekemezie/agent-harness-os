import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

test('includes custom worker secret environment names in generated Codex configuration', async function () {
	const cliPath = path.resolve('dist/src/cli.js')
	const { stdout } = await execFileAsync(process.execPath, [cliPath, 'codex-config'], {
		env: {
			...process.env,
			AGENT_OS_WORKERS_JSON: JSON.stringify([
				{
					id: 'custom',
					adapter: 'openai-compatible',
					model: 'custom-model',
					baseUrl: 'https://provider.example/v1',
					apiKeyEnv: 'CUSTOM_PROVIDER_KEY',
					headerEnv: { 'x-tenant-token': 'CUSTOM_TENANT_TOKEN' },
					capabilities: ['implementation', 'tool-calling'],
				},
				{
					id: 'unprofiled',
					adapter: 'openai-compatible',
					model: 'unprofiled-model',
					baseUrl: 'https://unprofiled.example/v1',
					apiKeyEnv: 'UNPROFILED_PROVIDER_KEY',
					headerEnv: { 'x-private-token': 'UNPROFILED_PRIVATE_TOKEN' },
					capabilities: ['review', 'tool-calling'],
				},
			]),
			AGENT_OS_WORKER_PROFILES_JSON: JSON.stringify([{
				id: 'custom-implementation',
				worker: 'custom',
				role: 'implementation',
				allowedCapabilities: ['implementation', 'tool-calling'],
			}]),
			AGENT_OS_ORGANIZATION_POLICY_PATH: '/etc/agent-os/policy.json',
		},
	})

	assert.match(stdout, /"CUSTOM_PROVIDER_KEY"/)
	assert.match(stdout, /"CUSTOM_TENANT_TOKEN"/)
	assert.match(stdout, /"UNPROFILED_PROVIDER_KEY"/)
	assert.match(stdout, /"UNPROFILED_PRIVATE_TOKEN"/)
	assert.match(stdout, /"AGENT_OS_WORKER_PROFILES_JSON"/)
	assert.match(stdout, /"AGENT_OS_ORGANIZATION_POLICY_PATH"/)
})
