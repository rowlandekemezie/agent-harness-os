import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runProcess } from '../../src/lib/process.js'

export async function createTestRepository(): Promise<string> {
	const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-repo-'))
	await runGit(repositoryPath, ['init', '--initial-branch=main'])
	await runGit(repositoryPath, ['config', 'user.name', 'Agent Harness Tests'])
	await runGit(repositoryPath, ['config', 'user.email', 'tests@example.invalid'])
	await writeFile(path.join(repositoryPath, 'README.md'), '# Test repository\n')
	await runGit(repositoryPath, ['add', '.'])
	await runGit(repositoryPath, ['commit', '-m', 'Initial commit'])
	return repositoryPath
}

export async function runGit(
	repositoryPath: string,
	args: Array<string>,
): Promise<string> {
	const result = await runProcess('git', args, {
		cwd: repositoryPath,
		timeoutMs: 30_000,
		maxOutputBytes: 100_000,
	})

	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
	}

	return result.stdout.trim()
}
