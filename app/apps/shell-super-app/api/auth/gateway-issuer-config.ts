import { loadConfigurationProvider } from './configuration-provider.ts';
import { Config, ConfigProvider, Effect, Redacted, Schema } from 'effect';

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

const EnvironmentKeySchema = Schema.Literals(['ONTOS_GATEWAY_ISSUER', 'ONTOS_GATEWAY_PRIVATE_JWK']);
type EnvironmentKey = typeof EnvironmentKeySchema.Type;
type Environment = Readonly<Partial<Record<EnvironmentKey, string>>>;

interface Ed25519PrivateJwk {
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

const Base64UrlSchema = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
);

const PrivateJwkInputSchema = Schema.Struct({
  alg: Schema.Literal('EdDSA'),
  crv: Schema.Literal('Ed25519'),
  d: Base64UrlSchema,
  key_ops: Schema.optional(
    Schema.Array(Schema.Literal('sign')).check(Schema.isLengthBetween(1, 1)),
  ),
  kid: Base64UrlSchema,
  kty: Schema.Literal('OKP'),
  use: Schema.Literal('sig'),
  x: Base64UrlSchema,
});

const malformedConfiguration = () =>
  new GatewayIssuerConfigError({
    reason: 'Gateway signing configuration is missing or malformed',
  });

const unableToLoadEnvironment = () =>
  new GatewayIssuerConfigError({
    reason: 'Unable to load the Shell gateway signing environment',
  });

const isHttpUrl = (url: URL): boolean => url.protocol === 'http:' || url.protocol === 'https:';
const HttpUrlSchema = Schema.URLFromString.check(
  Schema.makeFilter((url) => (isHttpUrl(url) ? undefined : 'URL must use http or https')),
);

const gatewayIssuerConfigSource = Config.all({
  issuer: Config.schema(Schema.Trim.check(Schema.isNonEmpty()), 'ONTOS_GATEWAY_ISSUER'),
  issuerUrl: Config.schema(HttpUrlSchema, 'ONTOS_GATEWAY_ISSUER'),
  privateJwk: Config.redacted('ONTOS_GATEWAY_PRIVATE_JWK'),
});

const parseGatewayIssuerConfigFromProvider = Effect.fn(
  'GatewayIssuerConfig.parseGatewayIssuerConfigFromProvider',
)(function* parseConfiguration(provider: ConfigProvider.ConfigProvider) {
  const source = yield* gatewayIssuerConfigSource
    .parse(provider)
    .pipe(Effect.catchTag('ConfigError', () => Effect.fail(malformedConfiguration())));
  const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PrivateJwkInputSchema))(
    Redacted.value(source.privateJwk).trim(),
  ).pipe(Effect.catchTag('SchemaError', () => Effect.fail(malformedConfiguration())));
  const privateJwk: Ed25519PrivateJwk = withOptionalProperty(
    {
      alg: 'EdDSA' as const,
      crv: 'Ed25519' as const,
      d: parsed.d,
    },
    parsed.key_ops !== undefined,
    'key_ops',
    ['sign'],
    {
      kid: parsed.kid,
      kty: 'OKP' as const,
      use: 'sig' as const,
      x: parsed.x,
    },
  );
  return { issuer: source.issuer, privateJwk };
});

export const parseGatewayIssuerConfig = (
  environment: Environment,
): Effect.Effect<GatewayIssuerConfigValue, GatewayIssuerConfigError> =>
  parseGatewayIssuerConfigFromProvider(ConfigProvider.fromEnvRecord(environment));

export interface LoadGatewayIssuerConfigOptions {
  readonly environment?: Environment;
  readonly envPath?: string;
}

export const loadGatewayIssuerConfig = (
  options: LoadGatewayIssuerConfigOptions = {},
): Effect.Effect<GatewayIssuerConfigValue, GatewayIssuerConfigError> =>
  loadConfigurationProvider(options, unableToLoadEnvironment).pipe(
    Effect.flatMap(parseGatewayIssuerConfigFromProvider),
  );
