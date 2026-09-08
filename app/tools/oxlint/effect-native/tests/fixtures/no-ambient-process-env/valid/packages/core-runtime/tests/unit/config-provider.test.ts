// B2 target shape: a map-backed ConfigProvider test Layer instead of environment mutation.
import { Config, ConfigProvider, Effect, Layer } from "effect";

const TestConfigLayer = Layer.setConfigProvider(
	ConfigProvider.fromMap(
		new Map([
			["DATABASE_URL", "postgres://localhost/ontos_test"],
			["NODE_ENV", "test"],
		]),
	),
);

export const readDatabaseUrl = Effect.gen(function* () {
	return yield* Config.string("DATABASE_URL");
}).pipe(Effect.provide(TestConfigLayer));
