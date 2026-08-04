import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
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

test('denies traversal and secret paths', async function () {
	const root = await mkdtemp(path.join(os.tmpdir(), 'path-policy-'))
	await writeFile(path.join(root, '.env'), 'SECRET=value\n')
	const policy = new PathPolicy(root, ['**/*'], [])

	assert.throws(() => policy.assertAllowed('../outside.txt'))
	await assertHarnessCode(policy.resolveForRead('.env'), 'SENSITIVE_PATH_DENIED')
	await assertHarnessCode(policy.resolveForRead('.git'), 'SENSITIVE_PATH_DENIED')
	await assertHarnessCode(policy.resolveForRead('.ssh/id_ed25519'), 'SENSITIVE_PATH_DENIED')
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
