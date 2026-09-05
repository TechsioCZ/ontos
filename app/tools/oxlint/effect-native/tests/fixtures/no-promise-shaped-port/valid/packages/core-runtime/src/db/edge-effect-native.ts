/** The target shape: everything returns Effect, nothing is async. */
import { Effect, Schema } from "effect";

export class PersistenceError extends Schema.TaggedError<PersistenceError>()("PersistenceError", {
	reason: Schema.String,
}) {}

export interface ScopedTransactionPort {
	readonly install: (id: string) => Effect.Effect<void, PersistenceError>;
	verify(id: string): Effect.Effect<boolean, PersistenceError>;
}

export const install = Effect.fn("install")(function* (id: string) {
	yield* Effect.logDebug(id);
	return id;
});

export const scopedTransaction: ScopedTransactionPort = {
	install: () => Effect.void,
	verify: () => Effect.succeed(true),
};
