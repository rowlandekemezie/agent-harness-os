import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { access, mkdtemp, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadConfig, resolveArtifactRoot } from '../../src/config.js'
import { WorkerService } from '../../src/worker/service.js'
import { createTestRepository } from '../helpers/git.js'

async function startHangingProvider(): Promise<{
	baseUrl: string
	server: Server
	requestReceived: Promise<void>
	close(): Promise<void>
}> {
	let resolveRequestReceived: (() => void) | undefined
	const requestReceived = new Promise<void>(resolve => {
		resolveRequestReceived = resolve
	})
	const server = createServer(request => {
		request.resume()
		resolveRequestReceived?.()
	})

	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()

	if (address === null || typeof address === 'string') {
		throw new Error('Hanging provider did not bind to a TCP port')
	}

	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		server,
		requestReceived,
		close: async () => {
			server.closeAllConnections()
			await new Promise<void>((resolve, reject) => {
				server.close(error => error === undefined ? resolve() : reject(error))
			})
		},
	}
}

test('cancels an active provider request and releases worktree and repository lease', async function () {
	const repositoryPath = await createTestRepository()
	const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-cancel-'))
	const provider = await startHangingProvider()

	try {
		const config = loadConfig({
			QWEN_BASE_URL: provider.baseUrl,
			QWEN_API_KEY: 'test-api-key',
			QWEN_MODEL: 'fake-qwen',
			QWEN_MAX_RETRIES: '0',
			QWEN_TIMEOUT_MS: '60000',
			AGENT_HARNESS_ARTIFACT_ROOT: artifactRoot,
		})
		const service = new WorkerService(config)
		const controller = new AbortController()
		const operation = service.delegate({
			objective: 'Wait for cancellation.',
			repositoryPath,
			mode: 'research',
			allowedPaths: ['**/*'],
			prohibitedPaths: [],
			acceptanceCriteria: ['The request is cancelled safely.'],
			requiredCommands: [],
			baseRef: 'HEAD',
			maxIterations: 2,
			timeoutSeconds: 60,
			allowNetwork: false,
		}, controller.signal)

		await provider.requestReceived
		controller.abort()
		const report = await operation

		assert.equal(report.status, 'cancelled')
		assert.equal(report.patchPath, null)
		assert.equal(report.acceptanceCriteria[0]?.status, 'failed')

		const repositoryArtifactRoot = resolveArtifactRoot(repositoryPath, config)
		await assert.rejects(access(path.join(repositoryArtifactRoot, '.repository.lock')))
		const worktreeList = await readdir(path.join(repositoryPath, '.git', 'worktrees')).catch(() => [])
		assert.deepEqual(worktreeList, [])
	} finally {
		await provider.close()
	}
})
