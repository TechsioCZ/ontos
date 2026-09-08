// Only the ambient global reports: imported, injected, shadowed and type-position uses stay legal.
import { stringify } from "yaml";

declare const superjson: { readonly stringify: (value: unknown) => string };

export const asYaml = (value: unknown): string => stringify(value);

export const asSuperjson = (value: unknown): string => superjson.stringify(value);

export const withInjectedSerializer = (
	JSON: { readonly stringify: (value: unknown) => string },
	value: unknown,
): string => JSON.stringify(value);

const container = { JSON: { stringify: (value: unknown) => String(value) } };

export const viaContainer = (value: unknown): string => container.JSON.stringify(value);

export type NativeSerializer = typeof globalThis.JSON.stringify;
