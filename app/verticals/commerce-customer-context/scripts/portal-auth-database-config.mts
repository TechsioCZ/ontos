import { Config, ConfigProvider, Effect, Option, Redacted, Result, Schema } from 'effect';

import { loadDotEnvProvider } from '../../../packages/core-runtime/src/environment/dotenv-provider.ts';
import { APP_ENV_PATH } from '@app/core-runtime/workspace-environment';

export const COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL = 'COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL' as const;
export const COMMERCE_PORTAL_AUTH_DATABASE_URL = 'COMMERCE_PORTAL_AUTH_DATABASE_URL' as const;

export interface CommercePortalAuthDatabaseEnvironment {
  readonly COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL?: string;
  readonly COMMERCE_PORTAL_AUTH_DATABASE_URL?: string;
}

export interface LoadCommercePortalAuthDatabaseConfigOptions {
  readonly environment?: CommercePortalAuthDatabaseEnvironment;
  readonly envPath?: string;
}

export class CommercePortalAuthDatabaseConfigError extends Schema.TaggedError<CommercePortalAuthDatabaseConfigError>()(
  'CommercePortalAuthDatabaseConfigError',
  { reason: Schema.String },
) {}

export interface CommercePortalAuthDatabaseConnection {
  readonly connectionString: Redacted.Redacted;
  readonly database: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
}

export interface CommercePortalAuthDatabaseConnectionPair {
  readonly admin: CommercePortalAuthDatabaseConnection;
  readonly runtime: CommercePortalAuthDatabaseConnection;
}

const requiredConnectionString = Schema.Trim.pipe(Schema.check(Schema.isMinLength(1)));
const PostgreSqlUrlSchema = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    url.protocol === 'postgres:' || url.protocol === 'postgresql:' ? undefined : 'URL must use PostgreSQL',
  ),
);

const overriddenIdentityParameters = new Set(['db', 'database', 'dbname', 'host', 'hostaddr', 'port', 'user']);

const invalidConfiguration = (): CommercePortalAuthDatabaseConfigError =>
  new CommercePortalAuthDatabaseConfigError({
    reason: 'Commerce portal authentication database configuration is missing or malformed',
  });

const failInvalidConfiguration = (): never => Result.getOrThrow(Result.fail(invalidConfiguration()));

const readConnection = Effect.fn('CommercePortalAuthDatabaseConfig.readConnection')(function* readConnectionEffect(
  provider: ConfigProvider.ConfigProvider,
  configKey: typeof COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL | typeof COMMERCE_PORTAL_AUTH_DATABASE_URL,
): Effect.fn.Return<CommercePortalAuthDatabaseConnection, CommercePortalAuthDatabaseConfigError> {
  const configured = yield* Config.schema(Schema.Redacted(requiredConnectionString), configKey)
    .parse(provider)
    .pipe(Effect.mapError(() => invalidConfiguration()));
  const connectionString = Redacted.make(Redacted.value(configured).trim());
  const parsed = yield* Schema.decodeEffect(PostgreSqlUrlSchema)(Redacted.value(connectionString)).pipe(
    Effect.mapError(() => invalidConfiguration()),
  );
  const decoded = yield* Effect.try({
    catch: () => invalidConfiguration(),
    try: () => ({
      authorityUser: decodeURIComponent(parsed.username),
      database: decodeURIComponent(parsed.pathname.replace(/^\/+/u, '')),
    }),
  });
  if ([...parsed.searchParams.keys()].some((parameter) => overriddenIdentityParameters.has(parameter.toLowerCase()))) {
    return yield* invalidConfiguration();
  }
  const host = parsed.hostname;
  const port = parsed.port.length === 0 ? 5432 : Math.trunc(Number(parsed.port));
  const user = decoded.authorityUser;

  if (
    host.length === 0 ||
    decoded.database.length === 0 ||
    user.length === 0 ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    return yield* invalidConfiguration();
  }

  return Object.freeze({
    connectionString,
    database: decoded.database,
    host,
    port,
    user,
  });
});

const readConnectionPair = Effect.fn('CommercePortalAuthDatabaseConfig.readConnectionPair')(function* readPairEffect(
  provider: ConfigProvider.ConfigProvider,
): Effect.fn.Return<CommercePortalAuthDatabaseConnectionPair, CommercePortalAuthDatabaseConfigError> {
  const [runtime, admin] = yield* Effect.all(
    [
      readConnection(provider, COMMERCE_PORTAL_AUTH_DATABASE_URL),
      readConnection(provider, COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL),
    ],
    { concurrency: 1 },
  );

  if (
    Redacted.value(admin.connectionString) === Redacted.value(runtime.connectionString) ||
    admin.user === runtime.user ||
    admin.database !== runtime.database ||
    admin.host !== runtime.host ||
    admin.port !== runtime.port
  ) {
    return yield* new CommercePortalAuthDatabaseConfigError({
      reason:
        'Commerce portal authentication administrative and runtime identities must be distinct and target one database',
    });
  }

  return Object.freeze({ admin, runtime });
});

const optionalConnectionKeys = Config.all({
  admin: Config.option(Config.redacted(COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL)),
  runtime: Config.option(Config.redacted(COMMERCE_PORTAL_AUTH_DATABASE_URL)),
});

const parseOptionalWith = Effect.fn('CommercePortalAuthDatabaseConfig.parseOptional')(function* parseOptionalEffect(
  provider: ConfigProvider.ConfigProvider,
): Effect.fn.Return<Option.Option<CommercePortalAuthDatabaseConnectionPair>, CommercePortalAuthDatabaseConfigError> {
  const configured = yield* optionalConnectionKeys.parse(provider).pipe(Effect.mapError(() => invalidConfiguration()));
  const adminConfigured = Option.isSome(configured.admin) ? Redacted.value(configured.admin.value).trim() : undefined;
  const runtimeConfigured = Option.isSome(configured.runtime)
    ? Redacted.value(configured.runtime.value).trim()
    : undefined;

  if (adminConfigured === undefined && runtimeConfigured === undefined) {
    return Option.none();
  }
  if (
    adminConfigured === undefined ||
    runtimeConfigured === undefined ||
    adminConfigured.length === 0 ||
    runtimeConfigured.length === 0
  ) {
    return yield* new CommercePortalAuthDatabaseConfigError({
      reason: 'Commerce portal authentication requires both administrative and runtime database URLs',
    });
  }

  return yield* readConnectionPair(
    ConfigProvider.fromUnknown(
      {
        [COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL]: adminConfigured,
        [COMMERCE_PORTAL_AUTH_DATABASE_URL]: runtimeConfigured,
      },
      { preserveEmptyStrings: true },
    ),
  ).pipe(Effect.map(Option.some));
});

const loadWorkspaceProvider = (envPath: string) => loadDotEnvProvider(envPath, () => invalidConfiguration());

const providerFor = (options: LoadCommercePortalAuthDatabaseConfigOptions) => {
  const environmentProvider =
    options.environment === undefined
      ? ConfigProvider.fromEnv({ preserveEmptyStrings: true })
      : ConfigProvider.fromUnknown(options.environment, { preserveEmptyStrings: true });
  return loadWorkspaceProvider(options.envPath ?? APP_ENV_PATH).pipe(
    Effect.map((fileProvider) => ConfigProvider.orElse(environmentProvider, fileProvider)),
  );
};

/**
 * Drizzle Kit loads configuration synchronously. Keep this adapter at the operator config
 * boundary, and resolve the workspace file only when the portal-auth migration config is loaded.
 * The runtime URL is intentionally never considered here.
 */
export const readCommercePortalAuthDatabaseAdminUrlForDrizzle = (): Redacted.Redacted => {
  const nodeFileSystem = process.getBuiltinModule('node:fs');
  const nodeProcess = process.getBuiltinModule('node:process');
  const nodeUtilities = process.getBuiltinModule('node:util');

  const fileConfiguration = nodeFileSystem.existsSync(APP_ENV_PATH)
    ? Result.getOrThrow(Result.try(() => nodeUtilities.parseEnv(nodeFileSystem.readFileSync(APP_ENV_PATH, 'utf-8'))))
    : {};
  const value = { ...fileConfiguration, ...nodeProcess.env }[COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL];
  const decoded = Schema.decodeUnknownResult(Schema.RedactedFromValue(requiredConnectionString))(value);
  if (Result.isFailure(decoded)) {
    return failInvalidConfiguration();
  }

  const connectionString = Redacted.value(decoded.success).trim();
  const parsed = Schema.decodeUnknownResult(PostgreSqlUrlSchema)(connectionString);
  if (Result.isFailure(parsed)) {
    return failInvalidConfiguration();
  }

  if (
    [...parsed.success.searchParams.keys()].some((parameter) =>
      overriddenIdentityParameters.has(parameter.toLowerCase()),
    )
  ) {
    return failInvalidConfiguration();
  }
  const decodedIdentity = Result.getOrThrow(
    Result.try(() => ({
      authorityUser: decodeURIComponent(parsed.success.username),
      database: decodeURIComponent(parsed.success.pathname.replace(/^\/+/u, '')),
    })),
  );
  const port = parsed.success.port.length === 0 ? 5432 : Math.trunc(Number(parsed.success.port));
  if (
    parsed.success.hostname.length === 0 ||
    decodedIdentity.authorityUser.length === 0 ||
    decodedIdentity.database.length === 0 ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    return failInvalidConfiguration();
  }

  return Redacted.make(connectionString);
};

export const parseCommercePortalAuthDatabaseAdminConfig = (
  environment: CommercePortalAuthDatabaseEnvironment,
): Effect.Effect<CommercePortalAuthDatabaseConnection, CommercePortalAuthDatabaseConfigError> =>
  readConnection(
    ConfigProvider.fromUnknown(environment, { preserveEmptyStrings: true }),
    COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL,
  );

export const parseCommercePortalAuthDatabaseConfig = (
  environment: CommercePortalAuthDatabaseEnvironment,
): Effect.Effect<CommercePortalAuthDatabaseConnectionPair, CommercePortalAuthDatabaseConfigError> =>
  readConnectionPair(ConfigProvider.fromUnknown(environment, { preserveEmptyStrings: true }));

export const parseOptionalCommercePortalAuthDatabaseConfig = (
  environment: CommercePortalAuthDatabaseEnvironment,
): Effect.Effect<Option.Option<CommercePortalAuthDatabaseConnectionPair>, CommercePortalAuthDatabaseConfigError> =>
  parseOptionalWith(ConfigProvider.fromUnknown(environment, { preserveEmptyStrings: true }));

export const loadCommercePortalAuthDatabaseConfig = (
  options: LoadCommercePortalAuthDatabaseConfigOptions = {},
): Effect.Effect<CommercePortalAuthDatabaseConnectionPair, CommercePortalAuthDatabaseConfigError> =>
  providerFor(options).pipe(Effect.flatMap(readConnectionPair));

export const loadOptionalCommercePortalAuthDatabaseConfig = (
  options: LoadCommercePortalAuthDatabaseConfigOptions = {},
): Effect.Effect<Option.Option<CommercePortalAuthDatabaseConnectionPair>, CommercePortalAuthDatabaseConfigError> =>
  providerFor(options).pipe(Effect.flatMap(parseOptionalWith));
