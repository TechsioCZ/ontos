import { Config, ConfigProvider, Effect } from 'effect';

import { loadConfigurationProvider } from '../auth/configuration-provider.ts';
import { ConnectionUnavailable } from './errors.ts';

export interface OAuthServerConfig {
  /** Empty when ONTOS_MCP_CONNECTOR_SECRET is not set: connector endpoints then answer 503. */
  readonly connectorSecret: string;
  /** Exact issuer string, e.g. http://localhost:3020/shell-super-app-api/oauth (no trailing slash). */
  readonly issuer: string;
  /** MCP resource = JWT aud, e.g. http://localhost:3090/mcp. */
  readonly resource: string;
}

const parseOAuthServerConfig = Effect.gen(function* parseOAuthServerConfig() {
  const betterAuthUrl = yield* Config.String('BETTER_AUTH_URL').pipe(
    Effect.orElseSucceed(() => 'http://localhost:3020'),
  );
  const issuer = yield* Config.String('ONTOS_OAUTH_ISSUER').pipe(
    Effect.orElseSucceed(() => `${betterAuthUrl.replace(/\/+$/u, '')}/shell-super-app-api/oauth`),
  );
  const resource = yield* Config.String('ONTOS_MCP_RESOURCE_URL').pipe(
    Effect.orElseSucceed(() => 'http://localhost:3090/mcp'),
  );
  const connectorSecret = yield* Config.String('ONTOS_MCP_CONNECTOR_SECRET').pipe(Effect.orElseSucceed(() => ''));
  return { connectorSecret, issuer: issuer.replace(/\/+$/u, ''), resource } satisfies OAuthServerConfig;
});

export const loadOAuthServerConfig = loadConfigurationProvider(
  {},
  () => new ConnectionUnavailable({ cause: 'OAuth configuration unavailable' }),
).pipe(
  // An unreadable environment is a runtime configuration defect, not a connector's token/grant failure.
  Effect.orDie,
  Effect.flatMap((provider) =>
    parseOAuthServerConfig.pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider)),
  ),
);
