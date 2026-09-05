// Crash probe: an `async function*` handed to `Effect.gen` is not a valid Effect generator, but it
// must be traversed without throwing.
import { Effect } from "effect";

declare const outbox: { readonly pendingRows: (id: string) => Promise<readonly string[]> };
declare const projections: { readonly snapshotFor: (id: string) => Promise<string> };

export const poll = Effect.gen(async function* () {
	const pending = yield* ((await outbox.pendingRows("a")) as never);
	const snapshot = yield* ((await projections.snapshotFor("a")) as never);
	return { pending, snapshot };
} as never);
