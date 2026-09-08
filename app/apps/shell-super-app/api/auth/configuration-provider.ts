import { APP_ENV_PATH } from '@app/core-runtime/workspace-environment';
import { ConfigProvider, Effect } from 'effect';

import { loadEnvironmentFileProvider } from './environment-file-provider.ts';

interface LoadConfigurationOptions<Key extends string> {
  readonly environment?: Readonly<Partial<Record<Key, string>>>;
  readonly envPath?: string;
}

export const loadConfigurationProvider = <Key extends string, Failure>(
  options: LoadConfigurationOptions<Key>,
  unableToLoadEnvironment: () => Failure
): Effect.Effect<ConfigProvider.ConfigProvider, Failure> =>
  loadEnvironmentFileProvider(
    options.envPath ?? APP_ENV_PATH,
    unableToLoadEnvironment
  ).pipe(
    Effect.map((fileProvider) =>
      (options.environment === undefined
        ? ConfigProvider.fromEnv()
        : ConfigProvider.fromEnvRecord(options.environment)
      ).pipe(ConfigProvider.orElse(fileProvider))
    )
  );
