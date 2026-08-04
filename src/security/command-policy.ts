import type { CommandSpec } from '../domain/types.js'
import { HarnessError } from '../lib/errors.js'

const prohibitedArgumentPatterns: Array<RegExp> = [
	/(^|\s)--?prefix(?:=|\s)/i,
	/(^|\s)--?global(?:=|\s|$)/i,
	/(^|\s)--?location=global(?:\s|$)/i,
	/(^|\s)--?unsafe-perm(?:=|\s|$)/i,
]

const prohibitedScriptPattern = /(?:^|:)(?:deploy|publish|release|migrate|migration|seed|destroy|production|prod)(?:$|:)/i

const allowedPackageManagerActions: Record<string, Set<string>> = {
	npm: new Set(['run', 'run-script', 'test', 't']),
	pnpm: new Set(['run', 'test']),
	yarn: new Set(['run', 'test']),
	bun: new Set(['run', 'test']),
}

export class CommandPolicy {
	private readonly allowedCommands: Set<string>

	constructor(allowedCommands: Array<string>) {
		this.allowedCommands = new Set(allowedCommands)
	}

	assertAllowed(specification: CommandSpec): void {
		if (!this.allowedCommands.has(specification.command)) {
			throw new HarnessError(
				'COMMAND_NOT_ALLOWED',
				`Command is not allowlisted: ${specification.command}`,
			)
		}

		if (
			specification.args.some(argument =>
				prohibitedArgumentPatterns.some(pattern => pattern.test(argument)),
			)
		) {
			throw new HarnessError(
				'COMMAND_ARGUMENT_DENIED',
				`Command contains a prohibited argument: ${specification.command}`,
			)
		}

		if (isPackageManager(specification.command)) {
			this.assertPackageManagerAction(specification)
		}
	}

	private assertPackageManagerAction(specification: CommandSpec): void {
		const action = getPackageManagerAction(specification)

		if (action === null) {
			return
		}

		const allowedActions = allowedPackageManagerActions[specification.command]

		if (allowedActions?.has(action) !== true) {
			throw new HarnessError(
				'PACKAGE_MUTATION_DENIED',
				`Package manager action is prohibited: ${specification.command} ${action}`,
			)
		}

		for (const scriptName of getRunScriptCandidates(specification, action)) {
			if (prohibitedScriptPattern.test(scriptName)) {
				throw new HarnessError(
					'COMMAND_SCRIPT_DENIED',
					`Potentially destructive package script is prohibited: ${scriptName}`,
				)
			}
		}
	}
}

function isPackageManager(command: string): boolean {
	return command === 'npm' || command === 'pnpm' || command === 'yarn' || command === 'bun'
}

function getPackageManagerAction(specification: CommandSpec): string | null {
	return specification.args.find(argument => !argument.startsWith('-')) ?? null
}

function getRunScriptCandidates(
	specification: CommandSpec,
	action: string,
): Array<string> {
	if (action === 'test' || action === 't') {
		return ['test']
	}

	const actionIndex = specification.args.indexOf(action)

	if (actionIndex < 0) {
		return []
	}

	return specification.args
		.slice(actionIndex + 1)
		.filter(argument => argument !== '--' && !argument.startsWith('-'))
}
