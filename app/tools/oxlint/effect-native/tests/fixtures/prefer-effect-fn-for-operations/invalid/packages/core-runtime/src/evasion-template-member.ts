// expect-count: 1
import { Effect } from "effect";

/** A no-substitution template literal key is exactly `Effect["gen"]`, which the rule already catches. */
export const purge = (id: string) =>
	Effect[`gen`](function* () {
		yield* Effect.log(id);
	});
