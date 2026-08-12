import { realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { HarnessError } from '../lib/errors.js'
import { createSanitizedEnvironment, runProcess } from '../lib/process.js'

const gitOutputLimit = 20_000_000

const prohibitedGitConfigPatterns: Array<RegExp> = [
	/^core\.worktree$/i,
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
	const scopes = ['--local', '--worktree']
	const prohibitedKeys = new Set<string>()

	for (const scope of scopes) {
		const result = await runGit(repositoryPath, [
			'config',
			scope,
			'--includes',
			'--name-only',
			'--null',
			'--list',
		])

		if (result.exitCode !== 0) {
			throw new HarnessError(
				'GIT_CONFIG_INSPECTION_FAILED',
				`Unable to inspect repository Git configuration for scope ${scope}`,
				{ stderr: result.stderr },
			)
		}

		for (const key of result.stdout
			.split('\0')
			.map(value => value.trim())
			.filter(value => value.length > 0)) {
			if (prohibitedGitConfigPatterns.some(pattern => pattern.test(key))) {
				prohibitedKeys.add(key)
			}
		}
	}

	if (prohibitedKeys.size > 0) {
		throw new HarnessError(
			'UNSAFE_GIT_CONFIGURATION',
			'Repository-local Git configuration can execute external programs',
			{ prohibitedKeys: [...prohibitedKeys].sort() },
		)
	}
}

export async function resolveRepositoryRoot(
	repositoryPath: string,
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted()
	const requestedPath = path.resolve(repositoryPath)
	let resolvedPath: string

	try {
		resolvedPath = await realpath(requestedPath)
		const pathStats = await stat(resolvedPath)

		if (!pathStats.isDirectory()) {
			throw new HarnessError(
				'NOT_A_DIRECTORY',
				`Repository path must be a directory: ${requestedPath}`,
			)
		}
	} catch (error) {
		if (error instanceof HarnessError) {
			throw error
		}

		throw new HarnessError(
			'REPOSITORY_PATH_UNAVAILABLE',
			`Repository path cannot be resolved: ${requestedPath}`,
			{ cause: error instanceof Error ? error.message : String(error) },
		)
	}
	const result = await runGitBounded(resolvedPath, [
		'rev-parse',
		'--show-toplevel',
	], gitOutputLimit, undefined, false, signal)
	signal?.throwIfAborted()

	if (result.exitCode !== 0) {
		throw new HarnessError(
			'NOT_A_GIT_REPOSITORY',
			`Path is not inside a Git repository: ${resolvedPath}`,
			{ stderr: result.stderr },
		)
	}

	const repositoryRoot = await realpath(result.stdout.trim())
	const relative = path.relative(repositoryRoot, resolvedPath)

	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new HarnessError(
			'REPOSITORY_ROOT_MISMATCH',
			'Git resolved a worktree root that does not contain the requested path',
			{ requestedPath: resolvedPath, repositoryRoot },
		)
	}

	return repositoryRoot
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

export type GitBlob = {
	contents: string
	objectId: string
}

export async function readRegularFileAtCommit(
	repositoryPath: string,
	commit: string,
	relativePath: string,
	maxBytes: number,
): Promise<GitBlob | null> {
	if (!/^[a-f0-9]{40,64}$/i.test(commit)) {
		throw new HarnessError('INVALID_BASE_REF', 'Policy base commit is invalid')
	}
	if (!isSafeGitRelativePath(relativePath)) {
		throw new HarnessError('INVALID_POLICY_PATH', 'Policy path must be repository-relative')
	}

	const tree = await runGitBounded(repositoryPath, [
		'ls-tree',
		'-z',
		commit,
		'--',
		relativePath,
	], 8_192, undefined, true)
	if (tree.exitCode !== 0 || tree.outputTruncated || tree.invalidUtf8 === true) {
		throw new HarnessError(
			'POLICY_READ_FAILED',
			'Repository policy metadata could not be read from the base commit',
			{ stderr: tree.stderr },
		)
	}
	if (tree.stdout === '') {
		return null
	}

	const match = /^([0-9]{6}) (blob) ([a-f0-9]{40,64})\t([^\0]+)\0$/i.exec(
		tree.stdout,
	)
	if (
		match === null ||
		match[1] !== '100644' ||
		match[4] !== relativePath
	) {
		throw new HarnessError(
			'INVALID_POLICY_FILE',
			'Repository policy must be one non-executable regular Git file',
		)
	}

	const objectId = match[3]!
	const blob = await runGitBounded(
		repositoryPath,
		['cat-file', 'blob', objectId],
		maxBytes,
		undefined,
		true,
	)
	if (blob.exitCode !== 0 || blob.outputTruncated || blob.invalidUtf8 === true) {
		throw new HarnessError(
			blob.outputTruncated
				? 'POLICY_FILE_TOO_LARGE'
				: blob.invalidUtf8 === true
					? 'INVALID_POLICY_ENCODING'
					: 'POLICY_READ_FAILED',
			blob.outputTruncated
				? `Repository policy exceeds the ${maxBytes}-byte limit`
				: blob.invalidUtf8 === true
					? 'Repository policy must contain valid UTF-8'
					: 'Repository policy content could not be read from the base commit',
			{ stderr: blob.stderr },
		)
	}

	return { contents: blob.stdout, objectId }
}

export function isSafeGitRelativePath(relativePath: string): boolean {
	return relativePath.length > 0 &&
		!path.posix.isAbsolute(relativePath) &&
		!path.win32.isAbsolute(relativePath) &&
		!relativePath.includes('\0') &&
		!relativePath.includes('\\') &&
		path.posix.normalize(relativePath) === relativePath &&
		!relativePath.startsWith('../')
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
	baseCommit: string,
): Promise<Array<string>> {
	await markUntrackedFilesIntentToAdd(worktreePath)
	const result = await runGit(worktreePath, [
		'diff',
		'--name-only',
		'-z',
		'--no-ext-diff',
		'--no-renames',
		baseCommit,
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

export async function getBinaryPatch(
	worktreePath: string,
	baseCommit: string,
): Promise<string> {
	await markUntrackedFilesIntentToAdd(worktreePath)
	const result = await runGitBounded(
		worktreePath,
		[
			'diff',
			'--binary',
			'--no-ext-diff',
			'--no-renames',
			'--full-index',
			'--no-textconv',
			baseCommit,
			'--',
		],
		gitOutputLimit,
		undefined,
		true,
	)

	if (
		result.exitCode !== 0 ||
		result.outputTruncated ||
		result.invalidUtf8 === true
	) {
		throw new HarnessError(
			result.outputTruncated
				? 'PATCH_TOO_LARGE'
				: result.invalidUtf8 === true
					? 'PATCH_INVALID_ENCODING'
					: 'GIT_DIFF_FAILED',
			result.outputTruncated
				? 'Worker patch exceeded the 20 MB safety limit'
				: result.invalidUtf8 === true
					? 'Worker patch must contain valid UTF-8'
					: 'Unable to create worker patch',
			{ stderr: result.stderr },
		)
	}

	return result.stdout
}

async function markUntrackedFilesIntentToAdd(
	worktreePath: string,
): Promise<void> {
	const intentToAdd = await runGit(worktreePath, ['add', '-N', '--', '.'])

	if (intentToAdd.exitCode !== 0) {
		throw new HarnessError(
			'GIT_INTENT_TO_ADD_FAILED',
			'Unable to include untracked files in the worker patch',
			{ stderr: intentToAdd.stderr },
		)
	}
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
	return await runGitBounded(cwd, args, gitOutputLimit, input)
}

async function runGitBounded(
	cwd: string,
	args: Array<string>,
	maxOutputBytes: number,
	input?: string | Buffer,
	requireValidUtf8 = false,
	signal?: AbortSignal,
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
		maxOutputBytes,
		requireValidUtf8,
		redactStdout: false,
		...(signal === undefined ? {} : { signal }),
		...(input === undefined ? {} : { input }),
	})
}
