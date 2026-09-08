// expect-count: 2
// `Effect["gen"]` is recognised; a zero-substitution template literal names the same member.
import { Effect } from "effect";

declare const actions: readonly string[];
declare const ensure: (action: string) => Effect.Effect<void>;

export const viaTemplateGen = Effect[`gen`](function* () {
	for (const action of actions) {
		yield* ensure(action);
	}
});

export const viaTemplateFn = Effect[`fnUntraced`](function* () {
	for (const action of actions) {
		yield* ensure(action);
	}
});
