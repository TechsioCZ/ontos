/** The target shape: Effect-returning ports and services. */
import { Effect, Schema } from "effect";

export interface CustomerContactPersistence {
	readonly insertAll: (rows: readonly string[]) => Effect.Effect<readonly string[], PersistenceError>;
	loadAll(): Effect.Effect<readonly string[], PersistenceError>;
}

export class PersistenceError extends Schema.TaggedError<PersistenceError>()("PersistenceError", {
	reason: Schema.String,
}) {}

export const persistence: CustomerContactPersistence = {
	insertAll: (rows) => Effect.succeed(rows),
	loadAll: () => Effect.succeed([]),
};

/** Callback parameters that accept a Promise-shaped third-party continuation are not ports. */
export function withRetry(run: (attempt: number) => Promise<void>): void {
	void run;
}

/** Synchronous members are untouched. */
export const helpers = {
	normalise: (value: string) => value.trim(),
	toEffect: () => Effect.succeed(1),
};

class LocalCache {
	get(key: string): string {
		return key;
	}
}
export const cache = new LocalCache();
