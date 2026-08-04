import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { runGit } from '../../src/git/repository.js'
import { WorktreeManager } from '../../src/git/worktree.js'
import { Logger } from '../../src/lib/logger.js'
import { createTestRepository } from '../helpers/git.js'

test('cleans up a worktree even when its Git registration is locked', async function () {
	const repositoryPath = await createTestRepository()
	const manager = new WorktreeManager(new Logger('worktree-test', 'error'))
	const worktree = await manager.create(repositoryPath, 'HEAD')
	const lockResult = await runGit(repositoryPath, [
		'worktree',
		'lock',
		worktree.path,
	])
	assert.equal(lockResult.exitCode, 0)

	await worktree.cleanup()

	await assert.rejects(access(worktree.parentPath))
	const listResult = await runGit(repositoryPath, [
		'worktree',
		'list',
		'--porcelain',
	])
	assert.equal(listResult.exitCode, 0)
	assert.equal(
		listResult.stdout.includes(path.resolve(worktree.path)),
		false,
	)
})
