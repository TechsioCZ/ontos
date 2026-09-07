import {
  Config,
  ConfigProvider,
  Context,
  Effect,
  Layer,
  Match,
  Predicate,
  Redacted,
  Schema,
} from 'effect';
import { APP_ENV_PATH } from '../environment/workspace-environment.ts';
import { DatabaseConfigError } from './config-error.ts';

export { DatabaseConfigError } from './config-error.ts';

export const ROOT_ENV_PATH = APP_ENV_PATH;

const requiredDatabaseUrlSchema = Schema.Trim.pipe(Schema.check(Schema.isMinLength(1)));
const INVALID_DATABASE_URL_REASON = 'DATABASE_URL must be a valid PostgreSQL connection URL';

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
}

export interface LoadDatabaseConfigOptions {
  readonly environment?: DatabaseEnvironment;
  readonly envPath?: string;
}

const configFailure = (reason: string, cause?: unknown): DatabaseConfigError => {
  const failure = new DatabaseConfigError({ reason });
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { value: cause });
};

interface ReadDatabaseUrlOptions {
  readonly configKey: string;
  readonly provider: ConfigProvider.ConfigProvider;
  readonly requiredReason: string;
}

const readDatabaseUrl = Effect.fn('Config.readDatabaseUrl')(function* readDatabaseUrlEffect(
  options: ReadDatabaseUrlOptions,
) {
  const connectionString = yield* Config.schema(
    Schema.Redacted(requiredDatabaseUrlSchema),
    options.configKey,
  )
    .parse(options.provider)
    .pipe(Effect.mapError((error) => configFailure(options.requiredReason, error)));
  const parsed = yield* Schema.decodeEffect(Schema.URLFromString)(
    Redacted.value(connectionString),
  ).pipe(Effect.mapError((error) => configFailure(INVALID_DATABASE_URL_REASON, error)));

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    return yield* configFailure(INVALID_DATABASE_URL_REASON);
  }

  const decoded = yield* Effect.try({
    catch: (error) => configFailure(INVALID_DATABASE_URL_REASON, error),
    try: () => ({
      authorityUser: decodeURIComponent(parsed.username),
      database: decodeURIComponent(parsed.pathname.replace(/^\/+/u, '')),
    }),
  });
  const host = parsed.hostname;
  const port = parsed.port.length > 0 ? Math.trunc(Number(parsed.port)) : 5432;
  const queryUser = parsed.searchParams.getAll('user').at(-1);
  const user =
    queryUser === undefined || queryUser.length === 0 ? decoded.authorityUser : queryUser;

  if (
    decoded.database.length === 0 ||
    host.length === 0 ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    user.length === 0
  ) {
    return yield* configFailure(INVALID_DATABASE_URL_REASON);
  }

  return makeDatabaseConfigValue({
    connectionString,
    database: decoded.database,
    host,
    port,
    user,
  });
});

const parseDatabaseConfigWith = (provider: ConfigProvider.ConfigProvider) =>
  readDatabaseUrl({
    configKey: 'DATABASE_URL',
    provider,
    requiredReason: 'DATABASE_URL is required',
  });

const parseDatabaseConnectionPairWith = Effect.fn('Config.readDatabaseConnectionPair')(
  function* readDatabaseConnectionPairEffect(provider: ConfigProvider.ConfigProvider) {
    const [runtime, admin] = yield* Effect.all(
      [
        parseDatabaseConfigWith(provider),
        readDatabaseUrl({
          configKey: 'DATABASE_ADMIN_URL',
          provider,
          requiredReason: 'DATABASE_ADMIN_URL is required',
        }),
      ],
      { concurrency: 1 },
    );

    if (
      admin.connectionString === runtime.connectionString ||
      admin.user === runtime.user ||
      runtime.user === 'postgres'
    ) {
      return yield* configFailure(
        'Administrative and runtime PostgreSQL identities must be distinct',
      );
    }

    return Object.freeze({ admin, runtime });
  },
);

export const parseDatabaseConfig = (
  environment: DatabaseEnvironment,
): Effect.Effect<DatabaseConfigValue, DatabaseConfigError> =>
  parseDatabaseConfigWith(ConfigProvider.fromUnknown(environment, { preserveEmptyStrings: true }));

export const parseDatabaseConnectionPair = (
  environment: DatabaseEnvironment,
): Effect.Effect<DatabaseConnectionPair, DatabaseConfigError> =>
  parseDatabaseConnectionPairWith(
    ConfigProvider.fromUnknown(environment, { preserveEmptyStrings: true }),
  );

const nodeFileSystem = process.getBuiltinModule('node:fs');

const loadDotEnvProvider = Effect.fn('Config.loadDotEnvProvider')(function* loadProvider(
  envPath: string,
) {
  const result = yield* Effect.sync(() => {
    try {
      return {
        contents: nodeFileSystem.readFileSync(envPath, 'utf-8'),
        status: 'loaded',
      } as const;
    } catch (error) {
      if (
        Predicate.hasProperty(error, 'code') &&
        (error.code === 'ENOENT' || error.code === 'NOT_FOUND_DOTENV_ENVIRONMENT')
      ) {
        return { status: 'missing' } as const;
      }
      return {
        error: configFailure(`Unable to load the root environment from ${envPath}`, error),
        status: 'failed',
      } as const;
    }
  });

  return yield* Match.value(result).pipe(
    Match.discriminatorsExhaustive('status')({
      failed: ({ error }) => Effect.fail(error),
      loaded: ({ contents }) =>
        Effect.succeed(ConfigProvider.fromDotEnvContents(contents, { preserveEmptyStrings: true })),
      missing: () => Effect.succeed(ConfigProvider.fromUnknown({})),
    }),
  );
});

const loadWithProvider = <Value>(
  parse: (provider: ConfigProvider.ConfigProvider) => Effect.Effect<Value, DatabaseConfigError>,
  options: LoadDatabaseConfigOptions,
): Effect.Effect<Value, DatabaseConfigError> => {
  const environmentProvider =
    options.environment === undefined
      ? ConfigProvider.fromEnv({ preserveEmptyStrings: true })
      : ConfigProvider.fromUnknown(options.environment, {
          preserveEmptyStrings: true,
        });
  const envPath = options.envPath ?? ROOT_ENV_PATH;

  return loadDotEnvProvider(envPath).pipe(
    Effect.flatMap((fileProvider) =>
      parse(ConfigProvider.orElse(environmentProvider, fileProvider)),
    ),
  );
};

export const loadDatabaseConfig = (
  options: LoadDatabaseConfigOptions = {},
): Effect.Effect<DatabaseConfigValue, DatabaseConfigError> =>
  loadWithProvider(parseDatabaseConfigWith, options);

export const loadDatabaseConnectionPair = (
  options: LoadDatabaseConfigOptions = {},
): Effect.Effect<DatabaseConnectionPair, DatabaseConfigError> =>
  loadWithProvider(parseDatabaseConnectionPairWith, options);

export const DatabaseConfigLive = Layer.effect(DatabaseConfig, loadDatabaseConfig());
