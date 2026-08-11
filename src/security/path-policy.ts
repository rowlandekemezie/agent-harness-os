import { lstat, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { HarnessError } from '../lib/errors.js'
import {
	createGlobMatchBudget,
	matchesAnyGlob,
	normalizePath,
} from '../lib/glob.js'
import type { GlobMatchBudget } from '../lib/glob.js'

export const defaultProhibitedPaths = [
	'.git',
	'.git/**',
	'**/.git',
	'**/.git/**',
	'.env',
	'.env.*',
	'**/.env',
	'**/.env.*',
	'**/*.pem',
	'**/*.key',
	'**/id_rsa*',
	'**/.ssh',
	'**/.ssh/**',
	'**/.aws',
	'**/.aws/**',
	'**/.kube',
	'**/.kube/**',
	'**/*.p12',
	'**/*.pfx',
	'**/*.jks',
	'**/*.keystore',
	'**/.npmrc',
	'**/.pypirc',
	'**/.netrc',
	'**/credentials*',
	'**/.envrc',
	'**/.direnv',
	'**/.direnv/**',
	'**/.git-credentials',
	'**/.docker/config.json',
	'**/.terraform',
	'**/.terraform/**',
	'**/*.tfstate',
	'**/*.tfstate.*',
	'AGENTS.md',
	'**/AGENTS.md',
	'CLAUDE.md',
	'**/CLAUDE.md',
	'.codex',
	'.codex/**',
	'**/.codex',
	'**/.codex/**',
	'.claude',
	'.claude/**',
	'**/.claude',
	'**/.claude/**',
	'.agent-harness',
	'.agent-harness/**',
	'**/.agent-harness',
	'**/.agent-harness/**',
	'.agent-os',
	'.agent-os/**',
	'**/.agent-os',
	'**/.agent-os/**',
]

export const defaultWriteProhibitedPaths = [
	'.gitattributes',
	'**/.gitattributes',
	'.gitmodules',
	'**/.gitmodules',
	'.github',
	'.github/**',
	'**/.github',
	'**/.github/**',
	'.gitlab',
	'.gitlab/**',
	'**/.gitlab',
	'**/.gitlab/**',
	'.gitlab-ci.yml',
	'**/.gitlab-ci.yml',
	'.circleci',
	'.circleci/**',
	'**/.circleci',
	'**/.circleci/**',
	'.buildkite',
	'.buildkite/**',
	'**/.buildkite',
	'**/.buildkite/**',
	'.travis.yml',
	'**/.travis.yml',
	'azure-pipelines.yml',
	'**/azure-pipelines.yml',
	'bitbucket-pipelines.yml',
	'**/bitbucket-pipelines.yml',
	'Jenkinsfile',
	'Jenkinsfile.*',
	'**/Jenkinsfile',
	'**/Jenkinsfile.*',
	'.devcontainer',
	'.devcontainer/**',
	'**/.devcontainer',
	'**/.devcontainer/**',
	'.vscode',
	'.vscode/**',
	'**/.vscode',
	'**/.vscode/**',
	'.idea',
	'.idea/**',
	'**/.idea',
	'**/.idea/**',
	'.mcp.json',
	'**/.mcp.json',
	'mcp.json',
	'**/mcp.json',
	'Dockerfile',
	'Dockerfile.*',
	'**/Dockerfile',
	'**/Dockerfile.*',
	'docker-compose.yml',
	'docker-compose.yaml',
	'docker-compose.*.yml',
	'docker-compose.*.yaml',
	'**/docker-compose.yml',
	'**/docker-compose.yaml',
	'**/docker-compose.*.yml',
	'**/docker-compose.*.yaml',
	'compose.yml',
	'compose.yaml',
	'compose.*.yml',
	'compose.*.yaml',
	'**/compose.yml',
	'**/compose.yaml',
	'**/compose.*.yml',
	'**/compose.*.yaml',
	'package.json',
	'**/package.json',
	'package-lock.json',
	'**/package-lock.json',
	'pnpm-lock.yaml',
	'**/pnpm-lock.yaml',
	'pnpm-workspace.yaml',
	'yarn.lock',
	'**/yarn.lock',
	'bun.lock',
	'bun.lockb',
	'**/bun.lock',
	'**/bun.lockb',
	'pyproject.toml',
	'**/pyproject.toml',
	'requirements.txt',
	'requirements-*.txt',
	'**/requirements.txt',
	'**/requirements-*.txt',
	'Pipfile',
	'**/Pipfile',
	'Pipfile.lock',
	'**/Pipfile.lock',
	'poetry.lock',
	'**/poetry.lock',
	'uv.lock',
	'**/uv.lock',
	'Gemfile',
	'**/Gemfile',
	'Gemfile.lock',
	'**/Gemfile.lock',
	'go.mod',
	'**/go.mod',
	'go.sum',
	'**/go.sum',
	'Cargo.toml',
	'**/Cargo.toml',
	'Cargo.lock',
	'**/Cargo.lock',
	'composer.json',
	'**/composer.json',
	'composer.lock',
	'**/composer.lock',
]

export class PathPolicy {
	readonly rootPath: string
	readonly allowedPaths: Array<string>
	readonly prohibitedPaths: Array<string>
	readonly writeProhibitedPaths: Array<string>
	private resolvedRootPath: string | null = null

	constructor(
		rootPath: string,
		allowedPaths: Array<string>,
		prohibitedPaths: Array<string>,
	) {
		if (allowedPaths.length === 0) {
			throw new HarnessError(
				'EMPTY_PATH_ALLOWLIST',
				'Path policy requires at least one explicit allowed path pattern',
			)
		}

		this.rootPath = path.resolve(rootPath)
		this.allowedPaths = [...allowedPaths]
		this.prohibitedPaths = [
			...defaultProhibitedPaths,
			...prohibitedPaths,
		]
		this.writeProhibitedPaths = defaultWriteProhibitedPaths
	}

	isAllowed(relativePath: string): boolean {
		const normalized = normalizeAndValidateRelativePath(relativePath)
		const budget = createGlobMatchBudget()

		return (
			matchesAnyGlob(normalized, this.allowedPaths, budget) &&
			!matchesAnyGlob(normalized, this.prohibitedPaths, budget)
		)
	}

	isProhibited(relativePath: string): boolean {
		const normalized = normalizeAndValidateRelativePath(relativePath)
		return matchesAnyGlob(
			normalized,
			this.prohibitedPaths,
			createGlobMatchBudget(),
		)
	}

	assertAllowed(relativePath: string): string {
		const normalized = normalizeAndValidateRelativePath(relativePath)
		return this.assertAllowedWithBudget(normalized, createGlobMatchBudget())
	}

	private assertAllowedWithBudget(
		normalized: string,
		budget: GlobMatchBudget,
	): string {
		if (!matchesAnyGlob(normalized, this.allowedPaths, budget)) {
			throw new HarnessError(
				'PATH_NOT_ALLOWED',
				`Path is outside the task allowlist: ${normalized}`,
			)
		}

		if (matchesAnyGlob(normalized, this.prohibitedPaths, budget)) {
			throw new HarnessError(
				'SENSITIVE_PATH_DENIED',
				`Path is prohibited by policy: ${normalized}`,
			)
		}

		return normalized
	}

	async resolveForRead(relativePath: string): Promise<string> {
		const normalized = this.assertAllowed(relativePath)
		const candidate = path.resolve(this.rootPath, normalized)
		await this.assertInsideRoot(candidate)

		const stats = await lstat(candidate)

		if (stats.isSymbolicLink()) {
			const target = await realpath(candidate)
			await this.assertInsideRoot(target)
			const targetStats = await stat(target)

			if (targetStats.isFile()) {
				assertSafeLinkCount(targetStats.nlink, normalized)
			}
		} else if (stats.isFile()) {
			assertSafeLinkCount(stats.nlink, normalized)
		}

		return candidate
	}

	async resolveForWrite(relativePath: string): Promise<string> {
		const normalized = this.assertWritable(relativePath)
		const candidate = path.resolve(this.rootPath, normalized)
		await this.assertLexicallyInsideRoot(candidate)

		try {
			const stats = await lstat(candidate)

			if (stats.isSymbolicLink()) {
				throw new HarnessError(
					'SYMLINK_WRITE_DENIED',
					`Writing through a symlink is prohibited: ${normalized}`,
				)
			}

			if (stats.isFile()) {
				assertSafeLinkCount(stats.nlink, normalized)
			}
		} catch (error) {
			if (error instanceof HarnessError) {
				throw error
			}

			if (!isMissingFileError(error)) {
				throw error
			}
		}

		const parent = path.dirname(candidate)
		const existingParent = await findExistingParent(parent)
		await this.assertInsideRoot(existingParent)

		return candidate
	}

	async assertSafeChangedPath(relativePath: string): Promise<string> {
		const normalized = this.assertWritable(relativePath)
		const candidate = path.resolve(this.rootPath, normalized)
		await this.assertLexicallyInsideRoot(candidate)

		try {
			const stats = await lstat(candidate)

			if (stats.isSymbolicLink()) {
				throw new HarnessError(
					'CHANGED_SYMLINK_DENIED',
					`Worker patches may not create or modify symbolic links: ${normalized}`,
				)
			}

			if (!stats.isFile()) {
				throw new HarnessError(
					'UNSUPPORTED_CHANGED_FILE_TYPE',
					`Worker patches may contain regular files only: ${normalized}`,
				)
			}

			assertSafeLinkCount(stats.nlink, normalized)
		} catch (error) {
			if (error instanceof HarnessError) {
				throw error
			}

			if (!isMissingFileError(error)) {
				throw error
			}
		}

		return normalized
	}

	private assertWritable(relativePath: string): string {
		const normalized = normalizeAndValidateRelativePath(relativePath)
		const budget = createGlobMatchBudget()
		this.assertAllowedWithBudget(normalized, budget)

		if (matchesAnyGlob(normalized, this.writeProhibitedPaths, budget)) {
			throw new HarnessError(
				'CONTROL_PATH_WRITE_DENIED',
				`Worker writes to repository control-plane files are prohibited: ${normalized}`,
			)
		}

		return normalized
	}

	private async assertInsideRoot(candidatePath: string): Promise<void> {
		const root = await this.getResolvedRootPath()
		const resolvedCandidate = await realpath(candidatePath)
		const relative = path.relative(root, resolvedCandidate)

		if (relative.startsWith('..') || path.isAbsolute(relative)) {
			throw new HarnessError(
				'PATH_TRAVERSAL_DENIED',
				`Resolved path escapes the repository: ${candidatePath}`,
			)
		}
	}

	private async assertLexicallyInsideRoot(candidatePath: string): Promise<void> {
		const relative = path.relative(this.rootPath, candidatePath)

		if (relative.startsWith('..') || path.isAbsolute(relative)) {
			throw new HarnessError(
				'PATH_TRAVERSAL_DENIED',
				`Path escapes the repository: ${candidatePath}`,
			)
		}
	}

	private async getResolvedRootPath(): Promise<string> {
		if (this.resolvedRootPath === null) {
			this.resolvedRootPath = await realpath(this.rootPath)
		}

		return this.resolvedRootPath
	}
}

function assertSafeLinkCount(linkCount: number, relativePath: string): void {
	if (linkCount > 1) {
		throw new HarnessError(
			'HARD_LINK_DENIED',
			`Files with multiple hard links are prohibited: ${relativePath}`,
		)
	}
}

export function normalizeAndValidateRelativePath(value: string): string {
	if (value.includes('\0')) {
		throw new HarnessError('INVALID_PATH', 'Paths may not contain null bytes')
	}

	const normalized = normalizePath(path.posix.normalize(normalizePath(value)))

	if (
		normalized === '' ||
		normalized === '.' ||
		normalized === '..' ||
		normalized.startsWith('../') ||
		path.posix.isAbsolute(normalized)
	) {
		throw new HarnessError(
			'INVALID_PATH',
			`Expected a repository-relative path, received: ${value}`,
		)
	}

	return normalized
}

async function findExistingParent(candidatePath: string): Promise<string> {
	let current = candidatePath

	while (true) {
		try {
			await lstat(current)
			return current
		} catch (error) {
			if (!isMissingFileError(error)) {
				throw error
			}
		}

		const parent = path.dirname(current)

		if (parent === current) {
			throw new HarnessError(
				'PATH_RESOLUTION_FAILED',
				`Could not find an existing parent for ${candidatePath}`,
			)
		}

		current = parent
	}
}

function isMissingFileError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		error.code === 'ENOENT'
	)
}
