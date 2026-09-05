// Package-local `scripts/` directories are treated the same way.
import { Effect } from "effect";

declare const seeds: readonly string[];
declare const seed: (value: string) => Effect.Effect<void>;

export const program = Effect.gen(function* () {
	for (const value of seeds) {
		yield* seed(value);
	}
});
