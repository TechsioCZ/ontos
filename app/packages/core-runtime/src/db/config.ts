// @effect-diagnostics nodeBuiltinImport:off processEnv:off
import { config as loadDotenv } from 'dotenv';
import { Context, Effect, Layer, Redacted } from 'effect';
import { APP_ENV_PATH } from '../environment/workspace-environment.ts';
import { DatabaseConfigError } from './config-error.ts';

export { DatabaseConfigError } from './config-error.ts';

export const ROOT_ENV_PATH = APP_ENV_PATH;

type Environment = Readonly<Record<string, string | undefined>>;

export interface DatabaseConfigValue {
  readonly connectionString: Redacted.Redacted<string>;
  readonly database: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
}

export interface DatabaseConnectionPair {
  readonly admin: DatabaseConfigValue;
  readonly runtime: DatabaseConfigValue;
}

export class DatabaseConfig extends Context.Service<DatabaseConfig, DatabaseConfigValue>()(
  '@app/core-runtime/db/config/DatabaseConfig',
) {}

export interface LoadDatabaseConfigOptions {
  readonly environment?: Environment;
  readonly envPath?: string;
}

const loadEnvironment = (
  environment: Environment,
  envPath: string,
): Effect.Effect<Environment, DatabaseConfigError> =>
  Effect.try({
    catch: () =>
      new DatabaseConfigError({
        reason: `Unable to load the root environment from ${envPath}`,
      }),
    try: () => {
      const fileEnvironment: Record<string, string> = {};
      const result = loadDotenv({
        path: envPath,
        processEnv: fileEnvironment,
        quiet: true,
      });
      const dotenvErrorCode: string | undefined = result.error?.code;

      if (
        result.error !== undefined &&
        dotenvErrorCode !== 'ENOENT' &&
        dotenvErrorCode !== 'NOT_FOUND_DOTENV_ENVIRONMENT'
      ) {
        throw result.error;
      }

      return {
        ...fileEnvironment,
        ...environment,
      };
    },
  });

export const parseDatabaseConfig = (
  environment: Environment,
): Effect.Effect<DatabaseConfigValue, DatabaseConfigError> => {
  const databaseUrl = environment['DATABASE_URL']?.trim();

  if (databaseUrl === undefined || databaseUrl.length === 0) {
    return Effect.fail(
      new DatabaseConfigError({
        reason: 'DATABASE_URL is required',
      }),
    );
  }

  return Effect.try({
    catch: () =>
      new DatabaseConfigError({
        reason: 'DATABASE_URL must be a valid PostgreSQL connection URL',
      }),
    try: () => {
      const parsed = new URL(databaseUrl);

      if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
        throw new Error('Unsupported database protocol');
      }

      const database = decodeURIComponent(parsed.pathname.replace(/^\/+/u, ''));
      const host = parsed.hostname;
      const port = parsed.port.length > 0 ? Math.trunc(Number(parsed.port)) : 5432;
      const authorityUser = decodeURIComponent(parsed.username);
      const queryUser = parsed.searchParams.getAll('user').at(-1);
      const user = queryUser === undefined || queryUser.length === 0 ? authorityUser : queryUser;

      if (
        database.length === 0 ||
        host.length === 0 ||
        !Number.isSafeInteger(port) ||
        port < 1 ||
        port > 65_535 ||
        user.length === 0
      ) {
        throw new Error('Incomplete PostgreSQL URL');
      }

      return {
        connectionString: Redacted.make(databaseUrl),
        database,
        host,
        port,
        user,
      };
    },
  });
};

export const parseDatabaseConnectionPair = (
  environment: Environment,
): Effect.Effect<DatabaseConnectionPair, DatabaseConfigError> =>
  Effect.gen(function* parseConnectionPair() {
    const runtime = yield* parseDatabaseConfig(environment);
    const adminUrl = environment['DATABASE_ADMIN_URL']?.trim();
    if (adminUrl === undefined || adminUrl.length === 0) {
      return yield* new DatabaseConfigError({ reason: 'DATABASE_ADMIN_URL is required' });
    }
    const admin = yield* parseDatabaseConfig({ DATABASE_URL: adminUrl });
    if (
      Redacted.value(admin.connectionString) === Redacted.value(runtime.connectionString) ||
      admin.user === runtime.user ||
      runtime.user === 'postgres'
    ) {
      return yield* new DatabaseConfigError({
        reason: 'Administrative and runtime PostgreSQL identities must be distinct',
      });
    }
    return Object.freeze({ admin, runtime });
  });

export const loadDatabaseConfig = (
  options: LoadDatabaseConfigOptions = {},
): Effect.Effect<DatabaseConfigValue, DatabaseConfigError> => {
  const environment = options.environment ?? process.env;
  const envPath = options.envPath ?? ROOT_ENV_PATH;

  return loadEnvironment(environment, envPath).pipe(Effect.flatMap(parseDatabaseConfig));
};

export const loadDatabaseConnectionPair = (
  options: LoadDatabaseConfigOptions = {},
): Effect.Effect<DatabaseConnectionPair, DatabaseConfigError> => {
  const environment = options.environment ?? process.env;
  const envPath = options.envPath ?? ROOT_ENV_PATH;

  return loadEnvironment(environment, envPath).pipe(Effect.flatMap(parseDatabaseConnectionPair));
};

export const DatabaseConfigLive = Layer.effect(DatabaseConfig, loadDatabaseConfig());
