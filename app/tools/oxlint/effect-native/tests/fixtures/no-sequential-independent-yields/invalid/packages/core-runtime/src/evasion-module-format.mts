// expect-count: 1
// Evasion probe: `.mts` inside `packages/**` is application source, not a script.
import { Effect } from "effect";

declare const outbox: { readonly pendingRows: (id: string) => Effect.Effect<readonly string[]> };
declare const projections: { readonly snapshotFor: (id: string) => Effect.Effect<string> };

export const poll = Effect.gen(function* () {
	const pending = yield* outbox.pendingRows("a");
	const snapshot = yield* projections.snapshotFor("a");
	return { pending, snapshot };
});
