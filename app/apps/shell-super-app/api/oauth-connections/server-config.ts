import { Config, Effect } from 'effect';
import type { ConfigProvider } from 'effect';

import { mcpResourceUrlOf } from '../../shared/mcp-resource.ts';
import { loadConfigurationProvider } from '../auth/configuration-provider.ts';
import { ConnectionUnavailable } from './errors.ts';

export interface OAuthServerConfig {
  /** Exact issuer string, e.g. http://localhost:3020/shell-super-app-api/oauth (no trailing slash). */
  readonly issuer: string;
  /** MCP resource = JWT aud = `<shell origin>/mcp`, e.g. http://localhost:3020/mcp. */
  readonly resource: string;
}

const parseOAuthServerConfig = Effect.fn('OAuthServerConfig.parse')(function* parseOAuthServerConfig(
  provider: ConfigProvider.ConfigProvider,
) {
  const betterAuthUrl = yield* Config.String('BETTER_AUTH_URL')
    .parse(provider)
    .pipe(Effect.orElseSucceed(() => 'http://localhost:3020'));
  const issuer = yield* Config.String('ONTOS_OAUTH_ISSUER')
    .parse(provider)
    .pipe(Effect.orElseSucceed(() => `${betterAuthUrl.replace(/\/+$/u, '')}/shell-super-app-api/oauth`));
  return {
    issuer: issuer.replace(/\/+$/u, ''),
    resource: mcpResourceUrlOf(betterAuthUrl),
  } satisfies OAuthServerConfig;
});

export const loadOAuthServerConfig = loadConfigurationProvider(
  {},
  () => new ConnectionUnavailable({ cause: 'OAuth configuration unavailable' }),
).pipe(
  // An unreadable environment is a runtime configuration defect, not a connector's token/grant failure.
  Effect.orDie,
  Effect.flatMap(parseOAuthServerConfig),
);
