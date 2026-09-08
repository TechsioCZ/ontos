// Every `JSON` here is a real value-space binding, so the ambient global is never touched.
// This also guards the type-space fix from over-correcting: a *value* import alias named
// `JSON` must stay silent.
import { Contact as JSON } from "./contact-values.ts";

declare const s: string;

export const fromValueImport = JSON.parse(s);

export function fromCatch() {
	try {
		return 1;
	} catch (JSON) {
		return (JSON as { parse: (t: string) => unknown }).parse(s);
	}
}

export function fromLoop(list: ReadonlyArray<{ parse: (t: string) => unknown }>) {
	for (const JSON of list) return JSON.parse(s);
	return undefined;
}

export function fromLocalClass() {
	class JSON {
		static parse(text: string) {
			return text;
		}
	}
	return JSON.parse(s);
}

export function fromWindowParameter(window: { JSON: { parse: (t: string) => unknown } }) {
	return window.JSON.parse(s);
}

export function fromGlobalThisParameter(globalThis: { JSON: { parse: (t: string) => unknown } }) {
	return globalThis.JSON.parse(s);
}

declare const holder: { JSON: { parse: (t: string) => unknown } };
export const fromHolder = holder.JSON.parse(s);
export const fromCastHolder = (holder as typeof holder).JSON.parse(s);
