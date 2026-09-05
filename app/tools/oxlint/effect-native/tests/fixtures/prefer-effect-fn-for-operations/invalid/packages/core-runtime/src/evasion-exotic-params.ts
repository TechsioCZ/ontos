// expect-count: 1
import { Effect } from "effect";

/** Exercises every `parameterList` branch: object pattern with rest, array pattern, default, rest. */
export const dispatch = (
	{ tenantId, ...rest }: { readonly tenantId: string; readonly [key: string]: unknown },
	[first, second]: readonly [string, string],
	retries = 3,
	...tags: readonly string[]
) =>
	Effect.gen(function* () {
		yield* Effect.log(`${tenantId}/${first}${second}/${retries}/${tags.length}/${Object.keys(rest).length}`);
	});
