import { loadEnvironmentFileProvider } from './environment-file-provider.ts';
import { APP_ENV_PATH } from '@app/core-runtime/workspace-environment';
import { Config, ConfigProvider, Context, Effect, Layer, Redacted, Schema } from 'effect';

const AuthConfigError = Schema.TaggedError<unknown>()('AuthConfigError', {
  reason: Schema.String,
});
type AuthConfigFailure = InstanceType<typeof AuthConfigError>;

export const ROOT_ENV_PATH = APP_ENV_PATH;

const EnvironmentKeySchema = Schema.Literals([
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_SUPPORT_USER_IDS',
  'BETTER_AUTH_TRUSTED_ORIGINS',
  'BETTER_AUTH_URL',
  'DATABASE_URL',
  'NODE_ENV',
]);
type EnvironmentKey = typeof EnvironmentKeySchema.Type;
type Environment = Readonly<Partial<Record<EnvironmentKey, string>>>;
type DecodedConfigString = Schema.Schema.Type<typeof Schema.String>;

export interface AuthConfigValue {
  readonly baseUrl: string;
  readonly connectionString: DecodedConfigString;
  readonly secret: DecodedConfigString;
  readonly secureCookies: boolean;
  readonly supportUserIds: readonly string[];
  readonly trustedOrigins: readonly string[];
}

export class AuthConfig extends Context.Service<AuthConfig, AuthConfigValue>()(
  '@app/shell-super-app/api/auth/config/AuthConfig',
) {}

const malformedConfiguration = () =>
  new AuthConfigError({
    reason: 'Better Auth configuration is missing or malformed',
  });

const unableToLoadEnvironment = () =>
  new AuthConfigError({
    reason: 'Unable to load the root authentication environment',
  });

const isHttpUrl = (url: URL): boolean => url.protocol === 'http:' || url.protocol === 'https:';

const isPostgreSqlUrl = (url: URL): boolean =>
  url.protocol === 'postgres:' || url.protocol === 'postgresql:';

const HttpUrlSchema = Schema.URLFromString.check(
  Schema.makeFilter((url) => (isHttpUrl(url) ? undefined : 'URL must use http or https')),
);
const PostgreSqlUrlSchema = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    isPostgreSqlUrl(url) ? undefined : 'URL must use the PostgreSQL protocol',
  ),
);

const authConfigSource = Config.all({
  baseUrl: Config.schema(HttpUrlSchema, 'BETTER_AUTH_URL'),
  databaseUrl: Config.redacted('DATABASE_URL'),
  nodeEnvironment: Config.string('NODE_ENV').pipe(Config.withDefault('')),
  secret: Config.redacted('BETTER_AUTH_SECRET'),
  supportUserIds: Config.schema(Schema.Trim, 'BETTER_AUTH_SUPPORT_USER_IDS').pipe(
    Config.withDefault(''),
  ),
  trustedOrigins: Config.schema(Schema.Trim, 'BETTER_AUTH_TRUSTED_ORIGINS').pipe(
    Config.withDefault(''),
  ),
});

const parseHttpOrigin = (value: string): Effect.Effect<string, AuthConfigFailure> =>
  Schema.decodeUnknownEffect(HttpUrlSchema)(value).pipe(
    Effect.catchTag('SchemaError', () => Effect.fail(malformedConfiguration())),
    Effect.map((url) => url.origin),
  );

const parseAuthConfigFromProvider = Effect.fn('AuthConfig.parseAuthConfigFromProvider')(
  function* parseConfiguration(provider: ConfigProvider.ConfigProvider) {
    const source = yield* authConfigSource
      .parse(provider)
      .pipe(Effect.catchTag('ConfigError', () => Effect.fail(malformedConfiguration())));
    const connectionString = Redacted.value(source.databaseUrl).trim();
    yield* Schema.decodeUnknownEffect(PostgreSqlUrlSchema)(connectionString).pipe(
      Effect.catchTag('SchemaError', () => Effect.fail(malformedConfiguration())),
    );
    const secret = Redacted.value(source.secret).trim();
    if (secret.length < 32) {
      return yield* malformedConfiguration();
    }

    const baseUrl = source.baseUrl.origin;
    const configuredTrustedOrigins = source.trustedOrigins
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
    const trustedOrigins = yield* Effect.forEach(
      [...new Set([baseUrl, ...configuredTrustedOrigins])],
      parseHttpOrigin,
      { concurrency: 1 },
    );
    const supportUserIds = [
      ...new Set(
        source.supportUserIds
          .split(',')
          .map((userId) => userId.trim())
          .filter((userId) => userId.length > 0),
      ),
    ];

    return {
      baseUrl,
      connectionString,
      secret,
      secureCookies:
        source.baseUrl.protocol === 'https:' || source.nodeEnvironment === 'production',
      supportUserIds,
      trustedOrigins,
    };
  },
);

const environmentProvider = (environment: Environment): ConfigProvider.ConfigProvider =>
  ConfigProvider.fromEnvRecord({
    BETTER_AUTH_SECRET: environment.BETTER_AUTH_SECRET,
    BETTER_AUTH_SUPPORT_USER_IDS: environment.BETTER_AUTH_SUPPORT_USER_IDS,
    BETTER_AUTH_TRUSTED_ORIGINS: environment.BETTER_AUTH_TRUSTED_ORIGINS,
    BETTER_AUTH_URL: environment.BETTER_AUTH_URL,
    DATABASE_URL: environment.DATABASE_URL,
    NODE_ENV: environment.NODE_ENV,
  });

export const parseAuthConfig = (
  environment: Environment,
): Effect.Effect<AuthConfigValue, AuthConfigFailure> =>
  parseAuthConfigFromProvider(environmentProvider(environment));

export interface LoadAuthConfigOptions {
  readonly environment?: Environment;
  readonly envPath?: string;
}

export const loadAuthConfig = (
  options: LoadAuthConfigOptions = {},
): Effect.Effect<AuthConfigValue, AuthConfigFailure> =>
  loadEnvironmentFileProvider(options.envPath ?? ROOT_ENV_PATH, unableToLoadEnvironment).pipe(
    Effect.flatMap((fileProvider) =>
      parseAuthConfigFromProvider(
        (options.environment === undefined
          ? ConfigProvider.fromEnv()
          : environmentProvider(options.environment)
        ).pipe(ConfigProvider.orElse(fileProvider)),
      ),
    ),
  );

export const AuthConfigLive = Layer.effect(AuthConfig, loadAuthConfig());
