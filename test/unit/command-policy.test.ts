import assert from 'node:assert/strict'
import test from 'node:test'
import { CommandPolicy } from '../../src/security/command-policy.js'

function getCode(error: unknown): string | undefined {
	return typeof error === 'object' && error !== null && 'code' in error
		? String(error.code)
		: undefined
}

test('allows validation commands and denies mutations', function () {
	const policy = new CommandPolicy(['npm', 'tsc'])
	assert.doesNotThrow(() => policy.assertAllowed({ command: 'npm', args: ['run', 'test'] }))
	assert.doesNotThrow(() => policy.assertAllowed({ command: 'tsc', args: ['--noEmit'] }))
	assert.throws(
		() => policy.assertAllowed({ command: 'npm', args: ['install', 'left-pad'] }),
		error => getCode(error) === 'PACKAGE_MUTATION_DENIED',
	)
	assert.throws(
		() => policy.assertAllowed({ command: 'npm', args: ['ci'] }),
		error => getCode(error) === 'PACKAGE_MUTATION_DENIED',
	)
	assert.throws(
		() => policy.assertAllowed({ command: 'npm', args: ['pack', '--dry-run'] }),
		error => getCode(error) === 'PACKAGE_MUTATION_DENIED',
	)
	assert.throws(
		() => policy.assertAllowed({ command: 'npm', args: ['run', 'deploy:prod'] }),
		error => getCode(error) === 'COMMAND_SCRIPT_DENIED',
	)
	assert.throws(
		() => policy.assertAllowed({ command: 'bash', args: ['-c', 'echo bad'] }),
		error => getCode(error) === 'COMMAND_NOT_ALLOWED',
	)
})


test('denies package-manager script shortcuts and remote execution aliases', function () {
	const policy = new CommandPolicy(['npm', 'pnpm', 'yarn', 'bun'])

	assert.throws(
		() => policy.assertAllowed({ command: 'yarn', args: ['deploy'] }),
		error => getCode(error) === 'PACKAGE_MUTATION_DENIED',
	)
	assert.throws(
		() => policy.assertAllowed({ command: 'bun', args: ['x', 'package'] }),
		error => getCode(error) === 'PACKAGE_MUTATION_DENIED',
	)
	assert.throws(
		() => policy.assertAllowed({
			command: 'npm',
			args: ['run', '--workspace', 'safe-workspace', 'deploy'],
		}),
		error => getCode(error) === 'COMMAND_SCRIPT_DENIED',
	)
	assert.doesNotThrow(() =>
		policy.assertAllowed({ command: 'pnpm', args: ['run', 'typecheck'] }),
	)
})
