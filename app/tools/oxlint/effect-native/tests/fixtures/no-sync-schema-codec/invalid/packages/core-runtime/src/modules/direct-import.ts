// expect-count: 3
// Direct member imports from `effect/Schema`, including an alias and a point-free reference.
import { decodeUnknownSync, encodeUnknownSync as encodeIt, Struct, String as Str } from 'effect/Schema';

const OwnershipSchema = Struct({ owner: Str });

export const decodeOwnership = (value: unknown): { readonly owner: string } =>
	decodeUnknownSync(OwnershipSchema)(value);

export const decodeAll = (values: readonly unknown[]): readonly { readonly owner: string }[] =>
	values.map(decodeUnknownSync(OwnershipSchema));

export const encodeOwnership = (value: { readonly owner: string }): unknown => encodeIt(OwnershipSchema)(value);
