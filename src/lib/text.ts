export function truncateUtf8(value: string, maxBytes: number): string {
	return decodeUtf8Prefix(Buffer.from(value, 'utf8'), maxBytes)
}

export function decodeUtf8Prefix(buffer: Buffer, maxBytes: number): string {
	let end = Math.min(buffer.byteLength, Math.max(0, maxBytes))
	const decoder = new TextDecoder('utf-8', { fatal: true })

	while (end > 0) {
		try {
			return decoder.decode(buffer.subarray(0, end))
		} catch {
			end -= 1
		}
	}

	return ''
}
