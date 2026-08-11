import assert from 'node:assert/strict'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import {
	getBinaryPatch,
	getChangedFiles,
	resolveCommit,
} from '../../src/git/repository.js'
import { PathPolicy } from '../../src/security/path-policy.js'
import { createTestRepository, runGit } from '../helpers/git.js'

test('collects staged and worker-committed changes against the original base', async function () {
	const repositoryPath = await createTestRepository()
	const baseCommit = await resolveCommit(repositoryPath, 'HEAD')
	const changedPath = path.join(repositoryPath, 'src', 'staged.ts')
	await mkdir(path.dirname(changedPath), { recursive: true })
	await writeFile(changedPath, "export const staged = 'captured'\n", {
		encoding: 'utf8',
		flag: 'wx',
	})
	await runGit(repositoryPath, ['add', 'src/staged.ts'])

	const stagedPatch = await getBinaryPatch(repositoryPath, baseCommit)
	assert.match(stagedPatch, /export const staged = 'captured'/)
	assert.deepEqual(
		await getChangedFiles(repositoryPath, baseCommit),
		['src/staged.ts'],
	)

	await runGit(repositoryPath, ['commit', '-m', 'Worker-created commit'])
	const committedPatch = await getBinaryPatch(repositoryPath, baseCommit)
	assert.match(committedPatch, /export const staged = 'captured'/)
	assert.deepEqual(
		await getChangedFiles(repositoryPath, baseCommit),
		['src/staged.ts'],
	)
})

test('preserves token-shaped patch bytes exactly', async function () {
	const repositoryPath = await createTestRepository()
	const baseCommit = await resolveCommit(repositoryPath, 'HEAD')
	const token = 'sk-1234567890abcdef'
	await writeFile(
		path.join(repositoryPath, 'token.txt'),
		`${token}\n`,
		'utf8',
	)

	const patch = await getBinaryPatch(repositoryPath, baseCommit)
	assert.equal(patch.includes(token), true)
	assert.equal(patch.includes('[REDACTED]'), false)
})

test('preserves multibyte patch content across Git output chunks', async function () {
	const repositoryPath = await createTestRepository()
	const baseCommit = await resolveCommit(repositoryPath, 'HEAD')
	const changedPath = path.join(repositoryPath, 'boundary.txt')
	await writeFile(changedPath, 'é\n', 'utf8')
	const initialPatch = await getBinaryPatch(repositoryPath, baseCommit)
	const initialIndex = initialPatch.indexOf('é')
	const paddingLength = 65_535 - initialIndex
	assert.ok(initialIndex >= 0)
	assert.ok(paddingLength > 0)

	await writeFile(changedPath, `${'a'.repeat(paddingLength)}é\n`, 'utf8')
	const patch = await getBinaryPatch(repositoryPath, baseCommit)

	assert.equal(patch.indexOf('é'), 65_535)
	assert.equal(patch.includes('\uFFFD'), false)
})

test('reports both sides of a rename so prohibited source paths cannot disappear', async function () {
	const repositoryPath = await createTestRepository()
	await writeFile(
		path.join(repositoryPath, 'AGENTS.md'),
		'# Orchestrator instructions\n',
		'utf8',
	)
	await runGit(repositoryPath, ['add', 'AGENTS.md'])
	await runGit(repositoryPath, ['commit', '-m', 'Add protected instructions'])
	const baseCommit = await resolveCommit(repositoryPath, 'HEAD')
	await mkdir(path.join(repositoryPath, 'src'), { recursive: true })
	await rename(
		path.join(repositoryPath, 'AGENTS.md'),
		path.join(repositoryPath, 'src', 'leak.txt'),
	)

	const changedFiles = await getChangedFiles(repositoryPath, baseCommit)
	assert.deepEqual(changedFiles, ['AGENTS.md', 'src/leak.txt'])
	const policy = new PathPolicy(repositoryPath, ['**/*'], [])

	await assert.rejects(
		policy.assertSafeChangedPath('AGENTS.md'),
		(error: unknown) =>
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'SENSITIVE_PATH_DENIED',
	)
})
