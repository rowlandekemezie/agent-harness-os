import assert from 'node:assert/strict'
import { link, mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PathPolicy } from '../../src/security/path-policy.js'

async function assertHarnessCode(
	promise: Promise<unknown>,
	code: string,
): Promise<void> {
	await assert.rejects(promise, error => {
		return error instanceof Error && 'code' in error && error.code === code
	})
}


test('fails closed when no explicit allowlist is provided', function () {
	assert.throws(
		() => new PathPolicy('/tmp/repository', [], []),
		(error: unknown) =>
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'EMPTY_PATH_ALLOWLIST',
	)
})

test('denies traversal and secret paths', async function () {
	const root = await mkdtemp(path.join(os.tmpdir(), 'path-policy-'))
	await writeFile(path.join(root, '.env'), 'SECRET=value\n')
	const policy = new PathPolicy(root, ['**/*'], [])

	assert.throws(() => policy.assertAllowed('../outside.txt'))
	await assertHarnessCode(policy.resolveForRead('.env'), 'SENSITIVE_PATH_DENIED')
	await assertHarnessCode(policy.resolveForRead('.git'), 'SENSITIVE_PATH_DENIED')
	await assertHarnessCode(policy.resolveForRead('.ssh/id_ed25519'), 'SENSITIVE_PATH_DENIED')
	await assertHarnessCode(policy.resolveForRead('AGENTS.md'), 'SENSITIVE_PATH_DENIED')
	await assertHarnessCode(
		policy.resolveForWrite('.github/workflows/ci.yml'),
		'CONTROL_PATH_WRITE_DENIED',
	)
	await writeFile(path.join(root, 'package.json'), '{"name":"fixture"}\n')
	assert.equal(
		await policy.resolveForRead('package.json'),
		path.join(root, 'package.json'),
	)
	await assertHarnessCode(
		policy.resolveForWrite('package.json'),
		'CONTROL_PATH_WRITE_DENIED',
	)
	await assertHarnessCode(
		policy.resolveForRead('terraform.tfstate'),
		'SENSITIVE_PATH_DENIED',
	)
})

test('denies writes through a symlink escaping the repository', async function () {
	const root = await mkdtemp(path.join(os.tmpdir(), 'path-policy-root-'))
	const outside = await mkdtemp(path.join(os.tmpdir(), 'path-policy-outside-'))
	await mkdir(path.join(outside, 'nested'))
	await symlink(path.join(outside, 'nested'), path.join(root, 'linked'))
	const policy = new PathPolicy(root, ['**/*'], [])

	await assertHarnessCode(
		policy.resolveForWrite('linked/escape.txt'),
		'PATH_TRAVERSAL_DENIED',
	)
})

test('denies reads and writes through hard links', async function () {
	const root = await mkdtemp(path.join(os.tmpdir(), 'path-policy-hardlink-root-'))
	const outside = await mkdtemp(path.join(os.tmpdir(), 'path-policy-hardlink-outside-'))
	const outsideFile = path.join(outside, 'secret.txt')
	await writeFile(outsideFile, 'secret\n', 'utf8')
	await link(outsideFile, path.join(root, 'linked.txt'))
	const policy = new PathPolicy(root, ['**/*'], [])

	await assertHarnessCode(policy.resolveForRead('linked.txt'), 'HARD_LINK_DENIED')
	await assertHarnessCode(policy.resolveForWrite('linked.txt'), 'HARD_LINK_DENIED')
})

test('rejects symbolic links and non-regular files in worker changes', async function () {
	const root = await mkdtemp(path.join(os.tmpdir(), 'path-policy-changed-link-'))
	await writeFile(path.join(root, 'target.txt'), 'target\n', 'utf8')
	await symlink('target.txt', path.join(root, 'changed-link.txt'))
	const policy = new PathPolicy(root, ['**/*'], [])

	await assertHarnessCode(
		policy.assertSafeChangedPath('changed-link.txt'),
		'CHANGED_SYMLINK_DENIED',
	)
})


test('denies a symlink whose in-repository target is hard-linked outside', async function () {
	const root = await mkdtemp(path.join(os.tmpdir(), 'path-policy-link-chain-root-'))
	const outside = await mkdtemp(path.join(os.tmpdir(), 'path-policy-link-chain-outside-'))
	const outsideFile = path.join(outside, 'secret.txt')
	await writeFile(outsideFile, 'secret\n', 'utf8')
	await link(outsideFile, path.join(root, 'target.txt'))
	await symlink('target.txt', path.join(root, 'linked.txt'))
	const policy = new PathPolicy(root, ['**/*'], [])

	await assertHarnessCode(policy.resolveForRead('linked.txt'), 'HARD_LINK_DENIED')
})
