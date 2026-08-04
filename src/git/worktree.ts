import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { HarnessError } from '../lib/errors.js'
import { Logger } from '../lib/logger.js'
import { resolveCommit, runGit } from './repository.js'

export type Worktree = {
	runId: string
	path: string
	parentPath: string
	baseCommit: string
	cleanup(): Promise<void>
}

export class WorktreeManager {
	private readonly logger: Logger

	constructor(logger: Logger) {
		this.logger = logger
	}

	async create(repositoryPath: string, baseRef: string): Promise<Worktree> {
		const runId = randomUUID()
		const baseCommit = await resolveCommit(repositoryPath, baseRef)
		const parentPath = await mkdtemp(
			path.join(os.tmpdir(), 'agent-harness-os-'),
		)
		const worktreePath = path.join(parentPath, 'worktree')
		await mkdir(worktreePath, { recursive: true })

		const result = await runGit(repositoryPath, [
			'worktree',
			'add',
			'--detach',
			worktreePath,
			baseCommit,
		])

		if (result.exitCode !== 0) {
			await rm(parentPath, { recursive: true, force: true })
			throw new HarnessError(
				'WORKTREE_CREATE_FAILED',
				'Unable to create detached Git worktree',
				{ stderr: result.stderr },
			)
		}

		this.logger.info('Created worker worktree', {
			runId,
			baseCommit,
		})

		return {
			runId,
			path: worktreePath,
			parentPath,
			baseCommit,
			cleanup: async () => {
				const removal = await runGit(repositoryPath, [
					'worktree',
					'remove',
					'--force',
					worktreePath,
				])

				if (removal.exitCode !== 0) {
					this.logger.warn('Git worktree removal reported an error', {
						runId,
						stderr: removal.stderr,
					})
				}

				await rm(parentPath, { recursive: true, force: true })
			},
		}
}
