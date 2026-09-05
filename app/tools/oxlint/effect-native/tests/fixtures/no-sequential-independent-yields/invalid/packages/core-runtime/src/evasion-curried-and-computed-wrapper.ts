// expect-count: 2
// Evasion probe: curried `Effect.fn("name")(generator, ...aspects)` with trailing arguments, and a
// computed + optional-chained wrapper access (`Effect?.["fn"]("name")(...)`).
import { Effect } from "effect";

declare const outbox: { readonly pendingRows: (limit: number) => Effect.Effect<readonly string[]> };
declare const projections: { readonly snapshotFor: (id: string) => Effect.Effect<string> };

export const traced = Effect.fn("traced")(function* () {
	const pending = yield* outbox.pendingRows(10);
	const snapshot = yield* projections.snapshotFor("a");
	return { pending, snapshot };
}, Effect.withSpan("traced"));

export const computedWrapper = Effect?.["fn"]("computed")(function* () {
	const pending = yield* outbox.pendingRows(10);
	const snapshot = yield* projections.snapshotFor("a");
	return { pending, snapshot };
});
