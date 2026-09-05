import { gen, runSync, tryPromise } from 'effect/Effect';

import type { Effect } from 'effect';

declare const inner: Effect.Effect<number>;
declare const database: { transaction: <A>(body: () => Promise<A>) => Promise<A> };

/**
 * A directly imported combinator owns its callback exactly like `Effect.gen(...)`: the nested run is
 * the S1 deep re-entry finding and belongs to `no-nested-effect-run`, so this rule must stay silent.
 */
export const program = gen(function* () {
	return runSync(inner);
});

export const bridge = tryPromise({
	catch: (error: unknown) => error,
	try: async () => await database.transaction(async () => runSync(inner)),
});
