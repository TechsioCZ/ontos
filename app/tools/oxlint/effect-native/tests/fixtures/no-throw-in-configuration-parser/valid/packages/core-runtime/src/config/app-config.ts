// The A3 target: Config/Config.schema/Redacted decoded through one root ConfigProvider. No throws.
import { Config, ConfigProvider, Effect, Layer, Redacted, Schema } from 'effect';

const Secret = Config.redacted('BETTER_AUTH_SECRET').pipe(
  Config.validate({
    message: 'BETTER_AUTH_SECRET must be at least 32 characters',
    validation: (secret) => Redacted.value(secret).length >= 32,
  }),
);
const Issuer = Config.string('ONTOS_GATEWAY_ISSUER');
const Jwks = Config.schema(Schema.fromJsonString(Schema.Unknown), 'ONTOS_GATEWAY_PUBLIC_JWKS');

export const AppConfig = Config.all({ issuer: Issuer, jwks: Jwks, secret: Secret });

export const program = Effect.gen(function* () {
  const config = yield* AppConfig;
  return Redacted.value(config.secret);
});

export const RootConfigLayer = Layer.setConfigProvider(ConfigProvider.fromEnv());

// A type position is not an expression, so describing the environment stays legal.
export type Environment = typeof process.env;
