// expect-count: 1
import { Effect } from "effect";

/** `.mts` is production source too. */
export const publish = (id: string) =>
	Effect.gen(function* () {
		yield* Effect.log(id);
	});
