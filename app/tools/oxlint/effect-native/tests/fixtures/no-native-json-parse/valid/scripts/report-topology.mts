import { Effect, Schema } from "effect";

const Report = Schema.Struct({ ok: Schema.Boolean });

// Scripts are in scope for the rule, and this one decodes instead of parsing.
export const program = (text: string) =>
	Effect.gen(function* () {
		return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Report))(text);
	});
