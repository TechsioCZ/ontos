import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { TestClock } from "effect/testing";

import { itEffect, itLayer } from "./tests/support/effect-harness.ts";

declare const ContactsLayer: Layer.Layer<never>;
declare const resolve: (id: string) => Effect.Effect<string>;

itEffect(
	"resolves through the harness",
	Effect.gen(function* () {
		yield* TestClock.adjust("1 second");
		const value = yield* resolve("x");
		return Schema.decodeUnknownSync(Schema.String)(value);
	}),
);

itLayer("resolves with an explicit layer", ContactsLayer, resolve("y"));

// A long-lived ManagedRuntime instance is the A1 target, not an ad hoc Effect.run* entry point.
const runtime = ManagedRuntime.make(ContactsLayer);
export const load = async (id: string): Promise<string> => runtime.runPromise(resolve(id));

// A locally shadowed `Effect` is not the effect import.
export function shadowed(): string {
	const Effect = { runPromise: (value: string) => value };
	return Effect.runPromise("shadowed");
}

// Non-run members of the real namespace stay untouched.
export const composed = Effect.provide(Effect.scoped(resolve("z")), ContactsLayer);
export const runtimeEffect = Effect.runtime;

export function Panel(): JSX.Element {
	return <section>{String(composed)}</section>;
}
