// expect-count: 2
// A single-assignment local alias of the wrapper, and the `(0, fn)` sequence-callee trick.
import { Effect } from "effect";

declare const actions: readonly string[];
declare const ensure: (action: string) => Effect.Effect<void>;

const genEffect = Effect.gen;

export const viaAlias = genEffect(function* () {
	for (const action of actions) {
		yield* ensure(action);
	}
});

export const viaSequence = (0, Effect.gen)(function* () {
	for (const action of actions) {
		yield* ensure(action);
	}
});
