// @effect-diagnostics nodeBuiltinImport:off processEnv:off
import { config as loadDotenv } from 'dotenv';
import { Context, Effect, Layer } from 'effect';
import { APP_ENV_PATH } from '../environment/workspace-environment.ts';
import { SpiceDbConfigError } from './config-error.ts';

export const SPICEDB_ROOT_ENV_PATH = APP_ENV_PATH;

type Environment = Readonly<Record<string, string | undefined>>;

export interface SpiceDbConfigValue {
  readonly endpoint: string;
  readonly insecureLocal: boolean;
  readonly preSharedKey: string;
}

export class SpiceDbConfig extends Context.Service<SpiceDbConfig, SpiceDbConfigValue>()(
  '@app/core-runtime/permissions/config/SpiceDbConfig',
) {}

export interface LoadSpiceDbConfigOptions {
  readonly environment?: Environment;
  readonly envPath?: string;
}

const configFailure = (reason: string) => new SpiceDbConfigError({ reason });

const loadEnvironment = (
  environment: Environment,
  envPath: string,
): Effect.Effect<Environment, SpiceDbConfigError> =>
  Effect.try({
    catch: () => configFailure(`Unable to load the root environment from ${envPath}`),
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

const isLocalhostEndpoint = (endpoint: string): boolean => {
  try {
    const parsed = new URL(`http://${endpoint}`);
    return (
      parsed.hostname === 'localhost' &&
      parsed.port.length > 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.pathname === '/' &&
      parsed.search.length === 0 &&
      parsed.hash.length === 0
    );
  } catch {
    return false;
  }
};

const isStagePrivateEndpoint = (endpoint: string, environment: Environment): boolean =>
  environment['ULTRAMODERN_DEPLOYMENT_ENVIRONMENT']?.trim() === 'stage' &&
  endpoint === 'spicedb:50051';

const isValidEndpoint = (endpoint: string): boolean => {
  try {
    const parsed = new URL(`https://${endpoint}`);
    return (
      parsed.hostname.length > 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.pathname === '/' &&
      parsed.search.length === 0 &&
      parsed.hash.length === 0
    );
  } catch {
    return false;
  }
};

export const parseSpiceDbConfig = (
  environment: Environment,
): Effect.Effect<SpiceDbConfigValue, SpiceDbConfigError> => {
  const endpoint = environment['SPICEDB_ENDPOINT']?.trim();
  const preSharedKey = environment['SPICEDB_PRESHARED_KEY']?.trim();
  const insecureFlag = environment['SPICEDB_INSECURE']?.trim().toLowerCase();

  if (endpoint === undefined || endpoint.length === 0) {
    return Effect.fail(configFailure('SPICEDB_ENDPOINT is required'));
  }
  if (!isValidEndpoint(endpoint)) {
    return Effect.fail(configFailure('SPICEDB_ENDPOINT must be a valid host and optional port'));
  }
  if (preSharedKey === undefined || preSharedKey.length === 0) {
    return Effect.fail(configFailure('SPICEDB_PRESHARED_KEY is required'));
  }
  if (insecureFlag !== 'true' && insecureFlag !== 'false') {
    return Effect.fail(configFailure('SPICEDB_INSECURE must be explicitly true or false'));
  }
  if (
    insecureFlag === 'true' &&
    !isLocalhostEndpoint(endpoint) &&
    !isStagePrivateEndpoint(endpoint, environment)
  ) {
    return Effect.fail(
      configFailure(
        'Insecure SpiceDB transport is allowed only for an explicit localhost port or the stage private endpoint',
      ),
    );
  }

  return Effect.succeed({
    endpoint,
    insecureLocal: insecureFlag === 'true',
    preSharedKey,
  });
};

export const loadSpiceDbConfig = (
  options: LoadSpiceDbConfigOptions = {},
): Effect.Effect<SpiceDbConfigValue, SpiceDbConfigError> => {
  const environment = options.environment ?? process.env;
  const envPath = options.envPath ?? SPICEDB_ROOT_ENV_PATH;

  return loadEnvironment(environment, envPath).pipe(Effect.flatMap(parseSpiceDbConfig));
};

export const SpiceDbConfigLive = Layer.effect(SpiceDbConfig, loadSpiceDbConfig());
