// expect-count: 3
// A run call inside a `.catch()` attached to another run call is a sibling, not a nested re-entry,
// so the nested-site suppression must not swallow it.
import { Effect } from "effect";

declare const program: Effect.Effect<string>;
declare const fallback: Effect.Effect<string>;
declare const it: (name: string, body: () => Promise<void>) => void;

it("chains", async () => {
	await Effect.runPromise(program).catch(() => Effect.runSync(fallback));
	await Effect.runPromise?.(program);
});
