import os from 'node:os'
import path from 'node:path'
import { HarnessError } from '../lib/errors.js'
import { createSanitizedEnvironment, runProcess } from '../lib/process.js'

const gitOutputLimit = 20_000_000

const prohibitedGitConfigPatterns: Array<RegExp> = [
	/^core\.hookspath$/i,
	/^core\.fsmonitor$/i,
	/^core\.attributesfile$/i,
	/^filter\..+\.(?:clean|smudge|process|required)$/i,
	/^diff\..+\.(?:command|textconv|cachetextconv)$/i,
	/^merge\..+\.driver$/i,
]

export async function assertSafeRepositoryConfiguration(
	repositoryPath: string,
): Promise<void> {
	const result = await runGit(repositoryPath, [
		'config',
		'--local',
		'--includes',
		'--name-only',
		'--null',
		'--list',
	])

	if (result.exitCode !== 0) {
		throw new HarnessError(
			'GIT_CONFIG_INSPECTION_FAILED',
			'Unable to inspect repository-local Git configuration',
			{ stderr: result.stderr },
		)
	}

	const prohibitedKeys = result.stdout
		.split('\0')
		.map(value => value.trim())
		.filter(value => value.length > 0)
		.filter(key => prohibitedGitConfigPatterns.some(pattern => pattern.test(key)))

	if (prohibitedKeys.length > 0) {
		throw new HarnessError(
			'UNSAFE_GIT_CONFIGURATION',
			'Repository-local Git configuration can execute external programs',
			{ prohibitedKeys },
		)
	}
}

export async function resolveRepositoryRoot(
	repositoryPath: string,
): Promise<string> {
	const resolvedPath = path.resolve(repositoryPath)
	const result = await runGit(resolvedPath, [
		'rev-parse',
		'--show-toplevel',
	])

	if (result.exitCode !== 0) {
		throw new HarnessError(
			'NOT_A_GIT_REPOSITORY',
			`Path is not inside a Git repository: ${resolvedPath}`,
			{ stderr: result.stderr },
		)
	}

	return result.stdout.trim()
}

export async function resolveCommit(
	repositoryPath: string,
	ref: string,
): Promise<string> {
	const result = await runGit(repositoryPath, [
		'rev-parse',
		'--verify',
		'--end-of-options',
		`${ref}^{commit}`,
	])

	if (result.exitCode !== 0) {
		throw new HarnessError(
			'INVALID_BASE_REF',
			`Git ref does not resolve to a commit: ${ref}`,
			{ stderr: result.stderr },
		)
	}

	return result.stdout.trim()
}

export async function isWorkingTreeClean(
	repositoryPath: string,
): Promise<boolean> {
	const result = await runGit(repositoryPath, [
		'status',
		'--porcelain=v1',
		'-z',
		'--untracked-files=normal',
	])

	if (result.exitCode !== 0) {
		throw new HarnessError(
			'GIT_STATUS_FAILED',
			'Unable to inspect Git working tree status',
			{ stderr: result.stderr },
		)
	}

	return result.stdout.trim() === ''
}

export async function getChangedFiles(
	worktreePath: string,
): Promise<Array<string>> {
	const result = await runGit(worktreePath, [
		'diff',
		'--name-only',
		'-z',
		'--no-ext-diff',
		'--',
	])

	if (result.exitCode !== 0 || result.outputTruncated) {
		throw new HarnessError(
			'GIT_DIFF_FAILED',
			result.outputTruncated
				? 'Changed-file output exceeded the 20 MB safety limit'
				: 'Unable to list changed files',
			{ stderr: result.stderr },
		)
	}

	return result.stdout
		.split('\0')
		.filter(value => value.length > 0)
}

export async function getBinaryPatch(worktreePath: string): Promise<string> {
	const intentToAdd = await runGit(worktreePath, ['add', '-N', '--', '.'])

	if (intentToAdd.exitCode !== 0) {
		throw new HarnessError(
			'GIT_INTENT_TO_ADD_FAILED',
			'Unable to include untracked files in the worker patch',
			{ stderr: intentToAdd.stderr },
		)
	}

	const result = await runGit(worktreePath, [
		'diff',
		'--binary',
		'--no-ext-diff',
		'--full-index',
		'--no-textconv',
		'--',
	])

	if (result.exitCode !== 0 || result.outputTruncated) {
		throw new HarnessError(
			result.outputTruncated ? 'PATCH_TOO_LARGE' : 'GIT_DIFF_FAILED',
			result.outputTruncated
				? 'Worker patch exceeded the 20 MB safety limit'
				: 'Unable to create worker patch',
			{ stderr: result.stderr },
		)
	}

	return result.stdout
}

export async function checkPatch(
	repositoryPath: string,
	patch: string | Buffer,
): Promise<void> {
	const result = await runGit(repositoryPath, [
		'apply',
		'--check',
		'--whitespace=error-all',
		'-',
	], patch)

	if (result.exitCode !== 0) {
		throw new HarnessError(
			'PATCH_CHECK_FAILED',
			'Worker patch cannot be cleanly applied',
			{ stderr: result.stderr },
		)
	}
}

export async function applyPatch(
	repositoryPath: string,
	patch: string | Buffer,
): Promise<void> {
	const result = await runGit(repositoryPath, [
		'apply',
		'--whitespace=error-all',
		'-',
	], patch)

	if (result.exitCode !== 0) {
		throw new HarnessError(
			'PATCH_APPLY_FAILED',
			'Unable to apply worker patch',
			{ stderr: result.stderr },
		)
	}
}

export async function runGit(
	cwd: string,
	args: Array<string>,
	input?: string | Buffer,
): Promise<Awaited<ReturnType<typeof runProcess>>> {
	const safeArgs = [
		'-c',
		`core.hooksPath=${os.devNull}`,
		'-c',
		'core.fsmonitor=false',
		'-c',
		'core.pager=cat',
		...args,
	]
	const environment = createSanitizedEnvironment({
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_CONFIG_GLOBAL: os.devNull,
		GIT_TERMINAL_PROMPT: '0',
		GIT_PAGER: 'cat',
		PAGER: 'cat',
	})

	return await runProcess('git', safeArgs, {
		cwd,
		environment,
		timeoutMs: 120_000,
		maxOutputBytes: gitOutputLimit,
		...(input === undefined ? {} : { input }),
	})
}
