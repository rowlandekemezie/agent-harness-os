import assert from 'node:assert/strict'
import test from 'node:test'
import { Redactor } from '../../src/lib/redaction.js'

test('redacts named secrets and token-shaped values', function () {
	const redactor = new Redactor({ API_KEY: 'super-secret-value' })
	const output = redactor.redact('Bearer abc.def and super-secret-value and sk-1234567890abcdef')

	assert.equal(output.includes('super-secret-value'), false)
	assert.equal(output.includes('abc.def'), false)
	assert.equal(output.includes('sk-1234567890abcdef'), false)
})
