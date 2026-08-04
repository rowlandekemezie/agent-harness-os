import type { CommandSpec } from '../domain/types.js'
import { HarnessError } from '../lib/errors.js'

const prohibitedArgumentPatterns: Array<RegExp> = [
	/(^|\s)--?prefix(?:=|\s)/i,
	/(^|\s)--?global(?:=|\s|$)/i,
	/(^|\s)--?location=global(?:\s|$)/i,
	/(^|\s)--?unsafe-perm(?:=|\s|$)/i,
]

const prohibitedScriptPattern = /(?:^|:)(?:deploy|publish|release|migrate|migration|seed|destroy|production|prod)(?:$|:)/i

const prohibitedPackageManagerActions = new Set([
	'add',
	'install',
	'i',
	'remove',
	'uninstall',
	'update',
	'upgrade',
	'publish',
	'login',
	'logout',
	'config',
	'set',
	'exec',
	'dlx',
])

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
			const action = getPackageManagerAction(specification)

			if (action !== null && prohibitedPackageManagerActions.has(action)) {
				throw new HarnessError(
					'PACKAGE_MUTATION_DENIED',
					`Package manager action is prohibited: ${specification.command} ${action}`,
				)
			}

			const scriptName = getRunScriptName(specification)

			if (scriptName !== null && prohibitedScriptPattern.test(scriptName)) {
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
	const firstArgument = specification.args.find(argument => !argument.startsWith('-'))

	if (firstArgument === undefined) {
		return null
	}

	if (specification.command === 'npm' && firstArgument === 'run') {
		return null
	}

	if (
		(specification.command === 'pnpm' ||
			specification.command === 'yarn' ||
			specification.command === 'bun') &&
		firstArgument === 'run'
	) {
		return null
	}

	return firstArgument
}

function getRunScriptName(specification: CommandSpec): string | null {
	const runIndex = specification.args.findIndex(argument => argument === 'run' || argument === 'run-script')

	if (runIndex < 0) {
		return null
	}

	return specification.args[runIndex + 1] ?? null
}
