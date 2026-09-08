import { Effect } from 'effect';

/** Type positions never execute anything. */
export type Run = typeof Effect.runSync;

export type RunPromise = typeof Effect.runPromise;

export declare const injected: typeof Effect.runFork;

export interface Ports {
	readonly run: typeof Effect.runSync;
}

export const identity = <A>(effect: Effect.Effect<A>): Effect.Effect<A> => effect;
