import { Effect } from 'effect';
import { runSync } from 'effect/Effect';

declare const inner: Effect.Effect<number>;

/** Directly imported entry point, but used inside an Effect-owned program (S1, not A1). */
export const program = Effect.gen(function* () {
	return runSync(inner);
});

/** A property key that merely shares the imported name must never be reported. */
export const table = { runSync: 1 };
