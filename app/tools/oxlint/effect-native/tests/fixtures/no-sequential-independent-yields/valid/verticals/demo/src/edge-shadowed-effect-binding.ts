// Regression guard: a module-local `Effect` object shadows the real import for the rest of the file;
// its `gen` is not `effect`'s generator and must never be analysed.
import { Effect as RealEffect } from "effect";

declare const gateway: { readonly loadSnapshot: (id: string) => unknown };
declare const states: { readonly readStates: (id: string) => unknown };

const Effect = { gen: <A,>(body: () => Generator<unknown, A>) => body };

export const ok = RealEffect.succeed("shadowed");

export const program = Effect.gen(function* () {
	const snapshot = yield* gateway.loadSnapshot("a");
	const moduleStates = yield* states.readStates("b");
	return { moduleStates, snapshot };
});
