import assert from 'node:assert/strict'
import test from 'node:test'
import { Semaphore } from '../../src/lib/semaphore.js'

test('removes an aborted waiter without consuming a permit', async function () {
	const semaphore = new Semaphore(1)
	let releaseFirst: (() => void) | undefined
	const first = semaphore.use(async () => {
		await new Promise<void>(resolve => {
			releaseFirst = resolve
		})
	})
	const controller = new AbortController()
	const second = semaphore.use(async () => 'unexpected', controller.signal)
	controller.abort()

	await assert.rejects(
		second,
		(error: unknown) => error instanceof Error && error.name === 'AbortError',
	)
	releaseFirst?.()
	await first
	assert.equal(await semaphore.use(async () => 'available'), 'available')
})
