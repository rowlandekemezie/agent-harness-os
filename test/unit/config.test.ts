import assert from 'node:assert/strict'
import { mkdtemp, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
	assertArtifactRootOutsideRepository,
	loadConfig,
} from '../../src/config.js'

function hasHarnessCode(code: string): (error: unknown) => boolean {
	return error => (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === code
	)
}

test('requires HTTPS for non-loopback provider endpoints by default', function () {
	assert.throws(
		() => loadConfig({ QWEN_BASE_URL: 'http://provider.example/v1' }),
		hasHarnessCode('INSECURE_PROVIDER_URL'),
	)
	assert.throws(
		() => loadConfig({ QWEN_BASE_URL: 'http://127.0.0.1.evil.example/v1' }),
		hasHarnessCode('INSECURE_PROVIDER_URL'),
	)

	assert.doesNotThrow(() =>
		loadConfig({ QWEN_BASE_URL: 'http://127.0.0.1:8080/v1' }),
	)
	assert.doesNotThrow(() =>
		loadConfig({ QWEN_BASE_URL: 'http://worker.localhost:8080/v1' }),
	)
	assert.doesNotThrow(() =>
		loadConfig({
			QWEN_BASE_URL: 'http://provider.example/v1',
			QWEN_ALLOW_INSECURE_HTTP: 'true',
		}),
	)
})

test('rejects provider URLs with embedded credentials or unsupported schemes', function () {
	assert.throws(
		() => loadConfig({ QWEN_BASE_URL: 'https://user:secret@example.com/v1' }),
		hasHarnessCode('INVALID_CONFIGURATION'),
	)
	assert.throws(
		() => loadConfig({ QWEN_BASE_URL: 'file:///tmp/provider' }),
		hasHarnessCode('INVALID_CONFIGURATION'),
	)
	assert.throws(
		() => loadConfig({ QWEN_BASE_URL: 'https://example.com/v1?token=value' }),
		hasHarnessCode('INVALID_CONFIGURATION'),
	)
})


test('rejects partially parsed integer configuration values', function () {
	for (const value of ['1.5', '10seconds', '0x10', '']) {
		if (value === '') {
			continue
		}

		assert.throws(
			() => loadConfig({ AGENT_HARNESS_MAX_CONCURRENCY: value }),
			hasHarnessCode('INVALID_CONFIGURATION'),
		)
	}
})

test('requires an absolute organization policy path', function () {
	assert.throws(
		() => loadConfig({ AGENT_OS_ORGANIZATION_POLICY_PATH: 'policy.json' }),
		hasHarnessCode('INVALID_CONFIGURATION'),
	)
	assert.equal(
		loadConfig({ AGENT_OS_ORGANIZATION_POLICY_PATH: '/etc/agent-os/policy.json' })
			.policy.organizationPolicyPath,
		'/etc/agent-os/policy.json',
	)
})

test('bounds the historical routing evidence window', function () {
	assert.equal(loadConfig({}).routing.evidenceTaskLimit, 100)
	assert.equal(
		loadConfig({ AGENT_OS_ROUTING_EVIDENCE_TASK_LIMIT: '0' })
			.routing.evidenceTaskLimit,
		0,
	)
	assert.throws(
		() => loadConfig({ AGENT_OS_ROUTING_EVIDENCE_TASK_LIMIT: '101' }),
		hasHarnessCode('INVALID_CONFIGURATION'),
	)
})

test('requires run artifacts to remain outside the target repository', async function () {
	const repositoryPath = await mkdtemp(
		path.join(os.tmpdir(), 'artifact-root-repository-'),
	)
	const outsideRoot = await mkdtemp(
		path.join(os.tmpdir(), 'artifact-root-outside-'),
	)

	await assert.rejects(
		assertArtifactRootOutsideRepository(
			repositoryPath,
			path.join(repositoryPath, '.artifacts'),
		),
		hasHarnessCode('ARTIFACT_ROOT_INSIDE_REPOSITORY'),
	)
	await assert.doesNotReject(
		assertArtifactRootOutsideRepository(
			repositoryPath,
			path.join(outsideRoot, 'runs'),
		),
	)
})

test('resolves artifact-root symlinks before enforcing repository isolation', async function () {
	const repositoryPath = await mkdtemp(
		path.join(os.tmpdir(), 'artifact-root-symlink-repository-'),
	)
	const outsideRoot = await mkdtemp(
		path.join(os.tmpdir(), 'artifact-root-symlink-outside-'),
	)
	const linkedRoot = path.join(outsideRoot, 'linked-artifacts')
	await symlink(repositoryPath, linkedRoot)

	await assert.rejects(
		assertArtifactRootOutsideRepository(
			repositoryPath,
			path.join(linkedRoot, 'runs'),
		),
		hasHarnessCode('ARTIFACT_ROOT_INSIDE_REPOSITORY'),
	)
})
