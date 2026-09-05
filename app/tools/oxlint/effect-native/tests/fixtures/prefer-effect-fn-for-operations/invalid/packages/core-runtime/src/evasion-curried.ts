// expect-count: 1
import { Effect } from "effect";

declare const repository: { readonly url: string };

/** Only the inner operation returns a bare `Effect.gen`; the outer factory returns a function. */
export const makeFind =
	(deps: typeof repository) =>
	(id: string) =>
		Effect.gen(function* () {
			yield* Effect.log(`${deps.url}/${id}`);
		});
