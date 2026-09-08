// expect-count: 2
import { Effect } from "effect";

/**
 * `type` / `interface` statements are erased at runtime, so these bodies are byte-for-byte the same
 * program as the `allowLeadingConstants` fixtures in `outbox/worker.ts`.
 */
export const deliver = (id: string) => {
	type Delivered = { readonly id: string };
	const payload: Delivered = { id };
	return Effect.gen(function* () {
		yield* Effect.log(payload.id);
	});
};

export function claim(limit: number) {
	interface Claim {
		readonly limit: number;
	}
	const request: Claim = { limit };
	return Effect.gen(function* () {
		yield* Effect.log(String(request.limit));
	});
}
