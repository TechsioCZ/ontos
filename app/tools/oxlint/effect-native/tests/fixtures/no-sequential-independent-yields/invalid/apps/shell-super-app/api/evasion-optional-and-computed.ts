// expect-count: 1
// Evasion probe: optional-chained call subject (`gateway?.prepareSnapshot?.(...)`, a
// `ChainExpression`) followed by a computed accessor subject (`states["get"](...)`). Neither shape
// may hide an independent enrichment read from audit B1.
import { Effect } from "effect";

declare const gateway: { readonly prepareSnapshot?: (id: string) => Effect.Effect<string> };
declare const states: { readonly get: (id: string) => Effect.Effect<string> };

export const enrich = Effect.gen(function* () {
	const snapshot = yield* gateway?.prepareSnapshot?.("shell");
	const moduleStates = yield* states["get"]("shell");
	return { moduleStates, snapshot };
});
