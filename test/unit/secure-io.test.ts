import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
	mkdtemp,
	readFile,
	rename,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
	createPrivateDirectory,
	writeExclusiveRegularFile,
} from '../../src/artifacts/secure-io.js'

const helperPath = fileURLToPath(
	new URL('../../src/artifacts/secure-fs-helper.js', import.meta.url),
)

test('confines writes when the destination directory is replaced before mutation', async function () {
	const root = await mkdtemp(path.join(os.tmpdir(), 'secure-io-swap-'))
	const destination = await mkdtemp(path.join(root, 'destination-'))
	const movedDestination = `${destination}-moved`
	const replacement = await mkdtemp(path.join(root, 'replacement-'))
	const identity = await stat(destination, { bigint: true })

	const child = spawn(
		process.execPath,
		[
			helperPath,
			'publish-file',
			identity.dev.toString(),
			identity.ino.toString(),
			root,
			destination,
			'event.json',
			'.publish-11111111-1111-4111-8111-111111111111',
			'600',
			'6',
		],
		{ cwd: destination, env: {}, stdio: ['pipe', 'pipe', 'ignore'] },
	)
	await new Promise<void>((resolve, reject) => {
		child.once('error', reject)
		child.stdout.once('data', () => resolve())
	})
	await rename(destination, movedDestination)
	await symlink(replacement, destination)
	child.stdin.end('secret')
	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.once('error', reject)
		child.once('exit', resolve)
	})

	assert.notEqual(exitCode, 0)
	await assert.rejects(readFile(path.join(replacement, 'event.json')))
	await assert.rejects(readFile(path.join(replacement, '.publish-11111111-1111-4111-8111-111111111111')))
	await assert.rejects(readFile(path.join(movedDestination, 'event.json')))
})

test('never overwrites a destination created during publication', async function () {
	const root = await mkdtemp(path.join(os.tmpdir(), 'secure-io-race-'))
	const destination = await mkdtemp(path.join(root, 'destination-'))
	const identity = await stat(destination, { bigint: true })
	const child = spawn(
		process.execPath,
		[
			helperPath,
			'publish-file',
			identity.dev.toString(),
			identity.ino.toString(),
			root,
			destination,
			'event.json',
			'.publish-22222222-2222-4222-8222-222222222222-event.json',
			'600',
			'6',
		],
		{ cwd: destination, env: {}, stdio: ['pipe', 'pipe', 'ignore'] },
	)
	await new Promise<void>((resolve, reject) => {
		child.once('error', reject)
		child.stdout.once('data', () => resolve())
	})
	await writeFile(path.join(destination, 'event.json'), 'original', {
		mode: 0o600,
	})
	child.stdin.end('secret')
	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.once('error', reject)
		child.once('exit', resolve)
	})

	assert.notEqual(exitCode, 0)
	assert.equal(
		await readFile(path.join(destination, 'event.json'), 'utf8'),
		'original',
	)
})

test('does not publish a prepared file without the parent commit grant', async function () {
	const root = await mkdtemp(path.join(os.tmpdir(), 'secure-io-commit-'))
	const destination = await mkdtemp(path.join(root, 'destination-'))
	const identity = await stat(destination, { bigint: true })
	const temporaryName = '.publish-33333333-3333-4333-8333-333333333333-event.json'
	const child = spawn(
		process.execPath,
		[
			helperPath,
			'publish-file',
			identity.dev.toString(),
			identity.ino.toString(),
			root,
			destination,
			'event.json',
			temporaryName,
			'600',
			'6',
		],
		{ cwd: destination, env: {}, stdio: ['pipe', 'pipe', 'ignore', 'ipc'] },
	)
	const childStdin = child.stdin
	const childStdout = child.stdout
	assert.ok(childStdin)
	assert.ok(childStdout)
	const prepared = new Promise<void>((resolve, reject) => {
		let output = ''
		child.once('error', reject)
		childStdout.on('data', (chunk: Buffer) => {
			output += chunk.toString('utf8')
			if (output.split('\n').includes('prepared')) {
				resolve()
			}
		})
	})
	childStdin.end('secret')
	await prepared
	child.disconnect()
	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.once('error', reject)
		child.once('exit', resolve)
	})

	assert.notEqual(exitCode, 0)
	await assert.rejects(readFile(path.join(destination, 'event.json')))
	await assert.rejects(readFile(path.join(destination, temporaryName)))
})

test('handles large exclusive-write collisions without crashing', async function () {
	const root = await mkdtemp(path.join(os.tmpdir(), 'secure-io-epipe-'))
	const filePath = path.join(root, 'report.json')
	await writeExclusiveRegularFile(root, filePath, 'original')

	await assert.rejects(
		writeExclusiveRegularFile(root, filePath, Buffer.alloc(20_000_000, 1)),
		(error: unknown) =>
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'ARTIFACT_WRITE_FAILED',
	)
	assert.equal(await readFile(filePath, 'utf8'), 'original')
})

test('creates private directories exclusively', async function () {
	const root = await mkdtemp(path.join(os.tmpdir(), 'secure-io-directory-'))
	const directoryPath = path.join(root, 'run')
	await createPrivateDirectory(root, directoryPath)

	await assert.rejects(
		createPrivateDirectory(root, directoryPath),
		(error: unknown) =>
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'ARTIFACT_WRITE_FAILED',
	)
})
