// The A3 target shape: declared Config values, one root ConfigProvider, Redacted secrets.
import { Config, ConfigProvider, Effect, Layer, Redacted, Schema } from "effect";

const DatabaseUrl = Config.redacted("DATABASE_URL");
const PoolSize = Config.integer("DB_POOL_SIZE");
const Jwks = Config.schema(Schema.fromJsonString(Schema.Unknown), "ONTOS_GATEWAY_PUBLIC_JWKS");

export const AppConfig = Config.all({ databaseUrl: DatabaseUrl, poolSize: PoolSize, jwks: Jwks });

// Type positions are not expressions: declaring the shape of the environment stays legal.
export type Environment = typeof process.env;
export type NodeEnvironment = (typeof process.env)["NODE_ENV"];

export const program = Effect.gen(function* () {
	const config = yield* AppConfig;
	return Redacted.value(config.databaseUrl);
});

export const RootConfigLayer = Layer.setConfigProvider(ConfigProvider.fromEnv());
