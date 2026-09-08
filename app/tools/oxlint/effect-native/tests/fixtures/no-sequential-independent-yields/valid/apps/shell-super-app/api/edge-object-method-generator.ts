// Regression guard: an object-literal generator method is not an inline argument of `Effect.gen`,
// so the rule must not treat its body as an Effect generator.
import { Effect } from "effect";

declare const gateway: { readonly loadSnapshot: (id: string) => unknown };
declare const states: { readonly readStates: (id: string) => unknown };

export const handlers = {
	*load() {
		const snapshot = yield* gateway.loadSnapshot("a");
		const moduleStates = yield* states.readStates("b");
		return { moduleStates, snapshot };
	},
};

export const ok = Effect.succeed("handlers");
