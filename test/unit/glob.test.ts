import assert from 'node:assert/strict'
import test from 'node:test'
import { matchGlob, matchesAnyGlob } from '../../src/lib/glob.js'

test('matches repository glob patterns', function () {
	assert.equal(matchGlob('src/index.ts', 'src/**/*.ts'), true)
	assert.equal(matchGlob('src/deep/index.ts', 'src/**/*.ts'), true)
	assert.equal(matchGlob('README.md', '**/*'), true)
	assert.equal(matchGlob('src/index.js', 'src/**/*.ts'), false)
	assert.equal(matchGlob('src/deep/index.ts', 'src/*/index.?s'), true)
	assert.equal(matchGlob('src/deep/nested/index.ts', 'src/*/index.ts'), false)
	assert.equal(matchGlob('src/abcx', 'src/**/x'), false)
	assert.equal(matchesAnyGlob('.env.local', ['.env', '.env.*']), true)
})

test('bounds adversarial wildcard matching without regex backtracking', function () {
	assert.equal(
		matchGlob('a'.repeat(100), `${'*a'.repeat(50)}b`),
		false,
	)
})

test('shares one matching budget across an entire pattern set', function () {
	const patterns = Array.from(
		{ length: 300 },
		(_, index) => `${'*a'.repeat(50)}b${index}`,
	)

	assert.throws(
		() => matchesAnyGlob('a'.repeat(100), patterns),
		(error: unknown) =>
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'GLOB_MATCH_LIMIT',
	)
})
