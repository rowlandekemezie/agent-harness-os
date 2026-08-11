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
