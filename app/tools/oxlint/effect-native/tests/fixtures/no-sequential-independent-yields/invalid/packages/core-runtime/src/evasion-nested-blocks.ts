// expect-count: 3
// Evasion probe: independent reads buried in a `try` block, a braced `switch` case and a bare
// `default:` consequent must all be analysed.
import { Effect } from "effect";

declare const outbox: { readonly pendingRows: (id: string) => Effect.Effect<readonly string[]> };
declare const projections: { readonly snapshotFor: (id: string) => Effect.Effect<string> };

export const poll = (kind: string) =>
	Effect.gen(function* () {
		try {
			const pending = yield* outbox.pendingRows("try");
			const snapshot = yield* projections.snapshotFor("try");
			return { pending, snapshot };
		} finally {
			switch (kind) {
				case "braced": {
					const pending = yield* outbox.pendingRows("braced");
					const snapshot = yield* projections.snapshotFor("braced");
					return { pending, snapshot };
				}
				default: {
					const pending = yield* outbox.pendingRows("default");
					const snapshot = yield* projections.snapshotFor("default");
					return { pending, snapshot };
				}
			}
		}
	});
