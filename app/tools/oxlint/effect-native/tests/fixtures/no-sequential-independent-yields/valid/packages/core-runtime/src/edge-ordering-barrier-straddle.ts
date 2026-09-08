// Documented behaviour guard: an ordering-named step (`audit.logAccess`) is a hard barrier, so the
// reads on either side of it are not compared. Adjacency is required by the rule spec.
import { Effect } from "effect";

declare const outbox: { readonly pendingRows: (id: string) => Effect.Effect<readonly string[]> };
declare const projections: { readonly snapshotFor: (id: string) => Effect.Effect<string> };
declare const audit: { readonly logAccess: (id: string) => Effect.Effect<void> };

export const poll = Effect.gen(function* () {
	const pending = yield* outbox.pendingRows("a");
	const logged = yield* audit.logAccess("a");
	const snapshot = yield* projections.snapshotFor("a");
	return { logged, pending, snapshot };
});
