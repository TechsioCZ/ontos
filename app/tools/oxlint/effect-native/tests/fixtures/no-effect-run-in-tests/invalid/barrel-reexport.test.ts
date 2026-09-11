// expect-count: 2
import { Effect, Layer } from "@modern-js/bff-effect/effect-edge";

declare const program: Effect.Effect<string>;
declare const it: (name: string, body: () => Promise<void>) => void;
declare const BffLayer: Layer.Layer<never>;

it("drives the BFF", async () => {
	await Effect.runPromise(Effect.provide(program, BffLayer));
	Effect.runSync(program);
});
