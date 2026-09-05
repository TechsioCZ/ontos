// @effect-diagnostics nodeBuiltinImport:off processEnv:off
/* eslint-disable max-classes-per-file -- The validated service and its configuration error form one boundary. */
import { APP_ENV_PATH } from '@app/core-runtime/workspace-environment';
import { config as loadDotenv } from 'dotenv';
import { Context, Effect, Layer, Redacted, Schema } from 'effect';

export class AuthConfigError extends Schema.TaggedError<AuthConfigError>()('AuthConfigError', {
  reason: Schema.String,
}) {}

export const ROOT_ENV_PATH = APP_ENV_PATH;

type Environment = Readonly<Record<string, string | undefined>>;

export interface AuthConfigValue {
  readonly baseUrl: string;
  readonly connectionString: Redacted.Redacted<string>;
  readonly secret: Redacted.Redacted<string>;
  readonly secureCookies: boolean;
  readonly supportUserIds: readonly string[];
  readonly trustedOrigins: readonly string[];
}

export class AuthConfig extends Context.Service<AuthConfig, AuthConfigValue>()(
  '@app/shell-super-app/api/auth/config/AuthConfig',
) {}

const malformedAuthConfig = () =>
  new AuthConfigError({
    reason: 'Better Auth configuration is missing or malformed',
  });

const parseHttpOrigin = (value: string): Effect.Effect<string, AuthConfigError> =>
  Effect.gen(function* parseHttpOriginEffect() {
    if (!URL.canParse(value)) {
      return yield* malformedAuthConfig();
    }

    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return yield* malformedAuthConfig();
    }

    return url.origin;
  });

export const parseAuthConfig = (
  environment: Environment,
): Effect.Effect<AuthConfigValue, AuthConfigError> =>
  Effect.gen(function* parseAuthConfigEffect() {
    const connectionString = environment['DATABASE_URL']?.trim();
    const secret = environment['BETTER_AUTH_SECRET']?.trim();
    const configuredBaseUrl = environment['BETTER_AUTH_URL']?.trim();

    if (connectionString === undefined || connectionString.length === 0) {
      return yield* malformedAuthConfig();
    }

    if (!URL.canParse(connectionString)) {
      return yield* malformedAuthConfig();
    }

    const databaseUrl = new URL(connectionString);
    if (databaseUrl.protocol !== 'postgres:' && databaseUrl.protocol !== 'postgresql:') {
      return yield* malformedAuthConfig();
    }

    if (secret === undefined || secret.length < 32) {
      return yield* malformedAuthConfig();
    }

    if (configuredBaseUrl === undefined || configuredBaseUrl.length === 0) {
      return yield* malformedAuthConfig();
    }

    const baseUrl = yield* parseHttpOrigin(configuredBaseUrl);
    const trustedOriginValues = environment['BETTER_AUTH_TRUSTED_ORIGINS']
      ?.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
    const trustedOrigins = yield* Effect.forEach(
      [...new Set([baseUrl, ...(trustedOriginValues ?? [])])],
      parseHttpOrigin,
      { concurrency: 1 },
    );
    const secureCookies =
      new URL(baseUrl).protocol === 'https:' || environment['NODE_ENV'] === 'production';
    const supportUserIds = [
      ...new Set(
        (environment['BETTER_AUTH_SUPPORT_USER_IDS'] ?? '')
          .split(',')
          .map((userId) => userId.trim())
          .filter((userId) => userId.length > 0),
      ),
    ];

    return {
      baseUrl,
      connectionString: Redacted.make(connectionString),
      secret: Redacted.make(secret),
      secureCookies,
      supportUserIds,
      trustedOrigins,
    };
  });

export interface LoadAuthConfigOptions {
  readonly environment?: Environment;
  readonly envPath?: string;
}

export const loadAuthConfig = (
  options: LoadAuthConfigOptions = {},
): Effect.Effect<AuthConfigValue, AuthConfigError> =>
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
    Effect.flatMap(parseAuthConfig),
  );

export const AuthConfigLive = Layer.effect(AuthConfig, loadAuthConfig());
