// A `stringify` that is not the ambient global: imported, injected, own method, TS namespace.
import * as qs from "node:querystring";
import { stringify as toYaml } from "yaml";

declare const superjson: { readonly stringify: (value: unknown) => string };
declare const v: unknown;

export const asYaml = toYaml(v);

export const asQuery = qs.stringify({ a: "1" });

export const asSuperjson = superjson.stringify(v);

export const parsed = JSON.parse("{}");

export namespace Codec {
	export function stringify(value: unknown): string {
		return String(value);
	}
}

export const viaNamespace = Codec.stringify(v);

export class Owned {
	stringify(value: unknown): string {
		return String(value);
	}
	run(): string {
		return this.stringify(v);
	}
}
