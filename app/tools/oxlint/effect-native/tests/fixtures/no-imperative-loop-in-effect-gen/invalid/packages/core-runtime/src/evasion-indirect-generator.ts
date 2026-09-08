// expect-count: 2
// Extracting the generator to a named binding is the natural refactor; the loop is unchanged.
import { Effect } from "effect";

declare const actions: readonly string[];
declare const ensure: (action: string) => Effect.Effect<void>;

function* runCycle() {
	for (const action of actions) {
		yield* ensure(action);
	}
}

const drainBody = function* () {
	while (actions.length > 0) {
		yield* ensure(actions[0] ?? "");
	}
};

export const cycle = Effect.gen(runCycle);
export const drain = Effect.fnUntraced(drainBody);
