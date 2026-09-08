// expect-count: 1
// `import { gen } from "effect/Effect"` is recognised; destructuring the namespace produces the
// identical bare `gen(function* ())` call shape.
import { Effect } from "effect";

declare const actions: readonly string[];
declare const ensure: (action: string) => Effect.Effect<void>;

const { gen } = Effect;

export const provisionAll = gen(function* () {
	for (const action of actions) {
		yield* ensure(action);
	}
});
