// Every `parse` here belongs to a local binding, an injected port, or a codec object — never the global.
interface JsonPort {
	readonly parse: (text: string) => unknown;
}

export function withPort(json: JsonPort, text: string): unknown {
	return json.parse(text);
}

export function withShadow(text: string): unknown {
	const JSON = { parse: (value: string): unknown => ({ value }) };
	return JSON.parse(text);
}

export function withParameter(JSON: JsonPort, text: string): unknown {
	const { parse } = JSON;
	return parse(text);
}

const codec = { parse: (text: string) => text.trim() };
export const trimmed = codec.parse(" x ");

// Type position only — no runtime access to the global.
export type NativeParse = typeof JSON.parse;

// Encoding, and other JSON members, are not this rule's business.
export const encoded = JSON.stringify({ ok: true });
export const container = globalThis.JSON.stringify({ ok: true });
