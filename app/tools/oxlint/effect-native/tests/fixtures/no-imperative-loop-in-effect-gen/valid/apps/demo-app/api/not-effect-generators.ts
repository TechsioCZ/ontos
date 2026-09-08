// Generators that are not `Effect.gen` bodies: a bare exported generator and a look-alike
// `saga.gen` wrapper. `Effect` is imported in this file, so the rule is active — it must still
// refuse to claim these.
import { Effect } from "effect";

declare const actions: readonly string[];
declare const handle: (action: string) => Generator<unknown, void>;
declare const probe: Effect.Effect<void>;

export function* watcher(): Generator<unknown, void> {
	for (const action of actions) {
		yield* handle(action);
	}
}

const saga = { gen: (body: unknown) => body };

export const watcherSaga = saga.gen(function* () {
	for (const action of actions) {
		yield* handle(action);
	}
});

export const stillEffect = Effect.runPromise(probe);
