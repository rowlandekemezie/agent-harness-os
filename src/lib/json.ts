import { HarnessError } from './errors.js'

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function requireRecord(
	value: unknown,
	fieldName = 'value',
): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new HarnessError(
			'INVALID_ARGUMENT',
			`${fieldName} must be an object`,
		)
	}

	return value
}

export function requireString(
	value: unknown,
	fieldName: string,
	options: { minLength?: number; maxLength?: number; maxBytes?: number } = {},
): string {
	if (typeof value !== 'string') {
		throw new HarnessError(
			'INVALID_ARGUMENT',
			`${fieldName} must be a string`,
		)
	}

	const minLength = options.minLength ?? 0
	const maxLength = options.maxLength ?? Number.MAX_SAFE_INTEGER
	const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER

	if (
		value.length < minLength ||
		value.length > maxLength ||
		Buffer.byteLength(value, 'utf8') > maxBytes
	) {
		throw new HarnessError(
			'INVALID_ARGUMENT',
			`${fieldName} exceeds its character or byte bound`,
		)
	}

	return value
}

export function optionalString(
	value: unknown,
	fieldName: string,
	fallback: string,
): string {
	if (value === undefined) {
		return fallback
	}

	return requireString(value, fieldName)
}

export function optionalBoolean(
	value: unknown,
	fieldName: string,
	fallback: boolean,
): boolean {
	if (value === undefined) {
		return fallback
	}

	if (typeof value !== 'boolean') {
		throw new HarnessError(
			'INVALID_ARGUMENT',
			`${fieldName} must be a boolean`,
		)
	}

	return value
}

export function optionalInteger(
	value: unknown,
	fieldName: string,
	fallback: number,
	options: { min?: number; max?: number } = {},
): number {
	if (value === undefined) {
		return fallback
	}

	if (typeof value !== 'number' || !Number.isInteger(value)) {
		throw new HarnessError(
			'INVALID_ARGUMENT',
			`${fieldName} must be an integer`,
		)
	}

	const min = options.min ?? Number.MIN_SAFE_INTEGER
	const max = options.max ?? Number.MAX_SAFE_INTEGER

	if (value < min || value > max) {
		throw new HarnessError(
			'INVALID_ARGUMENT',
			`${fieldName} must be between ${min} and ${max}`,
		)
	}

	return value
}

export function optionalStringArray(
	value: unknown,
	fieldName: string,
	fallback: Array<string>,
): Array<string> {
	if (value === undefined) {
		return fallback
	}

	if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
		throw new HarnessError(
			'INVALID_ARGUMENT',
			`${fieldName} must be an array of strings`,
		)
	}

	return [...value]
}

export function parseJsonObject(value: string, fieldName: string): Record<string, unknown> {
	try {
		return requireRecord(JSON.parse(value), fieldName)
	} catch (error) {
		if (error instanceof HarnessError) {
			throw error
		}

		throw new HarnessError(
			'INVALID_JSON',
			`${fieldName} must contain valid JSON`,
		)
	}
}
