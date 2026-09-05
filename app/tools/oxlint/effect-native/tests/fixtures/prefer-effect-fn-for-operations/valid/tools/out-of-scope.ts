import { Effect } from "effect";

/** `tools/**` is outside the rule's `include` scope. */
export const build = (id: string) =>
	Effect.gen(function* () {
		yield* Effect.log(id);
	});
