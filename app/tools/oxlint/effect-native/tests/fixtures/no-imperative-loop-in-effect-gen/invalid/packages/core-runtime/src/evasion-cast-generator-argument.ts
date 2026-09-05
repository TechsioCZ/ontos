// expect-count: 2
// The rule's `unwrap()` already strips `as` / `satisfies`, but only on the callee. A TS cast around
// the generator *argument* must not hide the B1 loop.
import { Effect } from "effect";

declare const actions: readonly string[];
declare const ensure: (action: string) => Effect.Effect<void>;

export const viaAs = Effect.gen((function* () {
	for (const action of actions) {
		yield* ensure(action);
	}
}) as () => Generator<unknown, void>);

export const viaSatisfies = Effect.fnUntraced((function* () {
	for (const action of actions) {
		yield* ensure(action);
	}
}) satisfies () => Generator<unknown, void>);
