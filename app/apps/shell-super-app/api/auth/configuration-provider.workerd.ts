import { env } from 'cloudflare:workers';
import { ConfigProvider, Effect } from 'effect';

/** Worker configuration comes only from bindings, never process.env or a local dotenv file. */
export const loadConfigurationProvider = <Key extends string, Failure>(
  options: {
    readonly environment?: Readonly<Partial<Record<Key, string>>>;
    readonly envPath?: string;
  },
  _unableToLoadEnvironment: () => Failure,
): Effect.Effect<ConfigProvider.ConfigProvider, Failure> =>
  Effect.sync(() => ConfigProvider.fromUnknown(options.environment ?? env));
