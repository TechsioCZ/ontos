// expect-count: 1
// Evasion probe (EXPECTED MISS): `candidateOf` requires `declarations.length === 1`, so joining the
// two independent reads into one comma-separated declaration removes the diagnostic while leaving
// the serialised program byte-for-byte equivalent.
// Fix direction: analyse each declarator of a multi-declarator declaration as its own read.
import { Effect } from "effect";

declare const gateway: { readonly loadSnapshot: (id: string) => Effect.Effect<string> };
declare const states: { readonly readStates: (id: string) => Effect.Effect<string> };

export const enrich = Effect.gen(function* () {
	const snapshot = yield* gateway.loadSnapshot("a"),
		moduleStates = yield* states.readStates("b");
	return { moduleStates, snapshot };
});
