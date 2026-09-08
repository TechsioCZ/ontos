// expect-count: 2
// Evasion probe: `as`, `satisfies` and `!` around either the whole `yield*` or the yielded subject.
import { Effect } from "effect";

declare const gateway: { readonly loadSnapshot: (id: string) => Effect.Effect<string> };
declare const states: { readonly readStates: (id: string) => Effect.Effect<string> };

export const casted = Effect.gen(function* () {
	const snapshot = (yield* gateway.loadSnapshot("a")) as string;
	const moduleStates = yield* (states.readStates("b") satisfies Effect.Effect<string>);
	return { moduleStates, snapshot };
});

export const nonNull = Effect.gen(function* () {
	const snapshot = yield* gateway.loadSnapshot("a")!;
	const moduleStates = yield* states.readStates("b")!;
	return { moduleStates, snapshot };
});
