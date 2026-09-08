// A namespace called `Effect` that does not come from an Effect module source is not the real thing.
import { Effect } from "./tests/support/effect-double.ts";
import { Effect as RealEffect } from "effect";

declare const it: (name: string, body: () => void) => void;

it("uses a local double", () => {
	Effect.runPromise("payload");
	Effect.runSync("payload");
});

// `runtime` is not an Effect namespace either.
declare const runtime: { runPromise: <A>(effect: RealEffect.Effect<A>) => Promise<A> };
declare const program: RealEffect.Effect<string>;

export const load = (): Promise<string> => runtime.runPromise(program);
