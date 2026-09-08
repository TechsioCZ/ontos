import { Effect, Schema } from "effect";

const Topology = Schema.Struct({ version: Schema.Number, modules: Schema.Array(Schema.String) });

// The A7 target: one typed step for parse + decode.
export const decodeTopology = Schema.decodeUnknownEffect(Schema.fromJsonString(Topology));

export const load = (text: string) =>
	Effect.gen(function* () {
		const topology = yield* decodeTopology(text);
		return topology.modules;
	});

// Encoding is out of scope for this rule (C1 keeps fixture stringify in D tier).
export const debug = (value: unknown) => JSON.stringify(value);
