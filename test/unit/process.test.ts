import assert from 'node:assert/strict'
import test from 'node:test'
import { runProcess } from '../../src/lib/process.js'

test('validates UTF-8 across process output chunk boundaries', async function () {
	const result = await runProcess(process.execPath, [
		'-e',
		"process.stdout.write(Buffer.from([0xe2])); setTimeout(() => process.stdout.write(Buffer.from([0x82, 0xac])), 10)",
	], {
		cwd: process.cwd(),
		timeoutMs: 5_000,
		maxOutputBytes: 1_024,
		requireValidUtf8: true,
	})

	assert.equal(result.exitCode, 0)
	assert.equal(result.stdout, '€')
	assert.equal(result.invalidUtf8, false)
})

test('marks invalid process UTF-8 without replacement decoding', async function () {
	const result = await runProcess(process.execPath, [
		'-e',
		'process.stdout.write(Buffer.from([0xc3, 0x28]))',
	], {
		cwd: process.cwd(),
		timeoutMs: 5_000,
		maxOutputBytes: 1_024,
		requireValidUtf8: true,
	})

	assert.equal(result.exitCode, 0)
	assert.equal(result.invalidUtf8, true)
	assert.equal(result.stdout, '')
})

test('can preserve token-shaped stdout while retaining safe defaults', async function () {
	const token = 'sk-1234567890abcdef'
	const redacted = await runProcess(process.execPath, ['-e', `process.stdout.write('${token}')`], {
		cwd: process.cwd(),
		timeoutMs: 5_000,
		maxOutputBytes: 1_024,
	})
	const exact = await runProcess(process.execPath, ['-e', `process.stdout.write('${token}')`], {
		cwd: process.cwd(),
		timeoutMs: 5_000,
		maxOutputBytes: 1_024,
		redactStdout: false,
	})

	assert.equal(redacted.stdout, '[REDACTED]')
	assert.equal(exact.stdout, token)
})
