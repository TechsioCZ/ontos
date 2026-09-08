// expect-count: 3
// Root namespace import (`E.Effect.gen`) and a direct member import (`import { gen } from
// "effect/Effect"`) are the same generator wrapper.
import * as E from "effect";
import { gen } from "effect/Effect";

declare const step: (id: string) => E.Effect.Effect<void>;
declare const ids: readonly string[];

export const viaRootNamespace = E.Effect.gen(function* () {
	for (const id of ids) {
		yield* step(id);
	}
});

export const viaDirectMember = gen(function* () {
	let total = 0;
	for (const id of ids) {
		total += 1;
		yield* step(id);
	}
	return total;
});
