import { Effect } from "effect";

/** Unions with no value member carry nothing worth wrapping in an `Option`. */
export interface ConnectionLifecycle {
	readonly flush: () => Promise<void | undefined>;
	readonly reset: () => Promise<null | undefined>;
	readonly drain: () => Promise<never | null>;
	readonly probe: () => Effect.Effect<unknown | undefined, never>;
	readonly widen: () => Effect.Effect<any | null, never>;
	readonly close: () => Promise<void>;
	readonly shutdown: () => Effect.Effect<void, never>;
}
