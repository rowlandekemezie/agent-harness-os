const sensitiveNamePattern =
	/(?:api[_-]?key|token|secret|password|passwd|credential|authorization|private[_-]?key)/i

const tokenPatterns: Array<RegExp> = [
	/Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
	/\bsk-[A-Za-z0-9_-]{16,}\b/g,
	/\b(?:ghp|github_pat)_[A-Za-z0-9_]{16,}\b/g,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

export class Redactor {
	private readonly exactValues: Array<string>

	constructor(
		environment: NodeJS.ProcessEnv = process.env,
		additionalValues: Array<string> = [],
	) {
		this.exactValues = [
			...Object.entries(environment)
				.filter(([name, value]) => sensitiveNamePattern.test(name) && Boolean(value))
				.map(([, value]) => value as string),
			...additionalValues,
		]
			.filter(value => value.length >= 6)
			.filter((value, index, values) => values.indexOf(value) === index)
			.sort((left, right) => right.length - left.length)
	}

	redact(value: string): string {
		let redacted = value

		for (const exactValue of this.exactValues) {
			redacted = redacted.replaceAll(exactValue, '[REDACTED]')
		}

		for (const pattern of tokenPatterns) {
			redacted = redacted.replace(pattern, '[REDACTED]')
		}

		return redacted
	}
}
