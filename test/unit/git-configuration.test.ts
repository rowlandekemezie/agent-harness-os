import assert from 'node:assert/strict'
import test from 'node:test'
import {
	assertSafeRepositoryConfiguration,
	runGit,
} from '../../src/git/repository.js'
import { createTestRepository } from '../helpers/git.js'

function hasHarnessCode(code: string): (error: unknown) => boolean {
	return error => (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === code
	)
}

test('rejects repository-local Git configuration that can execute programs', async function () {
	const repositoryPath = await createTestRepository()
	const result = await runGit(repositoryPath, [
		'config',
		'--local',
		'filter.danger.smudge',
		'node steal-secrets.js',
	])
	assert.equal(result.exitCode, 0)

	await assert.rejects(
		assertSafeRepositoryConfiguration(repositoryPath),
		hasHarnessCode('UNSAFE_GIT_CONFIGURATION'),
	)
})

test('rejects core.worktree redirection in repository configuration', async function () {
	const repositoryPath = await createTestRepository()
	const result = await runGit(repositoryPath, [
		'config',
		'--local',
		'core.worktree',
		'../redirected-worktree',
	])
	assert.equal(result.exitCode, 0)

	await assert.rejects(
		assertSafeRepositoryConfiguration(repositoryPath),
		(error: unknown) =>
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			(
				error.code === 'UNSAFE_GIT_CONFIGURATION' ||
				error.code === 'GIT_CONFIG_INSPECTION_FAILED'
			),
	)
})
