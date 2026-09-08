// The rule's own docs bless these: "any generator whose wrapper is not an effect `Effect.gen`
// binding (a local `const Effect = { gen }` shadow ...)". `Effect` is imported here, so the rule is
// active, but neither `Effect.gen` below resolves to the import.
import { Effect } from "effect";

declare const actions: readonly string[];
declare const step: (action: string) => Generator<unknown, void>;
declare const probe: Effect.Effect<void>;

export function withLocalShadow(): unknown {
	const Effect = { gen: (body: unknown) => body };
	return Effect.gen(function* () {
		for (const action of actions) {
			yield* step(action);
		}
	});
}

export function withInjectedShadow(Effect: { readonly gen: (body: unknown) => unknown }): unknown {
	return Effect.gen(function* () {
		for (const action of actions) {
			yield* step(action);
		}
	});
}

export const stillEffect = Effect.runPromise(probe);
