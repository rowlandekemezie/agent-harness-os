import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const roots = ['src', 'test', 'scripts']
const extensions = new Set(['.ts', '.js', '.mjs', '.cjs'])
const errors = []

async function walk(directory) {
	const entries = await readdir(directory, { withFileTypes: true })

	for (const entry of entries) {
		const absolutePath = path.join(directory, entry.name)

		if (entry.isDirectory()) {
			await walk(absolutePath)
			continue
		}

		if (!extensions.has(path.extname(entry.name))) {
			continue
		}

		const source = await readFile(absolutePath, 'utf8')
		const lines = source.split('\n')

		for (const [index, line] of lines.entries()) {
			if (/\s+$/.test(line)) {
				errors.push(`${absolutePath}:${index + 1}: trailing whitespace`)
			}

			const leadingWhitespace = line.match(/^\s+/)?.[0] ?? ''
			if (leadingWhitespace.includes(' ')) {
				errors.push(`${absolutePath}:${index + 1}: use tabs for indentation`)
			}
		}

		if (!source.endsWith('\n')) {
			errors.push(`${absolutePath}: missing final newline`)
		}
	}
}

for (const root of roots) {
	await walk(root)
}

if (errors.length > 0) {
	console.error(errors.join('\n'))
	process.exitCode = 1
} else {
	console.log('lint passed')
}
