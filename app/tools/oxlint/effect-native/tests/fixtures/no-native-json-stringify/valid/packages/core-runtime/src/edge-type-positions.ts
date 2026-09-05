// `typeof JSON.stringify` is a TSTypeQuery over a TSQualifiedName: declaring the shape stays legal.
declare const v: unknown;

export type NativeSerializer = typeof JSON.stringify;

export type NativeGlobalSerializer = typeof globalThis.JSON.stringify;

export interface SerializerBag {
	readonly serialize: typeof JSON.stringify;
}

export const registry: Record<string, typeof JSON.stringify> = {};

export const cast = v as typeof JSON.stringify;

export function identity<T extends typeof JSON.stringify>(fn: T): T {
	return fn;
}
