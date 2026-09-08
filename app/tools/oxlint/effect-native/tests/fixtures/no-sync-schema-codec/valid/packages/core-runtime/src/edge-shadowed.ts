// Every `Schema` / barrel reference here resolves to a local binding, not to the Effect import.
import { Schema } from 'effect';
import * as EffectNs from 'effect';

export const IdSchema = Schema.String;
export const BarrelString = EffectNs.Schema.String;

export function decodeWithLocalClass(value: unknown): string {
	class Schema {
		static decodeUnknownSync(input: unknown): string {
			return String(input);
		}
	}
	return Schema.decodeUnknownSync(value);
}

export function decodeInCatch(value: unknown): string {
	try {
		return String(value);
	} catch (Schema: any) {
		return Schema.decodeUnknownSync(value);
	}
}

export const decodeWithLocalBarrel = (
	EffectNs: { readonly Schema: { readonly decodeUnknownSync: (value: unknown) => string } },
	value: unknown,
): string => EffectNs.Schema.decodeUnknownSync(value);

export const decodeFromNested = (config: {
	readonly Schema: { readonly encodeSync: (value: unknown) => string };
}): string => config.Schema.encodeSync('raw');
