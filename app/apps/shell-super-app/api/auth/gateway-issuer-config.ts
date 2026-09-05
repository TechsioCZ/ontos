// @effect-diagnostics processEnv:off
import { config as loadDotenv } from 'dotenv';
import { Effect, Predicate, Result, Schema } from 'effect';
import { ROOT_ENV_PATH } from './config.ts';

const withOptionalProperty = <
  Base extends object,
  Key extends PropertyKey,
  Value,
  Trailing extends object,
>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

export class GatewayIssuerConfigError extends Schema.TaggedError<GatewayIssuerConfigError>()(
  'GatewayIssuerConfigError',
  { reason: Schema.String },
) {}

type Environment = Readonly<Record<string, string | undefined>>;

export interface Ed25519PrivateJwk {
  readonly alg: 'EdDSA';
  readonly crv: 'Ed25519';
  readonly d: string;
  readonly key_ops?: string[];
  readonly kid: string;
  readonly kty: 'OKP';
  readonly use: 'sig';
  readonly x: string;
}

export interface GatewayIssuerConfigValue {
  readonly issuer: string;
  readonly privateJwk: Ed25519PrivateJwk;
}

const PrivateJwkInputSchema = Schema.Struct({
  alg: Schema.Literal('EdDSA'),
  crv: Schema.Literal('Ed25519'),
  d: Schema.String,
  key_ops: Schema.optional(Schema.Array(Schema.String)),
  kid: Schema.String,
  kty: Schema.Literal('OKP'),
  use: Schema.Literal('sig'),
  x: Schema.String,
});

const isBase64Url = <Value>(value: Value): value is Value & string =>
  Predicate.isString(value) && value.length > 0 && /^[A-Za-z0-9_-]+$/u.test(value);

const malformedGatewayIssuerConfig = () =>
  new GatewayIssuerConfigError({
    reason: 'Gateway signing configuration is missing or malformed',
  });

const parsePrivateJwk = (
  encoded: string,
): Effect.Effect<Ed25519PrivateJwk, GatewayIssuerConfigError> =>
  Effect.gen(function* parsePrivateJwkEffect() {
    const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(PrivateJwkInputSchema))(
      encoded,
    );
    if (Result.isFailure(decoded)) {
      return yield* malformedGatewayIssuerConfig();
    }

    const parsed = decoded.success;
    if (!isBase64Url(parsed.kid) || !isBase64Url(parsed.x) || !isBase64Url(parsed.d)) {
      return yield* malformedGatewayIssuerConfig();
    }
    const keyOperations = parsed.key_ops;
    if (
      keyOperations !== undefined &&
      (!Array.isArray(keyOperations) || keyOperations.length !== 1 || keyOperations[0] !== 'sign')
    ) {
      return yield* malformedGatewayIssuerConfig();
    }

    const privateJwk: Ed25519PrivateJwk = withOptionalProperty(
      {
        alg: 'EdDSA' as const,
        crv: 'Ed25519' as const,
        d: parsed.d,
      },
      keyOperations !== undefined,
      'key_ops',
      ['sign'],
      {
        kid: parsed.kid,
        kty: 'OKP' as const,
        use: 'sig' as const,
        x: parsed.x,
      },
    );
    return privateJwk;
  });

export const parseGatewayIssuerConfig = (
  environment: Environment,
): Effect.Effect<GatewayIssuerConfigValue, GatewayIssuerConfigError> =>
  Effect.gen(function* parseGatewayIssuerConfigEffect() {
    const issuer = environment['ONTOS_GATEWAY_ISSUER']?.trim();
    const encodedJwk = environment['ONTOS_GATEWAY_PRIVATE_JWK']?.trim();
    if (issuer === undefined || issuer.length === 0 || encodedJwk === undefined) {
      return yield* malformedGatewayIssuerConfig();
    }

    if (!URL.canParse(issuer)) {
      return yield* malformedGatewayIssuerConfig();
    }
    const issuerUrl = new URL(issuer);
    if (issuerUrl.protocol !== 'http:' && issuerUrl.protocol !== 'https:') {
      return yield* malformedGatewayIssuerConfig();
    }

    return {
      issuer,
      privateJwk: yield* parsePrivateJwk(encodedJwk),
    };
  });

export interface LoadGatewayIssuerConfigOptions {
  readonly environment?: Environment;
  readonly envPath?: string;
}

export const loadGatewayIssuerConfig = (
  options: LoadGatewayIssuerConfigOptions = {},
): Effect.Effect<GatewayIssuerConfigValue, GatewayIssuerConfigError> =>
  Effect.sync(() => {
    const fileEnvironment: Record<string, string> = {};
    const result = loadDotenv({
      path: options.envPath ?? ROOT_ENV_PATH,
      processEnv: fileEnvironment,
      quiet: true,
    });
    return {
      dotenvError: result.error,
      environment: { ...fileEnvironment, ...(options.environment ?? process.env) },
    };
  }).pipe(
    Effect.flatMap(({ dotenvError, environment }) => {
      const dotenvErrorCode: string | undefined = dotenvError?.code;
      return dotenvError !== undefined &&
        dotenvErrorCode !== 'ENOENT' &&
        dotenvErrorCode !== 'NOT_FOUND_DOTENV_ENVIRONMENT'
        ? Effect.die(dotenvError)
        : Effect.succeed(environment);
    }),
    Effect.flatMap(parseGatewayIssuerConfig),
  );
