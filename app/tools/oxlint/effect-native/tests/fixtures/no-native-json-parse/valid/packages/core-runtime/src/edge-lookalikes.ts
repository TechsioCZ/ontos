declare const s: string;
declare const key: string;
declare const response: { readonly json: () => Promise<unknown> };
declare const superjson: { readonly parse: (t: string) => unknown };

export const body = response.json();
export const other = superjson.parse(s);
export const count = Number.parseInt(s, 10);
export const when = Date.parse(s);
export const encoded = JSON.stringify({ ok: true });
export const encodedGlobal = globalThis.JSON.stringify({ ok: true });

// Fully dynamic key: unknowable without types, so it must never be guessed.
export const dynamic = (JSON as Record<string, unknown>)[key];

export function viaPort(json: { readonly parse: (t: string) => unknown }) {
	return json?.parse?.(s);
}

export function viaPortPattern(json: { readonly parse: (t: string) => unknown }) {
	const { parse } = json;
	return parse(s);
}

export function viaParameterPattern({ parse }: { readonly parse: (t: string) => unknown }) {
	return parse(s);
}

export type NativeParse = typeof JSON.parse;
export type NativeArgs = Parameters<typeof JSON.parse>;

// Source text that merely mentions the anti-pattern (scaffolding generators emit this).
export const template = `const topology = JSON.parse(text);`;
export const raw = String.raw`JSON.parse(${s})`;
export const literal = "JSON.parse(text)";
// JSON.parse(text) — in a comment.
