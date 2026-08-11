// @effect-diagnostics nodeBuiltinImport:off processEnv:off
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { Context, Effect, Layer } from 'effect';
import { CrmDatabaseConfigError } from './config-error.ts';

export { CrmDatabaseConfigError } from './config-error.ts';

const invocationRoot =
  process.env['ULTRAMODERN_WORKSPACE_ROOT'] ?? process.env['INIT_CWD'] ?? process.cwd();
const workspaceRoot = ['apps', 'packages', 'verticals'].includes(
  path.basename(path.dirname(invocationRoot)),
)
  ? path.resolve(invocationRoot, '../..')
  : invocationRoot;

export const CRM_ROOT_ENV_PATH = path.resolve(workspaceRoot, '.env');

type Environment = Readonly<Record<string, string | undefined>>;

export interface CrmDatabaseConfigValue {
  readonly connectionString: string;
  readonly database: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
}

export interface CrmDatabaseConnectionPair {
  readonly admin: CrmDatabaseConfigValue;
  readonly runtime: CrmDatabaseConfigValue;
}

export class CrmDatabaseConfig extends Context.Service<CrmDatabaseConfig, CrmDatabaseConfigValue>()(
  '@app/crm/db/config/CrmDatabaseConfig',
) {}

export interface LoadCrmDatabaseConfigOptions {
  readonly environment?: Environment;
  readonly envPath?: string;
}

const loadEnvironment = (
  environment: Environment,
  envPath: string,
): Effect.Effect<Environment, CrmDatabaseConfigError> =>
  Effect.try({
    catch: () =>
      new CrmDatabaseConfigError({
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

export const parseCrmDatabaseConfig = (
  environment: Environment,
): Effect.Effect<CrmDatabaseConfigValue, CrmDatabaseConfigError> => {
  const databaseUrl = environment['DATABASE_URL']?.trim();

  if (databaseUrl === undefined || databaseUrl.length === 0) {
    return Effect.fail(
      new CrmDatabaseConfigError({
        reason: 'DATABASE_URL is required',
      }),
    );
  }

  return Effect.try({
    catch: () =>
      new CrmDatabaseConfigError({
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
      const user = decodeURIComponent(parsed.username);

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
        connectionString: databaseUrl,
        database,
        host,
        port,
        user,
      };
    },
  });
};

export const parseCrmDatabaseConnectionPair = (
  environment: Environment,
): Effect.Effect<CrmDatabaseConnectionPair, CrmDatabaseConfigError> =>
  Effect.gen(function* parseConnectionPair() {
    const runtime = yield* parseCrmDatabaseConfig(environment);
    const adminUrl = environment['DATABASE_ADMIN_URL']?.trim();
    if (adminUrl === undefined || adminUrl.length === 0) {
      return yield* new CrmDatabaseConfigError({ reason: 'DATABASE_ADMIN_URL is required' });
    }
    const admin = yield* parseCrmDatabaseConfig({ DATABASE_URL: adminUrl });
    if (
      admin.connectionString === runtime.connectionString ||
      admin.user === runtime.user ||
      runtime.user !== 'ontos_runtime'
    ) {
      return yield* new CrmDatabaseConfigError({
        reason: 'CRM requires distinct administrative and ontos_runtime PostgreSQL identities',
      });
    }
    return Object.freeze({ admin, runtime });
  });

export const loadCrmDatabaseConfig = (
  options: LoadCrmDatabaseConfigOptions = {},
): Effect.Effect<CrmDatabaseConfigValue, CrmDatabaseConfigError> => {
  const environment = options.environment ?? process.env;
  const envPath = options.envPath ?? CRM_ROOT_ENV_PATH;

  return loadEnvironment(environment, envPath).pipe(Effect.flatMap(parseCrmDatabaseConfig));
};

export const loadCrmDatabaseConnectionPair = (
  options: LoadCrmDatabaseConfigOptions = {},
): Effect.Effect<CrmDatabaseConnectionPair, CrmDatabaseConfigError> => {
  const environment = options.environment ?? process.env;
  const envPath = options.envPath ?? CRM_ROOT_ENV_PATH;

  return loadEnvironment(environment, envPath).pipe(Effect.flatMap(parseCrmDatabaseConnectionPair));
};

export const CrmDatabaseConfigLive = Layer.effect(CrmDatabaseConfig, loadCrmDatabaseConfig());
