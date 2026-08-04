const regexSpecialCharacters = /[.+^${}()|[\]\\]/g

export function matchGlob(value: string, pattern: string): boolean {
	const normalizedValue = normalizePath(value)
	const normalizedPattern = normalizePath(pattern)
	const regex = globToRegExp(normalizedPattern)

	return regex.test(normalizedValue)
}

export function matchesAnyGlob(value: string, patterns: Array<string>): boolean {
	return patterns.some(pattern => matchGlob(value, pattern))
}

export function normalizePath(value: string): string {
	return value.replaceAll('\\', '/').replace(/^\.\//, '')
}

function globToRegExp(pattern: string): RegExp {
	let source = '^'

	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index]
		const nextCharacter = pattern[index + 1]

		if (character === '*' && nextCharacter === '*') {
			const followingCharacter = pattern[index + 2]

			if (followingCharacter === '/') {
				source += '(?:.*/)?'
				index += 2
				continue
			}

			source += '.*'
			index += 1
			continue
		}

		if (character === '*') {
			source += '[^/]*'
			continue
		}

		if (character === '?') {
			source += '[^/]'
			continue
		}

		source += character?.replace(regexSpecialCharacters, '\\$&') ?? ''
	}

	source += '$'
	return new RegExp(source)
}
