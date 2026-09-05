// Regression guard: every way the second read can consume the first — a computed index, an object
// shorthand property, a closure body, a template literal, an array-pattern binding — is a genuine
// data dependency and must stay silent.
import { Effect } from "effect";

declare const gateway: { readonly loadSnapshot: (id: string) => Effect.Effect<{ readonly key: string }> };
declare const states: { readonly readStates: (value: unknown) => Effect.Effect<string> };
declare const table: Record<string, string>;

export const viaComputedIndex = Effect.gen(function* () {
	const { key } = yield* gateway.loadSnapshot("a");
	const moduleStates = yield* states.readStates(table[key]);
	return { key, moduleStates };
});

export const viaShorthand = Effect.gen(function* () {
	const snapshot = yield* gateway.loadSnapshot("a");
	const moduleStates = yield* states.readStates({ snapshot });
	return { moduleStates, snapshot };
});

export const viaClosure = Effect.gen(function* () {
	const snapshot = yield* gateway.loadSnapshot("a");
	const moduleStates = yield* states.readStates(() => snapshot.key);
	return { moduleStates, snapshot };
});

export const viaTemplate = Effect.gen(function* () {
	const [snapshot] = yield* gateway.loadSnapshot("a") as never;
	const moduleStates = yield* states.readStates(`snapshot-${String(snapshot)}`);
	return { moduleStates, snapshot };
});
