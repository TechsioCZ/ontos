// expect-count: 4
import { Effect } from "effect";

/** Concise arrow body: the whole operation is one Effect.gen program. */
export const runOutboxCycle = (input: { readonly batchSize: number }) =>
	Effect.gen(function* () {
		yield* Effect.log(`claiming ${input.batchSize}`);
	});

/** `.pipe(Effect.withSpan(...))` still lacks the call-site trace and argument capture. */
export const claimBatch = (limit: number) =>
	Effect.gen(function* () {
		yield* Effect.log(`limit ${limit}`);
	}).pipe(Effect.withSpan("OutboxWorker.claimBatch"), Effect.annotateLogs({ component: "outbox" }));

/** Function declaration with a leading `const` before the lone return. */
export function deliver(id: string) {
	const normalised = id.trim();
	return Effect.gen(function* () {
		yield* Effect.log(normalised);
	});
}

/** Block-bodied arrow with a lone return. */
export const retryDelivery = (id: string, attempt: number) => {
	return Effect.gen(function* () {
		yield* Effect.log(`${id}/${attempt}`);
	});
};
