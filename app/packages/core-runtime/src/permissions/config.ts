// @effect-diagnostics nodeBuiltinImport:off processEnv:off
import { config as loadDotenv } from 'dotenv';
import { Context, Effect, Layer, Redacted, Schema } from 'effect';
import { APP_ENV_PATH } from '../environment/workspace-environment.ts';
import { SpiceDbConfigError } from './config-error.ts';

export const SPICEDB_ROOT_ENV_PATH = APP_ENV_PATH;

type Environment = Readonly<Record<string, string | undefined>>;

export interface SpiceDbConfigValue {
  readonly deploymentEnvironment?: string;
  readonly endpoint: string;
  readonly insecureLocal: boolean;
  readonly preSharedKey: Redacted.Redacted<string>;
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
    catch: (error) =>
      Schema.is(SpiceDbConfigError)(error)
        ? error
        : configFailure('Unable to load the root environment'),
    try: () => {
      const fileEnvironment: Record<string, string> = {};
      const result = loadDotenv({
        path: envPath,
        processEnv: fileEnvironment,
        quiet: true,
      });
      const dotenvErrorCode: string | undefined = result.error?.code;

      return {
        dotenvErrorCode,
        fileEnvironment,
        hasDotenvError: result.error !== undefined,
      };
    },
  }).pipe(
    Effect.flatMap(({ dotenvErrorCode, fileEnvironment, hasDotenvError }) =>
      !hasDotenvError ||
      dotenvErrorCode === 'ENOENT' ||
      dotenvErrorCode === 'NOT_FOUND_DOTENV_ENVIRONMENT'
        ? Effect.succeed({
            ...fileEnvironment,
            ...environment,
          })
        : Effect.fail(configFailure('Unable to load the root environment')),
    ),
  );

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

const isStagePrivateEndpoint = (endpoint: string, deploymentEnvironment?: string): boolean =>
  deploymentEnvironment === 'stage' && endpoint === 'spicedb:50051';

export const allowsInsecureSpiceDbTransport = (
  configuration: Pick<SpiceDbConfigValue, 'deploymentEnvironment' | 'endpoint' | 'insecureLocal'>,
): boolean =>
  !configuration.insecureLocal ||
  isLocalhostEndpoint(configuration.endpoint) ||
  isStagePrivateEndpoint(configuration.endpoint, configuration.deploymentEnvironment);

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
  const deploymentEnvironment = environment['ULTRAMODERN_DEPLOYMENT_ENVIRONMENT']?.trim();

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
  const transportConfiguration =
    deploymentEnvironment === undefined
      ? { endpoint, insecureLocal: insecureFlag === 'true' }
      : { deploymentEnvironment, endpoint, insecureLocal: insecureFlag === 'true' };
  if (insecureFlag === 'true' && !allowsInsecureSpiceDbTransport(transportConfiguration)) {
    return Effect.fail(
      configFailure(
        'Insecure SpiceDB transport is allowed only for an explicit localhost port or the stage private endpoint',
      ),
    );
  }

  const configuration: SpiceDbConfigValue = {
    endpoint,
    insecureLocal: insecureFlag === 'true',
    preSharedKey: Redacted.make(preSharedKey),
  };
  return Effect.succeed(
    deploymentEnvironment === undefined
      ? configuration
      : { ...configuration, deploymentEnvironment },
  );
};

export const loadSpiceDbConfig = (
  options: LoadSpiceDbConfigOptions = {},
): Effect.Effect<SpiceDbConfigValue, SpiceDbConfigError> => {
  const environment = options.environment ?? process.env;
  const envPath = options.envPath ?? SPICEDB_ROOT_ENV_PATH;

  return loadEnvironment(environment, envPath).pipe(Effect.flatMap(parseSpiceDbConfig));
};

export const SpiceDbConfigLive = Layer.effect(SpiceDbConfig, loadSpiceDbConfig());
