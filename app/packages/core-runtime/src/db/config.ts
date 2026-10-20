import { databaseRuntime } from '#database-runtime';
import { Config, ConfigProvider, Context, Effect, Layer, Redacted, Schema } from 'effect';

import { loadDotEnvProvider } from '../environment/dotenv-provider.ts';
import { APP_ENV_PATH } from '../environment/workspace-environment.ts';
import { DatabaseConfigError } from './config-error.ts';
import {
  PARTY_REGISTRY_REQUEST_IDENTITY,
  PARTY_REGISTRY_WORKER_IDENTITY,
  SHARED_RUNTIME_IDENTITY,
  SHELL_GATEWAY_ISSUER_IDENTITY,
} from './database-identities.ts';
import type { DatabaseIdentity, DatabaseIdentityId, DatabaseUrlKey } from './database-identities.ts';

export { DatabaseConfigError } from './config-error.ts';

export const ROOT_ENV_PATH = APP_ENV_PATH;

const requiredDatabaseUrlSchema = Schema.Trim.pipe(Schema.check(Schema.isMinLength(1)));
const invalidDatabaseUrlReason = (configKey: string): string =>
  `${configKey} must be a valid PostgreSQL connection URL`;
/** Connection parameters that would let a URL connect as a different user, server or database. */
const IDENTITY_OVERRIDE_PARAMETERS: ReadonlySet<string> = new Set([
  'db',
  'database',
  'dbname',
  'host',
  'hostaddr',
  'port',
  'user',
]);

interface DatabaseConfigFields {
  readonly connectionString: Redacted.Redacted;
  readonly database: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
}

const makeDatabaseConfigValue = (fields: DatabaseConfigFields) =>
  Object.freeze({
    get connectionString(): string {
      return Redacted.value(fields.connectionString);
    },
    database: fields.database,
    host: fields.host,
    port: fields.port,
    user: fields.user,
  });

export type DatabaseConfigValue = ReturnType<typeof makeDatabaseConfigValue>;

export interface DatabaseConnectionPair {
  readonly admin: DatabaseConfigValue;
  readonly runtime: DatabaseConfigValue;
}

export class DatabaseConfig extends Context.Service<DatabaseConfig, DatabaseConfigValue>()(
  '@app/core-runtime/db/config/DatabaseConfig',
) {}

export interface DatabaseEnvironment {
  readonly DATABASE_ADMIN_URL?: string;
  readonly DATABASE_URL?: string;
  readonly PARTY_REGISTRY_DATABASE_URL?: string;
  readonly PARTY_REGISTRY_WORKER_DATABASE_URL?: string;
  readonly SHELL_GATEWAY_ISSUER_DATABASE_URL?: string;
}

export interface LoadDatabaseConfigOptions {
  readonly environment?: DatabaseEnvironment;
  readonly envPath?: string;
  /** The runtime login to read; its URL must connect as the identity's role. */
  readonly identity: DatabaseIdentity;
}

export interface LoadDatabaseConnectionPairOptions {
  readonly environment?: DatabaseEnvironment;
  readonly envPath?: string;
  /** The runtime login to pair with the admin; defaults to the shared runtime identity. */
  readonly identity?: DatabaseIdentity;
}

/** The admin connection and one runtime connection per checked-in database identity. */
export interface DatabaseIdentityConnections {
  readonly admin: DatabaseConfigValue;
  readonly runtime: Readonly<Record<DatabaseIdentityId, DatabaseConfigValue>>;
}

export interface LoadDatabaseIdentityConnectionsOptions {
  readonly environment?: DatabaseEnvironment;
  readonly envPath?: string;
}

const configFailure = (reason: string, cause?: unknown): DatabaseConfigError =>
  new DatabaseConfigError({ cause, reason });

interface ReadDatabaseUrlOptions {
  readonly configKey: 'DATABASE_ADMIN_URL' | DatabaseUrlKey;
  readonly provider: ConfigProvider.ConfigProvider;
  /** Rejects query parameters that would override the URL's user, server or database. */
  readonly rejectIdentityOverrides?: boolean;
}

const hasValidDatabaseFields = ({
  database,
  host,
  port,
  user,
}: Omit<DatabaseConfigFields, 'connectionString'>): boolean =>
  database.length > 0 &&
  host.length > 0 &&
  Number.isSafeInteger(port) &&
  port >= 1 &&
  port <= 65_535 &&
  user.length > 0;

const readDatabaseUrl = Effect.fn('Config.readDatabaseUrl')(function* readDatabaseUrlEffect(
  options: ReadDatabaseUrlOptions,
) {
  const connectionString = yield* Config.schema(Schema.Redacted(requiredDatabaseUrlSchema), options.configKey)
    .parse(options.provider)
    .pipe(Effect.mapError((error) => configFailure(`${options.configKey} is required`, error)));
  const invalidReason = invalidDatabaseUrlReason(options.configKey);
  const parsed = yield* Schema.decodeEffect(Schema.URLFromString)(Redacted.value(connectionString)).pipe(
    Effect.mapError((error) => configFailure(invalidReason, error)),
  );

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    return yield* configFailure(invalidReason);
  }
  if (
    options.rejectIdentityOverrides === true &&
    [...parsed.searchParams.keys()].some((parameter) => IDENTITY_OVERRIDE_PARAMETERS.has(parameter.toLowerCase()))
  ) {
    return yield* configFailure(`${options.configKey} must not override its user, server or database with parameters`);
  }

  const decoded = yield* Effect.try({
    catch: (error) => configFailure(invalidReason, error),
    try: () => ({
      authorityUser: decodeURIComponent(parsed.username),
      database: decodeURIComponent(parsed.pathname.replace(/^\/+/u, '')),
    }),
  });
  const host = parsed.hostname;
  const port = parsed.port.length > 0 ? Math.trunc(Number(parsed.port)) : 5432;
  const queryUser = parsed.searchParams.getAll('user').at(-1);
  const user = queryUser === undefined || queryUser.length === 0 ? decoded.authorityUser : queryUser;

  if (!hasValidDatabaseFields({ database: decoded.database, host, port, user })) {
    return yield* configFailure(invalidReason);
  }

  return makeDatabaseConfigValue({
    connectionString,
    database: decoded.database,
    host,
    port,
    user,
  });
});

const parseDatabaseConfigWith = (provider: ConfigProvider.ConfigProvider, identity: DatabaseIdentity) =>
  readDatabaseUrl({ configKey: identity.urlKey, provider });

const readAdminDatabaseUrl = (provider: ConfigProvider.ConfigProvider, rejectIdentityOverrides = false) =>
  readDatabaseUrl({ configKey: 'DATABASE_ADMIN_URL', provider, rejectIdentityOverrides });

const parseDatabaseConnectionPairWith = Effect.fn('Config.readDatabaseConnectionPair')(
  function* readDatabaseConnectionPairEffect(provider: ConfigProvider.ConfigProvider, identity: DatabaseIdentity) {
    const [runtime, admin] = yield* Effect.all(
      [parseDatabaseConfigWith(provider, identity), readAdminDatabaseUrl(provider)],
      { concurrency: 1 },
    );

    if (
      admin.connectionString === runtime.connectionString ||
      admin.user === runtime.user ||
      runtime.user === 'postgres'
    ) {
      return yield* configFailure('Administrative and runtime PostgreSQL identities must be distinct');
    }

    return Object.freeze({ admin, runtime });
  },
);

const targetsSameDatabase = (left: DatabaseConfigValue, right: DatabaseConfigValue): boolean =>
  left.host === right.host && left.port === right.port && left.database === right.database;

const readIdentityConnection = Effect.fn('Config.readIdentityConnection')(function* readIdentityConnectionEffect(
  provider: ConfigProvider.ConfigProvider,
  admin: DatabaseConfigValue,
  identity: DatabaseIdentity,
) {
  const connection = yield* readDatabaseUrl({ configKey: identity.urlKey, provider, rejectIdentityOverrides: true });
  if (connection.user !== identity.role) {
    return yield* configFailure(`${identity.urlKey} must connect as the ${identity.role} role`);
  }
  if (!targetsSameDatabase(admin, connection)) {
    return yield* configFailure(`${identity.urlKey} must target the DATABASE_ADMIN_URL server and database`);
  }
  return connection;
});

const parseDatabaseIdentityConnectionsWith = Effect.fn('Config.readDatabaseIdentityConnections')(
  function* readDatabaseIdentityConnectionsEffect(provider: ConfigProvider.ConfigProvider) {
    const admin = yield* readAdminDatabaseUrl(provider, true);
    const read = (identity: DatabaseIdentity) => readIdentityConnection(provider, admin, identity);
    const runtime: Readonly<Record<DatabaseIdentityId, DatabaseConfigValue>> = Object.freeze({
      party_registry_request: yield* read(PARTY_REGISTRY_REQUEST_IDENTITY),
      party_registry_worker: yield* read(PARTY_REGISTRY_WORKER_IDENTITY),
      shared_runtime: yield* read(SHARED_RUNTIME_IDENTITY),
      shell_gateway_issuer: yield* read(SHELL_GATEWAY_ISSUER_IDENTITY),
    });
    const users = [admin.user, ...Object.values(runtime).map(({ user }) => user)];
    if (users.includes('postgres', 1) || new Set(users).size !== users.length) {
      return yield* configFailure('Administrative and runtime PostgreSQL identities must be distinct');
    }
    return Object.freeze({ admin, runtime });
  },
);

export const parseDatabaseConfig = (
  environment: DatabaseEnvironment,
): Effect.Effect<DatabaseConfigValue, DatabaseConfigError> =>
  parseDatabaseConfigWith(
    ConfigProvider.fromUnknown(environment, { preserveEmptyStrings: true }),
    SHARED_RUNTIME_IDENTITY,
  );

export const parseDatabaseConnectionPair = (
  environment: DatabaseEnvironment,
): Effect.Effect<DatabaseConnectionPair, DatabaseConfigError> =>
  parseDatabaseConnectionPairWith(
    ConfigProvider.fromUnknown(environment, { preserveEmptyStrings: true }),
    SHARED_RUNTIME_IDENTITY,
  );

const loadWithProvider = <Value>(
  parse: (provider: ConfigProvider.ConfigProvider) => Effect.Effect<Value, DatabaseConfigError>,
  options: LoadDatabaseIdentityConnectionsOptions,
): Effect.Effect<Value, DatabaseConfigError> => {
  const environmentProvider =
    options.environment === undefined
      ? ConfigProvider.fromEnv({ preserveEmptyStrings: true })
      : ConfigProvider.fromUnknown(options.environment, {
          preserveEmptyStrings: true,
        });
  const envPath = options.envPath ?? ROOT_ENV_PATH;

  return loadDotEnvProvider(envPath, configFailure).pipe(
    Effect.withSpan('Config.loadDotEnvProvider'),
    Effect.flatMap((fileProvider) => parse(ConfigProvider.orElse(environmentProvider, fileProvider))),
  );
};

const parseIdentityDatabaseConfigWith = Effect.fn('Config.readIdentityDatabaseConfig')(
  function* readIdentityDatabaseConfigEffect(provider: ConfigProvider.ConfigProvider, identity: DatabaseIdentity) {
    const connection = yield* parseDatabaseConfigWith(provider, identity);
    if (connection.user !== identity.role) {
      return yield* configFailure(`${identity.urlKey} must connect as the ${identity.role} role`);
    }
    return connection;
  },
);

/**
 * Loads one runtime identity's connection, which must connect as that identity's role. A Worker takes
 * it from the identity's Hyperdrive binding.
 */
export const loadDatabaseConfig = (
  options: LoadDatabaseConfigOptions,
): Effect.Effect<DatabaseConfigValue, DatabaseConfigError> =>
  loadWithProvider(
    (provider) =>
      databaseRuntime
        .runtimeDatabaseProvider(provider, options.identity)
        .pipe(Effect.flatMap((runtimeProvider) => parseIdentityDatabaseConfigWith(runtimeProvider, options.identity))),
    options,
  );

export const loadDatabaseConnectionPair = (
  options: LoadDatabaseConnectionPairOptions = {},
): Effect.Effect<DatabaseConnectionPair, DatabaseConfigError> => {
  const identity = options.identity ?? SHARED_RUNTIME_IDENTITY;
  return loadWithProvider((provider) => parseDatabaseConnectionPairWith(provider, identity), options);
};

/**
 * Loads the admin connection and every checked-in runtime identity. Each runtime URL must connect as
 * its identity's role, all users must differ, and every URL must target the admin's server and database
 * without parameters that override the user, server or database.
 */
export const loadDatabaseIdentityConnections = (
  options: LoadDatabaseIdentityConnectionsOptions = {},
): Effect.Effect<DatabaseIdentityConnections, DatabaseConfigError> =>
  loadWithProvider(parseDatabaseIdentityConnectionsWith, options);

export const makeDatabaseConfigLive = (identity: DatabaseIdentity): Layer.Layer<DatabaseConfig, DatabaseConfigError> =>
  Layer.effect(DatabaseConfig, loadDatabaseConfig({ identity }));

export const DatabaseConfigLive = makeDatabaseConfigLive(SHARED_RUNTIME_IDENTITY);
