import { parseDatabaseConnectionPair, parseSpiceDbConfig } from '@app/core-runtime';
import { Config, Effect, Redacted, Schema } from 'effect';

export class DemoResetConfigurationError extends Schema.TaggedError<DemoResetConfigurationError>()(
  'DemoResetConfigurationError',
  { reason: Schema.String },
) {}

export const resetEnvironment = Config.all({
  BETTER_AUTH_SECRET: Config.Redacted('BETTER_AUTH_SECRET'),
  BETTER_AUTH_URL: Config.String('BETTER_AUTH_URL'),
  DATABASE_ADMIN_URL: Config.Redacted('DATABASE_ADMIN_URL'),
  DATABASE_URL: Config.Redacted('DATABASE_URL'),
  SPICEDB_CA_CERT: Config.String('SPICEDB_CA_CERT'),
  SPICEDB_ENDPOINT: Config.String('SPICEDB_ENDPOINT'),
  SPICEDB_PRESHARED_KEY: Config.Redacted('SPICEDB_PRESHARED_KEY'),
  ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT').pipe(
    Config.withDefault('development'),
  ),
});
export type DemoResetConfiguration = Effect.Success<ReturnType<typeof resetEnvironment.parse>>;
export type DemoResetChildEnvironment = { readonly [Key in keyof DemoResetConfiguration]: string };
const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const requiredText = Schema.Trim.check(Schema.isNonEmpty());

export const validateResetEnvironment = Effect.fn('SiamparkDemo.validateLocalConfiguration')(
  function* validateLocalConfiguration(environment: DemoResetChildEnvironment) {
    yield* Schema.decodeUnknownEffect(Schema.Literal('development'))(environment.ULTRAMODERN_DEPLOYMENT_ENVIRONMENT);
    yield* Schema.decodeEffect(Schema.Trim.check(Schema.isMinLength(32)))(environment.BETTER_AUTH_SECRET);
    const pair = yield* parseDatabaseConnectionPair({
      DATABASE_ADMIN_URL: environment.DATABASE_ADMIN_URL,
      DATABASE_URL: environment.DATABASE_URL,
    });
    if (!loopbackHosts.has(pair.admin.host) || !loopbackHosts.has(pair.runtime.host)) {
      return yield* new DemoResetConfigurationError({ reason: 'Both PostgreSQL endpoints must be local' });
    }
    if (
      pair.admin.database !== 'siampark_demo' ||
      pair.runtime.database !== 'siampark_demo' ||
      pair.admin.host !== pair.runtime.host ||
      pair.admin.port !== pair.runtime.port
    ) {
      return yield* new DemoResetConfigurationError({
        reason: 'Both PostgreSQL identities must target the same local siampark_demo database',
      });
    }
    const certificate = yield* Schema.decodeEffect(requiredText)(environment.SPICEDB_CA_CERT);
    const spice = yield* parseSpiceDbConfig({
      SPICEDB_CA_CERT: certificate,
      SPICEDB_ENDPOINT: environment.SPICEDB_ENDPOINT,
      SPICEDB_PRESHARED_KEY: environment.SPICEDB_PRESHARED_KEY,
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: environment.ULTRAMODERN_DEPLOYMENT_ENVIRONMENT,
    });
    const endpoint = URL.parse(`http://${spice.endpoint}`);
    if (endpoint === null || !loopbackHosts.has(endpoint.hostname)) {
      return yield* new DemoResetConfigurationError({ reason: 'SpiceDB must be a local endpoint' });
    }
    const authOrigin = yield* Schema.decodeEffect(requiredText)(environment.BETTER_AUTH_URL);
    const auth = URL.parse(authOrigin);
    if (auth === null || auth.protocol !== 'http:' || auth.origin !== authOrigin || !loopbackHosts.has(auth.hostname)) {
      return yield* new DemoResetConfigurationError({ reason: 'BETTER_AUTH_URL must be an exact local HTTP origin' });
    }
    return yield* Effect.void;
  },
);

/** Secrets are unwrapped only for validated native subprocess configuration. */
export const resetChildEnvironment = (configuration: DemoResetConfiguration): DemoResetChildEnvironment => ({
  ...configuration,
  BETTER_AUTH_SECRET: Redacted.value(configuration.BETTER_AUTH_SECRET),
  DATABASE_ADMIN_URL: Redacted.value(configuration.DATABASE_ADMIN_URL),
  DATABASE_URL: Redacted.value(configuration.DATABASE_URL),
  SPICEDB_PRESHARED_KEY: Redacted.value(configuration.SPICEDB_PRESHARED_KEY),
});
