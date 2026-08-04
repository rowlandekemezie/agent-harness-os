import assert from 'node:assert/strict'
import test from 'node:test'
import { matchGlob, matchesAnyGlob } from '../../src/lib/glob.js'

test('matches repository glob patterns', function () {
	assert.equal(matchGlob('src/index.ts', 'src/**/*.ts'), true)
	assert.equal(matchGlob('src/deep/index.ts', 'src/**/*.ts'), true)
	assert.equal(matchGlob('README.md', '**/*'), true)
	assert.equal(matchGlob('src/index.js', 'src/**/*.ts'), false)
	assert.equal(matchesAnyGlob('.env.local', ['.env', '.env.*']), true)
})
