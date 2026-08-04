import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { HarnessError } from '../lib/errors.js'
import { matchesAnyGlob, normalizePath } from '../lib/glob.js'

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
	'.agent-harness',
	'.agent-harness/**',
	'**/.agent-harness',
	'**/.agent-harness/**',
]

export class PathPolicy {
	readonly rootPath: string
	readonly allowedPaths: Array<string>
	readonly prohibitedPaths: Array<string>
	private resolvedRootPath: string | null = null

	constructor(
		rootPath: string,
		allowedPaths: Array<string>,
		prohibitedPaths: Array<string>,
	) {
		this.rootPath = path.resolve(rootPath)
		this.allowedPaths = allowedPaths.length > 0 ? allowedPaths : ['**/*']
		this.prohibitedPaths = [
			...defaultProhibitedPaths,
			...prohibitedPaths,
		]
	}

	isAllowed(relativePath: string): boolean {
		const normalized = normalizeAndValidateRelativePath(relativePath)

		return (
			matchesAnyGlob(normalized, this.allowedPaths) &&
			!matchesAnyGlob(normalized, this.prohibitedPaths)
		)
	}

	assertAllowed(relativePath: string): string {
		const normalized = normalizeAndValidateRelativePath(relativePath)

		if (!matchesAnyGlob(normalized, this.allowedPaths)) {
			throw new HarnessError(
				'PATH_NOT_ALLOWED',
				`Path is outside the task allowlist: ${normalized}`,
			)
		}

		if (matchesAnyGlob(normalized, this.prohibitedPaths)) {
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
		}

		return candidate
	}

	async resolveForWrite(relativePath: string): Promise<string> {
		const normalized = this.assertAllowed(relativePath)
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
