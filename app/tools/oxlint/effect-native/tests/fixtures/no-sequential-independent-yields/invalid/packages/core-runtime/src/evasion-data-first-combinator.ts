// expect-count: 2
// Evasion probe (EXPECTED MISS): the rule peels `x.pipe(Effect.withSpan(...))` and
// `pipe(x, Effect.timeout(...))`, but not the data-first form of the identical program,
// `Effect.withSpan(x, ...)`. Since `Effect.*` is the outermost callee the statement is rejected as
// "an effect combinator", so wrapping every read in a span or a log annotation — 14 `Effect.withSpan`
// and 40 `Effect.annotateLogs` occurrences on tracked src — silences audit B1 entirely.
// Fix direction: when the pipe-unwrapped subject is a data-first `effect` combinator call, re-enter
// its first argument before deciding the shape (`Effect.all`'s first argument is an ArrayExpression,
// so the target shape stays silent).
import { Effect } from "effect";

declare const outbox: { readonly pendingRows: (id: string) => Effect.Effect<readonly string[]> };
declare const projections: { readonly snapshotFor: (id: string) => Effect.Effect<string> };
declare const leases: { readonly readLease: (id: string) => Effect.Effect<string> };

export const poll = Effect.gen(function* () {
	const pending = yield* Effect.withSpan(outbox.pendingRows("a"), "pending");
	const snapshot = yield* Effect.annotateLogs(projections.snapshotFor("a"), { step: "snapshot" });
	const lease = yield* Effect.timeout(leases.readLease("a"), "2 seconds");
	return { lease, pending, snapshot };
});
