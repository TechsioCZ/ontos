// `**/tests/harness/**` is harness territory: the single owned Effect → Promise seam lives here.
import { Effect, Layer } from "effect";

declare const test: (name: string, body: () => Promise<void>) => void;

export const runInLayer = <A, E, R>(name: string, layer: Layer.Layer<R>, effect: Effect.Effect<A, E, R>): void => {
	test(name, () => Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<A>));
};
