import { Effect, pipe } from "effect";

/**
 * Audit "Existing patterns to preserve": bare `Effect.runPromise` is acceptable at the single outer
 * process or framework adapter seam. These functions return a `Promise`, not an `Effect`, so
 * `Effect.fn('…')(function* (…) {})` is not a replacement for them and reporting them is wrong advice.
 * The data-first spelling below is already accepted; the point-free spellings must behave the same.
 */
export const POST = (request: { readonly id: string }) =>
	Effect.gen(function* () {
		yield* Effect.log(request.id);
	}).pipe(Effect.runPromise);

export const GET = (request: { readonly id: string }) =>
	pipe(
		Effect.gen(function* () {
			yield* Effect.log(request.id);
		}),
		Effect.runPromise,
	);

export const DELETE = (id: string) =>
	Effect.runPromise(
		Effect.gen(function* () {
			yield* Effect.log(id);
		}),
	);
