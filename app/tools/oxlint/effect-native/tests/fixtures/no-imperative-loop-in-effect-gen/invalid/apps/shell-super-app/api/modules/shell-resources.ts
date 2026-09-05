// expect-count: 2
// Audit B1: "independent remote providers and enrichment reads are frequently sequential".
import { Effect } from "effect";

declare const provisioning: {
	readonly ensure: (action: string) => Effect.Effect<void>;
	readonly describe: (action: string) => Effect.Effect<string>;
};
declare const actions: readonly string[];

export const ensureAll = Effect.gen(function* () {
	for (const action of actions) {
		yield* provisioning.ensure(action);
	}
});

export const describeAll = Effect.gen(function* () {
	const described: string[] = [];
	for (const action of actions) {
		described.push(yield* provisioning.describe(action));
	}
	return described;
});
