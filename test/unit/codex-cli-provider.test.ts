import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadConfig } from '../../src/config.js'
import type { ProviderRequest } from '../../src/domain/types.js'
import { Logger } from '../../src/lib/logger.js'
import { CodexCliProvider } from '../../src/provider/codex-cli.js'

async function createFakeCodex(authStatus = 'Logged in using ChatGPT'): Promise<{
	command: string
	directory: string
}> {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-os-fake-codex-'))
	const command = path.join(directory, 'codex')
	await writeFile(path.join(directory, 'auth-status.txt'), `${authStatus}\n`)
	await writeFile(command, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const directory = path.dirname(process.argv[1])
const args = process.argv.slice(2)
if (args[0] === 'login' && args[1] === 'status') {
	process.stdout.write(fs.readFileSync(path.join(directory, 'auth-status.txt'), 'utf8'))
	process.exit(0)
}
if (args[0] !== 'exec') process.exit(2)
let prompt = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { prompt += chunk })
process.stdin.on('end', () => {
	const outputIndex = args.indexOf('--output-last-message')
	const outputPath = args[outputIndex + 1]
	fs.appendFileSync(path.join(directory, 'invocations.jsonl'), JSON.stringify({
		args,
		prompt,
		leakedOpenAiApiKey: Boolean(process.env.OPENAI_API_KEY),
	}) + '\\n')
	fs.writeFileSync(outputPath, JSON.stringify({
		content: null,
		toolCalls: [{ id: 'read-1', name: 'read_file', arguments: { path: 'src/index.ts' } }],
	}))
})
`)
	await chmod(command, 0o755)
	return { command, directory }
}

function createRequest(): ProviderRequest {
	return {
		messages: [{ role: 'user', content: 'Inspect src/index.ts.' }],
		tools: [{
			type: 'function',
			function: {
				name: 'read_file',
				description: 'Read a repository file.',
				parameters: {
					type: 'object',
					properties: { path: { type: 'string' } },
					required: ['path'],
				},
			},
		}],
		signal: new AbortController().signal,
	}
}

function createProvider(command: string, authMode: 'chatgpt' | 'any' = 'chatgpt'): CodexCliProvider {
	const config = loadConfig({
		AGENT_OS_WORKERS_JSON: JSON.stringify([{
			id: 'codex-subscription',
			adapter: 'codex',
			command,
			authMode,
			capabilities: ['implementation', 'tool-calling'],
		}]),
	})
	return new CodexCliProvider(
		config.workers[0]!,
		new Logger('codex-provider-test', 'error'),
	)
}

test('delegates a provider turn through ephemeral read-only Codex exec', async function () {
	const fake = await createFakeCodex()
	const originalApiKey = process.env['OPENAI_API_KEY']
	process.env['OPENAI_API_KEY'] = 'must-not-reach-codex-subprocess'

	try {
		const provider = createProvider(fake.command)
		const completion = await provider.complete(createRequest())

		assert.equal(completion.content, null)
		assert.deepEqual(completion.toolCalls, [{
			id: 'read-1',
			type: 'function',
			function: {
				name: 'read_file',
				arguments: JSON.stringify({ path: 'src/index.ts' }),
			},
		}])

		const invocation = JSON.parse(
			(await readFile(path.join(fake.directory, 'invocations.jsonl'), 'utf8')).trim(),
		) as { args: Array<string>; prompt: string; leakedOpenAiApiKey: boolean }
		assert.equal(invocation.leakedOpenAiApiKey, false)
		assert.equal(invocation.args.includes('--ephemeral'), true)
		assert.deepEqual(
			invocation.args.slice(
				invocation.args.indexOf('--sandbox'),
				invocation.args.indexOf('--sandbox') + 2,
			),
			['--sandbox', 'read-only'],
		)
		assert.deepEqual(
			invocation.args.slice(
				invocation.args.indexOf('--ask-for-approval'),
				invocation.args.indexOf('--ask-for-approval') + 2,
			),
			['--ask-for-approval', 'never'],
		)
		assert.equal(invocation.args.includes('--ignore-user-config'), true)
		assert.equal(invocation.args.includes('--ignore-rules'), true)
		assert.equal(invocation.args.includes('--skip-git-repo-check'), true)
		assert.equal(invocation.args.includes('--output-schema'), true)
		assert.equal(invocation.args.includes('--output-last-message'), true)
		assert.equal(invocation.args.includes('--model'), false)
		assert.match(invocation.prompt, /Do not inspect local files/)
		assert.match(invocation.prompt, /read_file/)
		assert.equal(provider.getUsage().requestCount, 1)
		assert.equal(provider.getUsage().estimatedCostUsd, null)
	} finally {
		if (originalApiKey === undefined) {
			delete process.env['OPENAI_API_KEY']
		} else {
			process.env['OPENAI_API_KEY'] = originalApiKey
		}
	}
})

test('fails closed when Codex is authenticated with an API key by default', async function () {
	const fake = await createFakeCodex('Logged in using an API key')
	const provider = createProvider(fake.command)

	await assert.rejects(provider.complete(createRequest()), error => (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === 'PROVIDER_CODEX_CHATGPT_AUTH_REQUIRED'
	))
})

test('allows non-ChatGPT Codex auth only after explicit any-auth opt-in', async function () {
	const fake = await createFakeCodex('Logged in using an API key')
	const provider = createProvider(fake.command, 'any')
	const completion = await provider.complete(createRequest())
	assert.equal(completion.toolCalls[0]?.function.name, 'read_file')
})
