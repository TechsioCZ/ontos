// The target state: every value is declared as Config and provided by one root ConfigProvider.
import { Config, ConfigProvider, Effect, Layer, Schema } from 'effect';

export const Port = Config.Int('SHELL_SUPER_APP_PORT').pipe(Config.withDefault(3020));
export const DatabaseUrl = Config.URL('DATABASE_URL');
export const Insecure = Config.Boolean('SPICEDB_INSECURE');
export const PrivateJwk = Config.schema(
  Schema.fromJsonString(Schema.Struct({ kid: Schema.String })),
  'GATEWAY_PRIVATE_JWK',
);

export const testProvider = Layer.setConfigProvider(
  ConfigProvider.fromMap(new Map([['DATABASE_URL', 'postgres://localhost:5432/app']])),
);

export const program = Effect.gen(function* () {
  const port = yield* Port;
  const insecure = yield* Insecure;
  return { insecure, port };
});
