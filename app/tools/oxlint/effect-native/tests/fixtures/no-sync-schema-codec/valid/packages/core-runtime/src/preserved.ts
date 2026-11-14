// Audit "Existing patterns to preserve" and D tier: none of these are this rule's business.
import { Effect, Layer, Schema } from 'effect';
import { HttpApiSchema } from 'effect/unstable/httpapi';

/** Outbox payloads already use `Schema.Json` + Drizzle JSONB correctly. */
export const OutboxPayloadSchema = Schema.Struct({ payload: Schema.Json });

/** HttpApi-driven serialization stays as it is. */
export const ProblemSchema = Schema.Struct({ status: Schema.Number }).annotate(HttpApiSchema.annotations({}));

export const RuntimeLayer = Layer.empty;

/** `Layer.orDie` at a deliberate outer startup boundary, typed cause logged first. */
export const bootstrap = Effect.gen(function* () {
	yield* Effect.logInfo('starting');
	return yield* Effect.void;
}).pipe(Effect.provide(Layer.orDie(RuntimeLayer)));

/** Native array operations where Effect collection APIs add no semantic value. */
export const ids = ['b', 'a'].map((value) => value.toUpperCase()).sort();

/** Single outer process seam. */
export const main = (): Promise<void> => Effect.runPromise(bootstrap.pipe(Effect.asVoid));
