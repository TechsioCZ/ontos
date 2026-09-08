// A3 target shape: one root ConfigProvider, values read through Config / Config.schema.
import { Config, ConfigProvider, Effect, Layer, Redacted, Schema } from 'effect';

export const DatabaseConfig = Schema.Struct({
  url: Schema.String,
  password: Schema.Redacted(Schema.String),
});

export const databaseConfig = Config.schema(DatabaseConfig, 'DATABASE');

export const ApplicationConfigProviderLive = Layer.setConfigProvider(
  ConfigProvider.fromEnv().pipe(ConfigProvider.orElse(() => ConfigProvider.fromMap(new Map()))),
);

export const program = Effect.gen(function* () {
  const database = yield* databaseConfig;
  return Redacted.value(database.password);
});
