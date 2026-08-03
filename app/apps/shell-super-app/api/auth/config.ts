// @effect-diagnostics nodeBuiltinImport:off processEnv:off
/* eslint-disable max-classes-per-file -- The validated service and its configuration error form one boundary. */
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { Context, Effect, Layer, Schema } from 'effect';

export class AuthConfigError extends Schema.TaggedErrorClass<AuthConfigError>()('AuthConfigError', {
  reason: Schema.String,
}) {}

const invocationRoot =
  process.env['ULTRAMODERN_WORKSPACE_ROOT'] ?? process.env['INIT_CWD'] ?? process.cwd();
const workspaceRoot = ['apps', 'packages', 'verticals'].includes(
  path.basename(path.dirname(invocationRoot)),
)
  ? path.resolve(invocationRoot, '../..')
  : invocationRoot;

export const ROOT_ENV_PATH = path.resolve(workspaceRoot, '.env');

type Environment = Readonly<Record<string, string | undefined>>;

export interface AuthConfigValue {
  readonly baseUrl: string;
  readonly connectionString: string;
  readonly secret: string;
  readonly secureCookies: boolean;
  readonly trustedOrigins: readonly string[];
}

export class AuthConfig extends Context.Service<AuthConfig, AuthConfigValue>()(
  '@app/shell-super-app/api/auth/config/AuthConfig',
) {}

const parseHttpOrigin = (value: string, field: string): string => {
  const url = new URL(value);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${field} must use http or https`);
  }

  return url.origin;
};

export const parseAuthConfig = (
  environment: Environment,
): Effect.Effect<AuthConfigValue, AuthConfigError> =>
  Effect.try({
    catch: () =>
      new AuthConfigError({
        reason: 'Better Auth configuration is missing or malformed',
      }),
    try: () => {
      const connectionString = environment['DATABASE_URL']?.trim();
      const secret = environment['BETTER_AUTH_SECRET']?.trim();
      const configuredBaseUrl = environment['BETTER_AUTH_URL']?.trim();

      if (connectionString === undefined || connectionString.length === 0) {
        throw new Error('DATABASE_URL is required');
      }

      const databaseUrl = new URL(connectionString);
      if (databaseUrl.protocol !== 'postgres:' && databaseUrl.protocol !== 'postgresql:') {
        throw new Error('DATABASE_URL must use PostgreSQL');
      }

      if (secret === undefined || secret.length < 32) {
        throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters');
      }

      if (configuredBaseUrl === undefined || configuredBaseUrl.length === 0) {
        throw new Error('BETTER_AUTH_URL is required');
      }

      const baseUrl = parseHttpOrigin(configuredBaseUrl, 'BETTER_AUTH_URL');
      const trustedOriginValues = environment['BETTER_AUTH_TRUSTED_ORIGINS']
        ?.split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0);
      const trustedOrigins = [...new Set([baseUrl, ...(trustedOriginValues ?? [])])].map((origin) =>
        parseHttpOrigin(origin, 'BETTER_AUTH_TRUSTED_ORIGINS'),
      );
      const secureCookies =
        new URL(baseUrl).protocol === 'https:' || environment['NODE_ENV'] === 'production';

      return {
        baseUrl,
        connectionString,
        secret,
        secureCookies,
        trustedOrigins,
      };
    },
  });

export interface LoadAuthConfigOptions {
  readonly environment?: Environment;
  readonly envPath?: string;
}

export const loadAuthConfig = (
  options: LoadAuthConfigOptions = {},
): Effect.Effect<AuthConfigValue, AuthConfigError> =>
  Effect.try({
    catch: () =>
      new AuthConfigError({
        reason: 'Unable to load the root authentication environment',
      }),
    try: () => {
      const fileEnvironment: Record<string, string> = {};
      const result = loadDotenv({
        path: options.envPath ?? ROOT_ENV_PATH,
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
        ...(options.environment ?? process.env),
      };
    },
  }).pipe(Effect.flatMap(parseAuthConfig));

export const AuthConfigLive = Layer.effect(AuthConfig, loadAuthConfig());
