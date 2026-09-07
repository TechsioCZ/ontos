import {
  Config,
  ConfigProvider,
  Context,
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
  Redacted,
  Schema,
} from 'effect';
import { APP_ENV_PATH } from '../environment/workspace-environment.ts';
import { SpiceDbConfigError } from './config-error.ts';

export const SPICEDB_ROOT_ENV_PATH = APP_ENV_PATH;

const makeSpiceDbConfigValue = (settings: {
  readonly deploymentEnvironment: string | undefined;
  readonly endpoint: string;
  readonly insecureLocal: boolean;
  readonly preSharedKey: Redacted.Redacted;
}) => {
  const base = {
    endpoint: settings.endpoint,
    insecureLocal: settings.insecureLocal,
    get preSharedKey(): string {
      return Redacted.value(settings.preSharedKey);
    },
  };
  return settings.deploymentEnvironment === undefined
    ? Object.freeze(base)
    : Object.freeze(Object.assign(base, { deploymentEnvironment: settings.deploymentEnvironment }));
};

export type SpiceDbConfigValue = ReturnType<typeof makeSpiceDbConfigValue> &
  Partial<Record<'deploymentEnvironment', string>>;

export class SpiceDbConfig extends Context.Service<SpiceDbConfig, SpiceDbConfigValue>()(
  '@app/core-runtime/permissions/config/SpiceDbConfig',
) {}

export type SpiceDbEnvironment = Readonly<
  Partial<
    Record<
      | 'SPICEDB_ENDPOINT'
      | 'SPICEDB_INSECURE'
      | 'SPICEDB_PRESHARED_KEY'
      | 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT',
      string
    >
  >
>;

export interface LoadSpiceDbConfigOptions {
  readonly environment?: SpiceDbEnvironment;
  readonly envPath?: string;
}

const configFailure = (reason: string) => new SpiceDbConfigError({ reason });

const configFailureWithCause = <Cause>(reason: string, cause: Cause) => {
  const failure = new SpiceDbConfigError({ reason });
  return Object.defineProperty(failure, 'cause', { value: cause });
};

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

const parseSpiceDbConfigWith = Effect.fn('Config.parseSpiceDbConfigWith')(function* parseConfig(
  provider: ConfigProvider.ConfigProvider,
) {
  const { deploymentEnvironment, endpoint, insecureFlag, preSharedKey } = yield* Effect.all(
    {
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
        .pipe(
          Effect.mapError((error) => configFailureWithCause('SPICEDB_ENDPOINT is required', error)),
        ),
      insecureFlag: Config.schema(Schema.Trim, 'SPICEDB_INSECURE')
        .pipe(Config.map((value) => value.toLowerCase()))
        .parse(provider)
        .pipe(
          Effect.mapError((error) =>
            configFailureWithCause('SPICEDB_INSECURE must be explicitly true or false', error),
          ),
        ),
      preSharedKey: Config.redacted('SPICEDB_PRESHARED_KEY')
        .pipe(Config.map((value) => Redacted.make(Redacted.value(value).trim())))
        .parse(provider)
        .pipe(
          Effect.mapError((error) =>
            configFailureWithCause('SPICEDB_PRESHARED_KEY is required', error),
          ),
        ),
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
  if (insecureFlag !== 'true' && insecureFlag !== 'false') {
    return yield* configFailure('SPICEDB_INSECURE must be explicitly true or false');
  }
  const configuration = makeSpiceDbConfigValue({
    deploymentEnvironment,
    endpoint,
    insecureLocal: insecureFlag === 'true',
    preSharedKey,
  });
  if (!allowsInsecureSpiceDbTransport(configuration)) {
    return yield* configFailure(
      'Insecure SpiceDB transport is allowed only for an explicit localhost port or the stage private endpoint',
    );
  }

  return configuration;
});

export const parseSpiceDbConfig = (
  environment: SpiceDbEnvironment,
): Effect.Effect<SpiceDbConfigValue, SpiceDbConfigError> =>
  parseSpiceDbConfigWith(ConfigProvider.fromUnknown(environment, { preserveEmptyStrings: true }));

const nodeFileSystem = process.getBuiltinModule('node:fs');

const loadFileConfigProvider = Effect.fn('Config.loadFileConfigProvider')(function* loadProvider(
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
        error: configFailureWithCause(`Unable to load the root environment from ${envPath}`, error),
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

export const loadSpiceDbConfig = (
  options: LoadSpiceDbConfigOptions = {},
): Effect.Effect<SpiceDbConfigValue, SpiceDbConfigError> => {
  const environmentProvider =
    options.environment === undefined
      ? ConfigProvider.fromEnv({ preserveEmptyStrings: true })
      : ConfigProvider.fromUnknown(options.environment, { preserveEmptyStrings: true });
  const envPath = options.envPath ?? SPICEDB_ROOT_ENV_PATH;

  return loadFileConfigProvider(envPath).pipe(
    Effect.flatMap((fileProvider) =>
      parseSpiceDbConfigWith(ConfigProvider.orElse(environmentProvider, fileProvider)),
    ),
  );
};

export const SpiceDbConfigLive = Layer.effect(SpiceDbConfig, loadSpiceDbConfig());
