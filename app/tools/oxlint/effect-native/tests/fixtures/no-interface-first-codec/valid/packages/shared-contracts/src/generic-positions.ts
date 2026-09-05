import { Schema } from "effect";
import { Effect } from "effect";

// Parameter positions: ordinary Schema-generic code, not an authority conflict.
export const decode = (schema: Schema.Codec<unknown>) => Schema.decodeUnknownEffect(schema);

export function decodeAll<A>(schemas: ReadonlyArray<Schema.Codec<A>>): ReadonlyArray<Schema.Codec<A>> {
	return schemas;
}

// Return type position.
export function makeString(): Schema.Codec<string> {
	return Schema.String;
}

// Generic constraint position.
export type Decoded<S extends Schema.Top> = S["Type"];

// Container annotations: the declarator's own type is `ReadonlyMap`, not a codec.
export const registry: ReadonlyMap<string, Schema.Codec<unknown>> = new Map();
export const list: ReadonlyArray<Schema.Codec<unknown>> = [];
export const arrayForm: readonly Schema.Codec<unknown>[] = [];

// Widening / erasure annotations carry no prior interface.
export const anySchema: Schema.Codec<unknown> = Schema.String;
export const topSchema: Schema.Top = Schema.String;

// Function-typed declarator annotation.
export const run: (schema: Schema.Codec<unknown>) => void = (schema) => {
	void schema;
};

// Derived-value annotations, not Schema annotations.
export function inspect(): void {
	let parsed: Schema.Schema.Type<typeof TokenSchema>;
	parsed = { token: "x" };
	void parsed;
}

export const TokenSchema = Schema.Struct({ token: Schema.String });

// Class properties only report when the *initializer* is a Schema construction AND the annotation
// carries a prior type. A widened field, a declared field and a field fed by the caller are blessed.
export class Holder {
	readonly schema: Schema.Codec<unknown> = Schema.String;
	declare readonly declared: Schema.Codec<Token>;
	readonly injected: Schema.Codec<Token>;

	constructor(injected: Schema.Codec<Token>) {
		this.injected = injected;
	}
}

export interface Token {
	readonly token: string;
}

export const program = Effect.succeed(1);
