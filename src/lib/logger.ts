import { getErrorMessage } from './errors.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogContext = Record<string, unknown>

export class Logger {
	readonly component: string
	readonly minimumLevel: LogLevel

	constructor(component: string, minimumLevel: LogLevel = 'info') {
		this.component = component
		this.minimumLevel = minimumLevel
	}

	debug(message: string, context: LogContext = {}): void {
		this.write('debug', message, context)
	}

	info(message: string, context: LogContext = {}): void {
		this.write('info', message, context)
	}

	warn(message: string, context: LogContext = {}): void {
		this.write('warn', message, context)
	}

	error(message: string, error?: unknown, context: LogContext = {}): void {
		this.write('error', message, {
			...context,
			...(error === undefined ? {} : { error: getErrorMessage(error) }),
		})
	}

	private write(level: LogLevel, message: string, context: LogContext): void {
		const priorities: Record<LogLevel, number> = {
			debug: 10,
			info: 20,
			warn: 30,
			error: 40,
		}

		if (priorities[level] < priorities[this.minimumLevel]) {
			return
		}

		process.stderr.write(
			`${JSON.stringify({
				timestamp: new Date().toISOString(),
				level,
				component: this.component,
				message,
				...context,
			})}\n`,
		)
	}
}
