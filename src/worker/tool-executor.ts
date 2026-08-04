import type { Dirent } from 'node:fs'
import { mkdir, opendir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
	JsonObject,
	ProviderToolDefinition,
	ToolExecutionResult,
	WorkerTask,
} from '../domain/types.js'
import type { HarnessConfig } from '../config.js'
import { HarnessError, getErrorMessage } from '../lib/errors.js'
import { truncateUtf8 } from '../lib/text.js'
import {
	isRecord,
	optionalBoolean,
	optionalInteger,
	optionalString,
	requireString,
} from '../lib/json.js'
import { getBinaryPatch, getChangedFiles } from '../git/repository.js'
import { PathPolicy } from '../security/path-policy.js'

export type ToolExecutorContext = {
	task: WorkerTask
	worktreePath: string
	repositoryPath?: string
	config: HarnessConfig
	baseCommit: string
	policyViolations: Array<string>
	signal: AbortSignal
}

export class WorkerToolExecutor {
	private readonly context: ToolExecutorContext
	private readonly pathPolicy: PathPolicy

	constructor(context: ToolExecutorContext) {
		this.context = context
		this.pathPolicy = new PathPolicy(
			context.worktreePath,
			context.task.allowedPaths,
			context.task.prohibitedPaths,
		)
	}

	getDefinitions(): Array<ProviderToolDefinition> {
		const definitions: Array<ProviderToolDefinition> = [
			defineTool(
				'list_files',
				'List repository files under an allowed path.',
				{
					type: 'object',
					properties: {
						path: { type: 'string' },
						depth: { type: 'integer', minimum: 0, maximum: 8 },
					},
					additionalProperties: false,
				},
			),
			defineTool(
				'read_file',
				'Read a UTF-8 text file with optional line bounds.',
				{
					type: 'object',
					properties: {
						path: { type: 'string' },
						startLine: { type: 'integer', minimum: 1 },
						endLine: { type: 'integer', minimum: 1 },
					},
					required: ['path'],
					additionalProperties: false,
				},
			),
			defineTool(
				'search_files',
				'Search allowed UTF-8 files for a literal query.',
				{
					type: 'object',
					properties: {
						query: { type: 'string' },
						path: { type: 'string' },
						caseSensitive: { type: 'boolean' },
						maxResults: { type: 'integer', minimum: 1, maximum: 200 },
					},
					required: ['query'],
					additionalProperties: false,
				},
			),
			defineTool(
				'get_diff',
				'Inspect the current Git diff in the isolated worktree.',
				{
					type: 'object',
					properties: {},
					additionalProperties: false,
				},
			),
		]

		if (this.context.task.mode === 'implementation' || this.context.task.mode === 'testing') {
			definitions.push(
				defineTool(
					'write_file',
					'Create or replace an allowed UTF-8 text file.',
					{
						type: 'object',
						properties: {
							path: { type: 'string' },
							content: { type: 'string' },
						},
						required: ['path', 'content'],
						additionalProperties: false,
					},
				),
				defineTool(
					'delete_file',
					'Delete one allowed file. Directory deletion is not supported.',
					{
						type: 'object',
						properties: {
							path: { type: 'string' },
						},
						required: ['path'],
						additionalProperties: false,
					},
				),
			)
		}

		return definitions
	}

	async execute(name: string, rawArguments: unknown): Promise<ToolExecutionResult> {
		try {
			const argumentsRecord = isRecord(rawArguments) ? rawArguments : {}

			switch (name) {
				case 'list_files':
					return success(limitToolOutput(
						await this.listFiles(argumentsRecord),
						this.context.config.limits.maxToolOutputBytes,
					))
				case 'read_file':
					return success(limitToolOutput(
						await this.readFile(argumentsRecord),
						this.context.config.limits.maxToolOutputBytes,
					))
				case 'search_files':
					return success(limitToolOutput(
						await this.searchFiles(argumentsRecord),
						this.context.config.limits.maxToolOutputBytes,
					))
				case 'get_diff':
					return success(limitToolOutput(
						await this.getDiff(),
						this.context.config.limits.maxToolOutputBytes,
					))
				case 'write_file':
					this.assertWritableMode()
					return success(limitToolOutput(
						await this.writeFile(argumentsRecord),
						this.context.config.limits.maxToolOutputBytes,
					))
				case 'delete_file':
					this.assertWritableMode()
					return success(limitToolOutput(
						await this.deleteFile(argumentsRecord),
						this.context.config.limits.maxToolOutputBytes,
					))
				default:
					throw new HarnessError('UNKNOWN_WORKER_TOOL', `Unknown worker tool: ${name}`)
			}
		} catch (error) {
			if (error instanceof HarnessError && isPolicyError(error.code)) {
				this.context.policyViolations.push(`${error.code}: ${error.message}`)
			}

			return {
				content: JSON.stringify({
					error: error instanceof HarnessError ? error.code : 'TOOL_EXECUTION_FAILED',
					message: getErrorMessage(error),
				}),
				isError: true,
			}
		}
	}

	private async listFiles(argumentsRecord: JsonObject): Promise<string> {
		const requestedPath = optionalString(argumentsRecord.path, 'path', '')
		const depth = optionalInteger(argumentsRecord.depth, 'depth', 3, {
			min: 0,
			max: 8,
		})
		const startPath = requestedPath === ''
			? this.context.worktreePath
			: await this.pathPolicy.resolveForRead(requestedPath)
		const entries: Array<string> = []
		await walkFiles(
			startPath,
			this.context.worktreePath,
			depth,
			entries,
			this.pathPolicy,
			createTraversalState(this.context),
		)

		return entries.slice(0, 500).join('\n') || '[no allowed files found]'
	}

	private async readFile(argumentsRecord: JsonObject): Promise<string> {
		const requestedPath = requireString(argumentsRecord.path, 'path', {
			minLength: 1,
			maxLength: 1_024,
		})
		const filePath = await this.pathPolicy.resolveForRead(requestedPath)
		const fileStats = await stat(filePath)

		if (!fileStats.isFile()) {
			throw new HarnessError('NOT_A_FILE', `Path is not a file: ${requestedPath}`)
		}

		if (fileStats.size > this.context.config.limits.maxFileBytes) {
			throw new HarnessError(
				'FILE_TOO_LARGE',
				`File exceeds the read limit: ${requestedPath}`,
			)
		}

		const contents = await readFile(filePath)

		if (contents.includes(0)) {
			throw new HarnessError('BINARY_FILE_DENIED', `Binary file cannot be read: ${requestedPath}`)
		}

		const lines = contents.toString('utf8').split('\n')
		const startLine = optionalInteger(argumentsRecord.startLine, 'startLine', 1, {
			min: 1,
			max: Math.max(1, lines.length),
		})
		const endLine = optionalInteger(
			argumentsRecord.endLine,
			'endLine',
			Math.min(lines.length, startLine + 399),
			{ min: startLine, max: Math.max(startLine, lines.length) },
		)

		return lines
			.slice(startLine - 1, endLine)
			.map((line, index) => `${startLine + index}: ${line}`)
			.join('\n')
	}

	private async searchFiles(argumentsRecord: JsonObject): Promise<string> {
		const query = requireString(argumentsRecord.query, 'query', {
			minLength: 1,
			maxLength: 500,
		})
		const requestedPath = optionalString(argumentsRecord.path, 'path', '')
		const caseSensitive = optionalBoolean(
			argumentsRecord.caseSensitive,
			'caseSensitive',
			false,
		)
		const maxResults = optionalInteger(
			argumentsRecord.maxResults,
			'maxResults',
			50,
			{ min: 1, max: 200 },
		)
		const matcher = createMatcher(query, caseSensitive)
		const startPath = requestedPath === ''
			? this.context.worktreePath
			: await this.pathPolicy.resolveForRead(requestedPath)
		const files: Array<string> = []
		await walkFiles(
			startPath,
			this.context.worktreePath,
			8,
			files,
			this.pathPolicy,
			createTraversalState(this.context),
		)
		const results: Array<string> = []
		let scannedBytes = 0

		for (const relativePath of files) {
			throwIfAborted(this.context.signal)

			if (results.length >= maxResults) {
				break
			}

			try {
				const filePath = await this.pathPolicy.resolveForRead(relativePath)
				const fileStats = await stat(filePath)

				if (!fileStats.isFile() || fileStats.size > this.context.config.limits.maxFileBytes) {
					continue
				}

				if (
					scannedBytes + fileStats.size >
					this.context.config.limits.maxSearchBytes
				) {
					throw new HarnessError(
						'SEARCH_BYTE_LIMIT',
						`Search exceeded the ${this.context.config.limits.maxSearchBytes}-byte scan limit`,
					)
				}

				scannedBytes += fileStats.size
				const contents = await readFile(filePath)

				if (contents.includes(0)) {
					continue
				}

				const lines = contents.toString('utf8').split('\n')

				for (const [index, line] of lines.entries()) {
					if (matcher(line)) {
						results.push(`${relativePath}:${index + 1}: ${line}`)
					}

					if (results.length >= maxResults) {
						break
					}
				}
			} catch (error) {
				if (error instanceof HarnessError) {
					throw error
				}

				// Skip files that become unreadable during traversal.
			}
		}

		return results.join('\n') || '[no matches]'
	}

	private async writeFile(argumentsRecord: JsonObject): Promise<string> {
		const requestedPath = requireString(argumentsRecord.path, 'path', {
			minLength: 1,
			maxLength: 1_024,
		})
		const content = requireString(argumentsRecord.content, 'content')
		const contentBytes = Buffer.byteLength(content, 'utf8')

		if (contentBytes > this.context.config.limits.maxFileBytes) {
			throw new HarnessError(
				'FILE_TOO_LARGE',
				`File exceeds the write limit: ${requestedPath}`,
			)
		}
		const filePath = await this.pathPolicy.resolveForWrite(requestedPath)
		await mkdir(path.dirname(filePath), { recursive: true })
		await writeFile(filePath, content, { encoding: 'utf8', mode: 0o600 })

		return JSON.stringify({ path: requestedPath, bytes: contentBytes })
	}

	private async deleteFile(argumentsRecord: JsonObject): Promise<string> {
		const requestedPath = requireString(argumentsRecord.path, 'path', {
			minLength: 1,
			maxLength: 1_024,
		})
		const filePath = await this.pathPolicy.resolveForWrite(requestedPath)
		const fileStats = await stat(filePath)

		if (!fileStats.isFile()) {
			throw new HarnessError('NOT_A_FILE', `Only file deletion is supported: ${requestedPath}`)
		}

		await rm(filePath)
		return JSON.stringify({ path: requestedPath, deleted: true })
	}

	private async getDiff(): Promise<string> {
		const changedFiles = await getChangedFiles(
			this.context.worktreePath,
			this.context.baseCommit,
		)

		if (changedFiles.length > this.context.config.limits.maxChangedFiles) {
			throw new HarnessError(
				'CHANGED_FILE_LIMIT',
				`Worker changed ${changedFiles.length} files, exceeding the limit of ${this.context.config.limits.maxChangedFiles}`,
			)
		}

		for (const changedFile of changedFiles) {
			await this.pathPolicy.assertSafeChangedPath(changedFile)
		}

		const patch = await getBinaryPatch(
			this.context.worktreePath,
			this.context.baseCommit,
		)

		if (Buffer.byteLength(patch) <= this.context.config.limits.maxToolOutputBytes) {
			return patch || '[no changes]'
		}

		return `${Buffer.from(patch).subarray(0, this.context.config.limits.maxToolOutputBytes).toString('utf8')}\n[DIFF TRUNCATED]`
	}

	private assertWritableMode(): void {
		if (this.context.task.mode === 'research' || this.context.task.mode === 'review') {
			throw new HarnessError(
				'READ_ONLY_TASK',
				`Tool is unavailable in ${this.context.task.mode} mode`,
			)
		}
	}
}

function limitToolOutput(value: string, maxBytes: number): string {
	const valueBuffer = Buffer.from(value, 'utf8')

	if (valueBuffer.byteLength <= maxBytes) {
		return value
	}

	const marker = '\n[TOOL OUTPUT TRUNCATED]'
	const contentLimit = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'))

	return `${truncateUtf8(value, contentLimit)}${marker}`
}

function defineTool(
	name: string,
	description: string,
	parameters: Record<string, unknown>,
): ProviderToolDefinition {
	return {
		type: 'function',
		function: { name, description, parameters },
	}
}

function success(content: string): ToolExecutionResult {
	return { content, isError: false }
}

function isPolicyError(code: string): boolean {
	return (
		code.includes('DENIED') ||
		code.includes('NOT_ALLOWED') ||
		code === 'READ_ONLY_TASK'
	)
}

type TraversalState = {
	visitedEntries: number
	maxEntries: number
	signal: AbortSignal
}

function createTraversalState(context: ToolExecutorContext): TraversalState {
	return {
		visitedEntries: 0,
		maxEntries: context.config.limits.maxTraversalEntries,
		signal: context.signal,
	}
}

async function walkFiles(
	currentPath: string,
	rootPath: string,
	depth: number,
	entries: Array<string>,
	policy: PathPolicy,
	state: TraversalState,
): Promise<void> {
	throwIfAborted(state.signal)

	if (entries.length >= 500) {
		return
	}

	const currentStats = await stat(currentPath)

	if (currentStats.isFile()) {
		const relativePath = path.relative(rootPath, currentPath).replaceAll('\\', '/')

		if (policy.isAllowed(relativePath)) {
			entries.push(relativePath)
		}

		return
	}

	if (!currentStats.isDirectory() || depth < 0) {
		return
	}

	const directory = await opendir(currentPath)
	const directoryEntries: Array<Dirent> = []

	for await (const entry of directory) {
		throwIfAborted(state.signal)
		state.visitedEntries += 1

		if (state.visitedEntries > state.maxEntries) {
			throw new HarnessError(
				'FILE_TRAVERSAL_LIMIT',
				`File traversal exceeded the ${state.maxEntries}-entry limit`,
			)
		}

		directoryEntries.push(entry)
	}

	for (const entry of directoryEntries.sort((left, right) => left.name.localeCompare(right.name))) {
		throwIfAborted(state.signal)
		if (entry.name === '.git' || entry.name === 'node_modules') {
			continue
		}

		const absolutePath = path.join(currentPath, entry.name)
		const relativePath = path.relative(rootPath, absolutePath).replaceAll('\\', '/')

		if (entry.isSymbolicLink()) {
			continue
		}

		if (entry.isDirectory()) {
			if (policy.isProhibited(relativePath)) {
				continue
			}

			if (depth > 0) {
				await walkFiles(
					absolutePath,
					rootPath,
					depth - 1,
					entries,
					policy,
					state,
				)
			}
			continue
		}

		if (entry.isFile() && policy.isAllowed(relativePath)) {
			entries.push(relativePath)
		}
	}
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		throw new DOMException('Worker tool operation aborted', 'AbortError')
	}
}

function createMatcher(
	query: string,
	caseSensitive: boolean,
): (line: string) => boolean {
	const needle = caseSensitive ? query : query.toLowerCase()
	return line => (caseSensitive ? line : line.toLowerCase()).includes(needle)
}
