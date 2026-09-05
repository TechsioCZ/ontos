// The repository-owned harness (B2 target) is the one place allowed to leave Effect.
import { ConfigProvider, Effect, Layer } from "effect";

declare const test: (name: string, body: () => Promise<void>) => void;

const TestConfig = Layer.setConfigProvider(ConfigProvider.fromMap(new Map([["APP_ENV", "test"]])));

export const itEffect = <A, E>(name: string, effect: Effect.Effect<A, E>, layer = TestConfig): void => {
	test(name, () => Effect.runPromise(Effect.scoped(Effect.provide(effect, layer)) as Effect.Effect<A>));
};

export const itLayer = <A, E, R>(
	name: string,
	layer: Layer.Layer<R>,
	effect: Effect.Effect<A, E, R>,
): void => {
	test(name, () => Effect.runPromise(Effect.scoped(Effect.provide(effect, layer)) as Effect.Effect<A>));
};
