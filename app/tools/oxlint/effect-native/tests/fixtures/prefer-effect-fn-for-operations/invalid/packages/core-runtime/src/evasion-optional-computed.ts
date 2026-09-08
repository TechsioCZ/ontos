// expect-count: 1
import { Effect } from "effect";

/** Optional chaining combined with computed access. */
export const revoke = (id: string) =>
	Effect?.["gen"](function* () {
		yield* Effect.log(id);
	});
