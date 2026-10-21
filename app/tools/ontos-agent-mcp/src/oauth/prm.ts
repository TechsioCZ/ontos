/** RFC 9728 Protected Resource Metadata and the RFC 6750 challenge of the MCP resource (design §5.1, §5.2). */
import { OAUTH_SCOPE } from './types.ts';
import type { RsConfig } from './types.ts';

export const PUBLIC_CORS_HEADERS: Readonly<Record<string, string>> = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'www-authenticate, mcp-protocol-version',
};

/** Exactly one authorization server; scopes_supported is only `ontos`. */
export const protectedResourceMetadata = (config: Pick<RsConfig, 'resourceUrl' | 'issuer' | 'connectGuideUrl'>) => ({
  resource: config.resourceUrl,
  authorization_servers: [config.issuer],
  scopes_supported: [OAUTH_SCOPE],
  bearer_methods_supported: ['header'],
  resource_name: 'OntOS',
  resource_documentation: config.connectGuideUrl,
});

/** Root and path-inserted PRM paths, e.g. ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']. */
export const prmPaths = (resourceUrl: string): readonly string[] => {
  const { pathname } = new URL(resourceUrl);
  const root = '/.well-known/oauth-protected-resource';
  return pathname === '/' ? [root] : [root, `${root}${pathname}`];
};

/** ASCII only (HTTP header). `error="invalid_token"` only when a token was sent. */
export const wwwAuthenticate = (prmUrl: string, tokenWasSent: boolean): string =>
  tokenWasSent
    ? `Bearer resource_metadata="${prmUrl}", scope="${OAUTH_SCOPE}", error="invalid_token"`
    : `Bearer resource_metadata="${prmUrl}", scope="${OAUTH_SCOPE}"`;

export const unauthorizedResponse = (prmUrl: string, tokenWasSent: boolean): Response =>
  Response.json(
    tokenWasSent
      ? { error: 'invalid_token', error_description: 'Přístupový token neplatí. Připojte aplikaci znovu.' }
      : { error: 'unauthorized', error_description: 'Chybí přístupový token. Připojte aplikaci přes OAuth.' },
    { headers: { ...PUBLIC_CORS_HEADERS, 'cache-control': 'no-store', 'www-authenticate': wwwAuthenticate(prmUrl, tokenWasSent) }, status: 401 },
  );

export const prmResponse = (config: Pick<RsConfig, 'resourceUrl' | 'issuer' | 'connectGuideUrl'>): Response =>
  Response.json(protectedResourceMetadata(config), { headers: { ...PUBLIC_CORS_HEADERS, 'cache-control': 'public, max-age=300' } });
