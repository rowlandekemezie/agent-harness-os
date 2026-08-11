import { HarnessError } from './errors.js'

const maxGlobStates = 200_000

type GlobState = {
	valueIndex: number
	patternIndex: number
	globstarSlashActive: boolean
}

export function matchGlob(value: string, pattern: string): boolean {
	const normalizedValue = normalizePath(value)
	const normalizedPattern = normalizePath(pattern)
	return matchNormalizedGlob(normalizedValue, normalizedPattern)
}

export function matchesAnyGlob(value: string, patterns: Array<string>): boolean {
	return patterns.some(pattern => matchGlob(value, pattern))
}

export function normalizePath(value: string): string {
	return value.replaceAll('\\', '/').replace(/^\.\//, '')
}

function matchNormalizedGlob(value: string, pattern: string): boolean {
	const pending: Array<GlobState> = [{
		valueIndex: 0,
		patternIndex: 0,
		globstarSlashActive: false,
	}]
	const visited = new Set<number>()
	const valueWidth = value.length + 1

	while (pending.length > 0) {
		const state = pending.pop()!
		const stateKey = (
			(state.patternIndex * valueWidth + state.valueIndex) * 2 +
			(state.globstarSlashActive ? 1 : 0)
		)
		if (visited.has(stateKey)) {
			continue
		}
		visited.add(stateKey)
		if (visited.size > maxGlobStates) {
			throw new HarnessError(
				'GLOB_MATCH_LIMIT',
				`Glob matching exceeded the ${maxGlobStates}-state safety limit`,
			)
		}

		if (state.globstarSlashActive) {
			if (state.valueIndex >= value.length) {
				continue
			}
			pending.push({
				...state,
				valueIndex: state.valueIndex + 1,
			})
			if (value[state.valueIndex] === '/') {
				pending.push({
					valueIndex: state.valueIndex + 1,
					patternIndex: state.patternIndex + 3,
					globstarSlashActive: false,
				})
			}
			continue
		}

		if (state.patternIndex >= pattern.length) {
			if (state.valueIndex === value.length) {
				return true
			}
			continue
		}

		const character = pattern[state.patternIndex]
		const nextCharacter = pattern[state.patternIndex + 1]
		const followingCharacter = pattern[state.patternIndex + 2]
		if (character === '*' && nextCharacter === '*') {
			if (followingCharacter === '/') {
				pending.push({
					valueIndex: state.valueIndex,
					patternIndex: state.patternIndex + 3,
					globstarSlashActive: false,
				})
				if (state.valueIndex < value.length) {
					pending.push({ ...state, globstarSlashActive: true })
				}
				continue
			}

			pending.push({
				...state,
				patternIndex: state.patternIndex + 2,
			})
			if (state.valueIndex < value.length) {
				pending.push({ ...state, valueIndex: state.valueIndex + 1 })
			}
			continue
		}

		if (character === '*') {
			pending.push({
				...state,
				patternIndex: state.patternIndex + 1,
			})
			if (
				state.valueIndex < value.length &&
				value[state.valueIndex] !== '/'
			) {
				pending.push({ ...state, valueIndex: state.valueIndex + 1 })
			}
			continue
		}

		if (
			state.valueIndex < value.length &&
			character === '?' &&
			value[state.valueIndex] !== '/'
		) {
			pending.push({
				...state,
				valueIndex: state.valueIndex + 1,
				patternIndex: state.patternIndex + 1,
			})
			continue
		}

		if (character === value[state.valueIndex]) {
			pending.push({
				...state,
				valueIndex: state.valueIndex + 1,
				patternIndex: state.patternIndex + 1,
			})
		}
	}

	return false
}
