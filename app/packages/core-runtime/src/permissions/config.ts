import { Config, ConfigProvider, Effect, Option, Redacted, Schema } from 'effect';

import { loadDotEnvProvider } from '../environment/dotenv-provider.ts';
import { APP_ENV_PATH } from '../environment/workspace-environment.ts';
import { SpiceDbConfigError } from './config-error.ts';

export const SPICEDB_ROOT_ENV_PATH = APP_ENV_PATH;

const makeSpiceDbConfigValue = (settings: {
  readonly caCertificate: string | undefined;
  readonly deploymentEnvironment: string | undefined;
  readonly endpoint: string;
  readonly preSharedKey: Redacted.Redacted;
}) => {
  const base = {
    endpoint: settings.endpoint,
    get preSharedKey(): string {
      return Redacted.value(settings.preSharedKey);
    },
  };
  return Object.freeze(
    Object.assign(
      base,
      settings.caCertificate === undefined ? {} : { caCertificate: settings.caCertificate },
      settings.deploymentEnvironment === undefined ? {} : { deploymentEnvironment: settings.deploymentEnvironment },
    ),
  );
};

/**
 * SpiceDB is always reached over TLS. `caCertificate` (`SPICEDB_CA_CERT`) is the PEM certificate
 * the Node gRPC client pins as its only trusted CA; Workers reach the HTTP gateway through their
 * Workers VPC binding, which verifies the gateway certificate itself.
 */
export type SpiceDbConfigValue = ReturnType<typeof makeSpiceDbConfigValue> &
  Partial<Record<'caCertificate' | 'deploymentEnvironment', string>>;

export type SpiceDbEnvironment = Readonly<
  Partial<
    Record<
      'SPICEDB_CA_CERT' | 'SPICEDB_ENDPOINT' | 'SPICEDB_PRESHARED_KEY' | 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT',
      string
    >
  >
>;

export interface LoadSpiceDbConfigOptions {
  readonly environment?: SpiceDbEnvironment;
  readonly envPath?: string;
}

const configFailure = (reason: string) => new SpiceDbConfigError({ reason });

const configFailureWithCause = (reason: string, cause: unknown) => new SpiceDbConfigError({ cause, reason });

const PEM_CERTIFICATE = /^-----BEGIN CERTIFICATE-----\r?\n[\s\S]+\r?\n-----END CERTIFICATE-----$/u;

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

const parseSpiceDbConfigWith = Effect.fn('Config.parseSpiceDbConfigWith')(function* parseConfig(
  provider: ConfigProvider.ConfigProvider,
) {
  const { caCertificate, deploymentEnvironment, endpoint, preSharedKey } = yield* Effect.all(
    {
      caCertificate: Config.schema(Schema.Trim, 'SPICEDB_CA_CERT')
        .pipe(Config.option, Config.map(Option.getOrUndefined))
        .parse(provider)
        .pipe(Effect.mapError((error) => configFailureWithCause('SPICEDB_CA_CERT must be a string', error))),
      deploymentEnvironment: Config.schema(Schema.Trim, 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT')
        .pipe(Config.option, Config.map(Option.getOrUndefined))
        .parse(provider)
        .pipe(
          Effect.mapError((error) =>
            configFailureWithCause('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT must be a string', error),
          ),
        ),
      endpoint: Config.schema(Schema.Trim, 'SPICEDB_ENDPOINT')
        .parse(provider)
        .pipe(Effect.mapError((error) => configFailureWithCause('SPICEDB_ENDPOINT is required', error))),
      preSharedKey: Config.Redacted('SPICEDB_PRESHARED_KEY')
        .pipe(Config.map((value) => Redacted.make(Redacted.value(value).trim())))
        .parse(provider)
        .pipe(Effect.mapError((error) => configFailureWithCause('SPICEDB_PRESHARED_KEY is required', error))),
    },
    { concurrency: 4 },
  );

  if (endpoint.length === 0) {
    return yield* configFailure('SPICEDB_ENDPOINT is required');
  }
  if (!isValidEndpoint(endpoint)) {
    return yield* configFailure('SPICEDB_ENDPOINT must be a valid host and optional port');
  }
  if (Redacted.value(preSharedKey).length === 0) {
    return yield* configFailure('SPICEDB_PRESHARED_KEY is required');
  }
  if (caCertificate !== undefined && caCertificate.length > 0 && !PEM_CERTIFICATE.test(caCertificate)) {
    return yield* configFailure('SPICEDB_CA_CERT must be a PEM certificate');
  }
  return makeSpiceDbConfigValue({
    caCertificate: caCertificate === undefined || caCertificate.length === 0 ? undefined : caCertificate,
    deploymentEnvironment,
    endpoint,
    preSharedKey,
  });
});

export const parseSpiceDbConfig = (
  environment: SpiceDbEnvironment,
): Effect.Effect<SpiceDbConfigValue, SpiceDbConfigError> =>
  parseSpiceDbConfigWith(ConfigProvider.fromUnknown(environment, { preserveEmptyStrings: true }));

export const loadSpiceDbConfig = (
  options: LoadSpiceDbConfigOptions = {},
): Effect.Effect<SpiceDbConfigValue, SpiceDbConfigError> => {
  const environmentProvider =
    options.environment === undefined
      ? ConfigProvider.fromEnv({ preserveEmptyStrings: true })
      : ConfigProvider.fromUnknown(options.environment, {
          preserveEmptyStrings: true,
        });
  const envPath = options.envPath ?? SPICEDB_ROOT_ENV_PATH;

  return loadDotEnvProvider(envPath, configFailureWithCause).pipe(
    Effect.withSpan('Config.loadFileConfigProvider'),
    Effect.flatMap((fileProvider) => parseSpiceDbConfigWith(ConfigProvider.orElse(environmentProvider, fileProvider))),
  );
};
