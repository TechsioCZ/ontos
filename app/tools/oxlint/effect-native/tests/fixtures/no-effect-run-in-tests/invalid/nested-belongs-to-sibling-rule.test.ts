// expect-count: 1
import { Effect } from "effect";

declare const program: Effect.Effect<string>;
declare const it: (name: string, body: () => Promise<void>) => void;

// Only the outer entry point is reported here; the deep re-entry inside the argument is the
// territory of effect-native/no-nested-effect-run (audit S1), so this rule stays silent on it.
it("re-enters", async () => {
	await Effect.runPromise(
		Effect.sync(() => {
			return Effect.runSync(program);
		}),
	);
});
