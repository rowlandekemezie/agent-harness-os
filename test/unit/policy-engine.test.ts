import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { loadConfig } from '../../src/config.js'
import type { WorkerTask } from '../../src/domain/types.js'
import {
	isResolvedPolicy,
	repositoryPolicyPath,
	resolveTaskPolicy,
} from '../../src/policy/engine.js'
import { isSafeGitRelativePath } from '../../src/git/repository.js'
import { createTestRepository, runGit } from '../helpers/git.js'

const execFileAsync = promisify(execFile)

function createTask(repositoryPath: string): WorkerTask {
	return {
		objective: 'Implement a bounded change.',
		repositoryPath,
		mode: 'implementation',
		allowedPaths: ['src/**'],
		prohibitedPaths: ['task-private/**'],
		acceptanceCriteria: [],
		requiredCommands: [],
		baseRef: 'HEAD',
		maxIterations: 10,
		timeoutSeconds: 240,
		allowNetwork: true,
		routing: {
			preferredWorkerId: null,
			requiredCapabilities: ['tool-calling'],
			strategy: 'balanced',
			maxCostTier: 'high',
			maxLatencyTier: 'slow',
			allowFallback: true,
			maxAttempts: 5,
		},
	}
}

test('composes organization, repository, and task policy restrictively', async function () {
	const repositoryPath = await createTestRepository()
	const organizationRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-policy-'))
	const organizationPolicyPath = path.join(organizationRoot, 'organization.json')
	await writeFile(organizationPolicyPath, JSON.stringify({
		schemaVersion: 1,
		maxChangedFiles: 5,
		maxIterations: 12,
		maxTaskSeconds: 120,
		allowNetwork: false,
		prohibitedPaths: ['infra/**'],
		routing: {
			requiredCapabilities: ['private'],
			maxCostTier: 'medium',
			allowFallback: false,
			maxAttempts: 3,
		},
	}))
	await mkdir(path.join(repositoryPath, '.agent-os'))
	await writeFile(path.join(repositoryPath, repositoryPolicyPath), JSON.stringify({
		schemaVersion: 1,
		maxChangedFiles: 3,
		maxIterations: 8,
		maxTaskSeconds: 300,
		allowNetwork: true,
		prohibitedPaths: ['migrations/**'],
		routing: {
			requiredCapabilities: ['long-context'],
			maxCostTier: 'high',
			maxLatencyTier: 'fast',
			allowFallback: true,
			maxAttempts: 4,
		},
	}))
	await runGit(repositoryPath, ['add', repositoryPolicyPath])
	await runGit(repositoryPath, ['commit', '-m', 'Add repository policy'])
	const baseCommit = await runGit(repositoryPath, ['rev-parse', 'HEAD'])

	const config = loadConfig({
		AGENT_OS_ORGANIZATION_POLICY_PATH: organizationPolicyPath,
		AGENT_HARNESS_MAX_CHANGED_FILES: '20',
	})
	const resolved = await resolveTaskPolicy(
		config,
		repositoryPath,
		baseCommit,
		createTask(repositoryPath),
	)

	assert.equal(resolved.policy.maxChangedFiles, 3)
	assert.equal(resolved.maxIterations, 8)
	assert.equal(resolved.timeoutSeconds, 120)
	assert.equal(resolved.allowNetwork, false)
	assert.deepEqual(resolved.prohibitedPaths, [
		'task-private/**',
		'infra/**',
		'migrations/**',
	])
	assert.deepEqual(resolved.routing, {
		preferredWorkerId: null,
		requiredCapabilities: ['tool-calling', 'private', 'long-context'],
		strategy: 'balanced',
		maxCostTier: 'medium',
		maxLatencyTier: 'fast',
		allowFallback: false,
		maxAttempts: 3,
	})
	assert.deepEqual(resolved.policy.sources.map(source => source.scope), [
		'organization',
		'repository',
	])
	assert.equal(isResolvedPolicy(resolved.policy), true)

	await writeFile(
		path.join(repositoryPath, repositoryPolicyPath),
		'{"schemaVersion":1,"maxChangedFiles":99}',
	)
	const fromBaseCommit = await resolveTaskPolicy(
		config,
		repositoryPath,
		baseCommit,
		createTask(repositoryPath),
	)
	assert.equal(fromBaseCommit.policy.maxChangedFiles, 3)
	assert.equal(fromBaseCommit.policy.digest, resolved.policy.digest)
})

test('rejects unsafe organization and repository policy files', async function () {
	const repositoryPath = await createTestRepository()
	const policyRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-policy-invalid-'))
	const policyTarget = path.join(policyRoot, 'target.json')
	const policyLink = path.join(policyRoot, 'policy.json')
	await writeFile(policyTarget, '{"schemaVersion":1}')
	await symlink(policyTarget, policyLink)
	const task = createTask(repositoryPath)
	const baseCommit = await runGit(repositoryPath, ['rev-parse', 'HEAD'])

	await assert.rejects(
		resolveTaskPolicy(
			loadConfig({ AGENT_OS_ORGANIZATION_POLICY_PATH: policyLink }),
			repositoryPath,
			baseCommit,
			task,
		),
		hasHarnessCode('POLICY_READ_FAILED'),
	)

	await mkdir(path.join(repositoryPath, '.agent-os'))
	await writeFile(
		path.join(repositoryPath, repositoryPolicyPath),
		'{"schemaVersion":1}',
	)
	await chmod(path.join(repositoryPath, repositoryPolicyPath), 0o755)
	await runGit(repositoryPath, ['add', repositoryPolicyPath])
	await runGit(repositoryPath, ['commit', '-m', 'Add executable policy'])
	const executableCommit = await runGit(repositoryPath, ['rev-parse', 'HEAD'])

	await assert.rejects(
		resolveTaskPolicy(
			loadConfig({}),
			repositoryPath,
			executableCommit,
			task,
		),
		hasHarnessCode('INVALID_POLICY_FILE'),
	)

	const invalidUtf8 = Buffer.concat([
		Buffer.from('{"schemaVersion":1,"prohibitedPaths":["'),
		Buffer.from([0xc3, 0x28]),
		Buffer.from('"]}'),
	])
	await writeFile(path.join(repositoryPath, repositoryPolicyPath), invalidUtf8)
	await chmod(path.join(repositoryPath, repositoryPolicyPath), 0o644)
	await runGit(repositoryPath, ['add', repositoryPolicyPath])
	await runGit(repositoryPath, ['commit', '-m', 'Add invalid UTF-8 policy'])
	const invalidUtf8Commit = await runGit(repositoryPath, ['rev-parse', 'HEAD'])

	await assert.rejects(
		resolveTaskPolicy(
			loadConfig({}),
			repositoryPath,
			invalidUtf8Commit,
			task,
		),
		hasHarnessCode('INVALID_POLICY_ENCODING'),
	)

	const invalidOrganizationPolicy = path.join(policyRoot, 'invalid-utf8.json')
	await writeFile(invalidOrganizationPolicy, invalidUtf8)
	await assert.rejects(
		resolveTaskPolicy(
			loadConfig({
				AGENT_OS_ORGANIZATION_POLICY_PATH: invalidOrganizationPolicy,
			}),
			repositoryPath,
			baseCommit,
			task,
		),
		hasHarnessCode('INVALID_POLICY_ENCODING'),
	)
})

test('rejects blocking and oversized organization policy inputs', async function (context) {
	if (process.platform === 'win32') {
		context.skip('POSIX FIFO semantics are unavailable on Windows')
		return
	}

	const repositoryPath = await createTestRepository()
	const policyRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-policy-bounded-'))
	const fifoPath = path.join(policyRoot, 'policy.fifo')
	await execFileAsync('mkfifo', [fifoPath])
	const task = createTask(repositoryPath)
	const baseCommit = await runGit(repositoryPath, ['rev-parse', 'HEAD'])

	await assert.rejects(
		resolveTaskPolicy(
			loadConfig({ AGENT_OS_ORGANIZATION_POLICY_PATH: fifoPath }),
			repositoryPath,
			baseCommit,
			task,
		),
		hasHarnessCode('INVALID_POLICY_FILE'),
	)

	const oversizedPath = path.join(policyRoot, 'oversized.json')
	await writeFile(oversizedPath, Buffer.alloc(65_537, 0x20))
	await assert.rejects(
		resolveTaskPolicy(
			loadConfig({ AGENT_OS_ORGANIZATION_POLICY_PATH: oversizedPath }),
			repositoryPath,
			baseCommit,
			task,
		),
		hasHarnessCode('POLICY_FILE_TOO_LARGE'),
	)
})

test('treats repository policy locations as Git paths on every host', function () {
	assert.notEqual(path.win32.normalize(repositoryPolicyPath), repositoryPolicyPath)
	assert.equal(isSafeGitRelativePath(repositoryPolicyPath), true)
	assert.equal(isSafeGitRelativePath('../policy.json'), false)
	assert.equal(isSafeGitRelativePath('C:\\policy.json'), false)
	assert.equal(isSafeGitRelativePath('.agent-os\\policy.json'), false)
	assert.equal(isSafeGitRelativePath('.agent-os/policy.json\0hidden'), false)
})

test('preserves exact repository policy bytes and source digest', async function () {
	const repositoryPath = await createTestRepository()
	await mkdir(path.join(repositoryPath, '.agent-os'))
	const contents = '{"schemaVersion":1,"prohibitedPaths":["sk-1234567890abcdef"]}'
	await writeFile(path.join(repositoryPath, repositoryPolicyPath), contents)
	await runGit(repositoryPath, ['add', repositoryPolicyPath])
	await runGit(repositoryPath, ['commit', '-m', 'Add token-shaped policy'])
	const baseCommit = await runGit(repositoryPath, ['rev-parse', 'HEAD'])

	const resolved = await resolveTaskPolicy(
		loadConfig({}),
		repositoryPath,
		baseCommit,
		createTask(repositoryPath),
	)
	assert.equal(
		resolved.prohibitedPaths.includes('sk-1234567890abcdef'),
		true,
	)
	assert.equal(
		resolved.policy.sources[0]?.sha256,
		createHash('sha256').update(contents).digest('hex'),
	)
})

function hasHarnessCode(code: string): (error: unknown) => boolean {
	return error => typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === code
}
