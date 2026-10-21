import { Config, Effect } from 'effect';

export interface OAuthServerConfig {
  /** Empty when ONTOS_MCP_CONNECTOR_SECRET is not set: connector endpoints then answer 503. */
  readonly connectorSecret: string;
  /** Exact issuer string, e.g. http://localhost:3020/shell-super-app-api/oauth (no trailing slash). */
  readonly issuer: string;
  /** MCP resource = JWT aud, e.g. http://localhost:3090/mcp. */
  readonly resource: string;
}

export const loadOAuthServerConfig = Effect.gen(function* loadOAuthServerConfig() {
  const betterAuthUrl = yield* Config.String('BETTER_AUTH_URL').pipe(Effect.orElseSucceed(() => 'http://localhost:3020'));
  const issuer = yield* Config.String('ONTOS_OAUTH_ISSUER').pipe(
    Effect.orElseSucceed(() => `${betterAuthUrl.replace(/\/+$/u, '')}/shell-super-app-api/oauth`),
  );
  const resource = yield* Config.String('ONTOS_MCP_RESOURCE_URL').pipe(Effect.orElseSucceed(() => 'http://localhost:3090/mcp'));
  const connectorSecret = yield* Config.String('ONTOS_MCP_CONNECTOR_SECRET').pipe(Effect.orElseSucceed(() => ''));
  return { connectorSecret, issuer: issuer.replace(/\/+$/u, ''), resource } satisfies OAuthServerConfig;
});
