import { spawn } from 'node:child_process'
import type { CommandResult } from '../domain/types.js'
import { Redactor } from './redaction.js'
import { decodeUtf8Prefix } from './text.js'

export type RunProcessOptions = {
	cwd: string
	environment?: NodeJS.ProcessEnv
	timeoutMs: number
	maxOutputBytes: number
	signal?: AbortSignal
	input?: string | Buffer
}

export async function runProcess(
	command: string,
	args: Array<string>,
	options: RunProcessOptions,
): Promise<CommandResult> {
	if (options.signal?.aborted === true) {
		throw new DOMException('Process aborted before start', 'AbortError')
	}

	const startedAt = Date.now()
	const redactor = new Redactor(options.environment)
	let stdout = ''
	let stderr = ''
	let timedOut = false
	let outputTruncated = false

	return await new Promise<CommandResult>((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.environment,
			stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
			shell: false,
		})

		function appendOutput(current: string, chunk: Buffer): string {
			if (Buffer.byteLength(current) >= options.maxOutputBytes) {
				outputTruncated = true
				return current
			}

			const combined = current + chunk.toString('utf8')
			const buffer = Buffer.from(combined, 'utf8')

			if (buffer.byteLength <= options.maxOutputBytes) {
				return combined
			}

			outputTruncated = true
			const marker = '\n[OUTPUT TRUNCATED]'
			const contentLimit = Math.max(
				0,
				options.maxOutputBytes - Buffer.byteLength(marker, 'utf8'),
			)
			return `${decodeUtf8Prefix(buffer, contentLimit)}${marker}`
		}

		child.stdout?.on('data', (chunk: Buffer) => {
			stdout = appendOutput(stdout, chunk)
		})

		child.stderr?.on('data', (chunk: Buffer) => {
			stderr = appendOutput(stderr, chunk)
		})

		function terminate(): void {
			child.kill('SIGTERM')

			setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) {
					child.kill('SIGKILL')
				}
			}, 2_000).unref()
		}

		const timer = setTimeout(() => {
			timedOut = true
			terminate()
		}, options.timeoutMs)

		function abort(): void {
			terminate()
		}

		options.signal?.addEventListener('abort', abort, { once: true })

		if (options.input !== undefined) {
			child.stdin?.on('error', error => {
				if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
					reject(error)
				}
			})
			child.stdin?.end(options.input)
		}

		child.on('error', error => {
			clearTimeout(timer)
			options.signal?.removeEventListener('abort', abort)
			reject(error)
		})

		child.on('close', (exitCode, signal) => {
			clearTimeout(timer)
			options.signal?.removeEventListener('abort', abort)
			resolve({
				command,
				args,
				exitCode,
				signal,
				stdout: redactor.redact(stdout),
				stderr: redactor.redact(stderr),
				durationMs: Date.now() - startedAt,
				timedOut,
				outputTruncated,
			})
		})
	})
}

export function createSanitizedEnvironment(
	extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
	const allowedNames = [
		'PATH',
		'LANG',
		'LC_ALL',
		'TERM',
		'TMPDIR',
		'TEMP',
		'TMP',
		'SYSTEMROOT',
		'WINDIR',
	]
	const sanitized: NodeJS.ProcessEnv = {
		CI: 'true',
		NO_COLOR: '1',
		NODE_ENV: 'test',
	}

	for (const name of allowedNames) {
		const value = process.env[name]

		if (value !== undefined) {
			sanitized[name] = value
		}
	}

	return {
		...sanitized,
		...extra,
	}
}
