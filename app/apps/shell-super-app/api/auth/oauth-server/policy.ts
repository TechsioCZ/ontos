/**
 * HTTP policy of the shell's OAuth 2.1 authorization server (ONTOS-MCP-AUTH-DESIGN.md §1, §2.2, §2.4). Pure functions.
 * Better Auth runs with basePath OAUTH_BASE_PATH; only the endpoints below are reachable over HTTP. CIMD only: dynamic
 * client registration (/oauth2/register) is never mounted (NO-COMPAT rule).
 */
import type { Effect } from 'effect';

export const OAUTH_BFF_PREFIX = '/shell-super-app-api';
export const OAUTH_BASE_PATH = '/shell-super-app-api/oauth';
export const OAUTH_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'ontos'] as const;
export const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 600;
export const OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 3600;
export const OAUTH_LOGIN_PAGE = '/cs/login';
export const OAUTH_CONNECT_PAGE = '/cs/pripojit';
export const OAUTH_CONSENT_PAGE = '/cs/pripojit/souhlas';

/** Checks the HTTP mount runs before Better Auth sees a token or consent request. Neither check ever fails. */
export interface OAuthEndpointGuards {
  /** `true` when this browser session's connection grant is approved (status active); consent accept needs it. */
  readonly consentApproved: (headers: Headers) => Effect.Effect<boolean>;
  /**
   * `reused`: the refresh token was already rotated and the 30 s grace period is over; with `revokeOnReuse` the check
   * revokes that one grant (its tokens, binding and status) and writes audit `oauth.token.refresh_reuse` (§2.5).
   * `dead`: revoked without rotation. `pass`: Better Auth decides (live token, replay grace, unknown token).
   */
  readonly refreshTokenStatus: (
    refreshToken: string,
    options: { readonly revokeOnReuse: boolean },
  ) => Effect.Effect<RefreshTokenVerdict>;
}

export type RefreshTokenVerdict = 'dead' | 'pass' | 'reused';

/** What the authentication service exposes to the HTTP mount. */
export interface OAuthServerEndpoint {
  readonly guards?: OAuthEndpointGuards;
  /** Better Auth `auth.handler`; receives absolute issuer-prefixed URLs. */
  readonly handler: (request: Request) => Promise<Response>;
  /** Exact issuer string, e.g. http://localhost:3020/shell-super-app-api/oauth (no trailing slash). */
  readonly issuer: string;
}

/** `http://localhost:3020` (or with a trailing slash) -> `http://localhost:3020/shell-super-app-api/oauth`. */
export const oauthIssuerFor = (baseUrl: string): string => `${new URL(baseUrl).origin}${OAUTH_BASE_PATH}`;

const PUBLIC_OAUTH2_ENDPOINTS: ReadonlySet<string> = new Set([
  'authorize',
  'consent',
  'continue',
  'end-session',
  'public-client-prelogin',
  'revoke',
  'token',
  'userinfo',
]);
const METADATA_PATHS: ReadonlySet<string> = new Set([
  '/jwks',
  '/.well-known/oauth-authorization-server',
  '/.well-known/openid-configuration',
]);

export type OAuthRouteKind = 'blocked' | 'endpoint' | 'metadata';

/** The BFF transport may see the path without the `/shell-super-app-api` prefix; this restores it. */
export const fullOAuthPath = (pathname: string): string =>
  pathname.startsWith(`${OAUTH_BFF_PREFIX}/`) ? pathname : `${OAUTH_BFF_PREFIX}${pathname}`;

/** Only these Better Auth routes are served; everything else under the basePath answers 404. */
export const classifyOAuthPath = (fullPath: string): OAuthRouteKind => {
  if (!fullPath.startsWith(`${OAUTH_BASE_PATH}/`)) {
    return 'blocked';
  }
  const rest = fullPath.slice(OAUTH_BASE_PATH.length);
  if (METADATA_PATHS.has(rest)) {
    return 'metadata';
  }
  if (rest === '/error') {
    return 'endpoint';
  }
  if (rest.startsWith('/oauth2/') && PUBLIC_OAUTH2_ENDPOINTS.has(rest.slice('/oauth2/'.length))) {
    return 'endpoint';
  }
  return 'blocked';
};

const METADATA_CORS_HEADERS = {
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-origin': '*',
} as const;

/**
 * no-store on every authorization endpoint; anonymous CORS and a 5 minute cache on metadata and JWKS. Better Auth's own
 * 15 second metadata lifetime is replaced: the Worker answers discovery from the edge cache for this lifetime.
 */
export const withOAuthResponseHeaders = (kind: 'endpoint' | 'metadata', response: Response): Response => {
  const headers = new Headers(response.headers);
  headers.delete('access-control-allow-credentials');
  if (kind === 'endpoint') {
    headers.set('cache-control', 'no-store');
    headers.set('pragma', 'no-cache');
  } else {
    for (const [name, value] of Object.entries(METADATA_CORS_HEADERS)) {
      headers.set(name, value);
    }
    headers.set('cache-control', 'public, max-age=300');
  }
  return new Response(response.body, { headers, status: response.status, statusText: response.statusText });
};

export const oauthPreflightResponse = (): Response => new Response(null, { headers: METADATA_CORS_HEADERS, status: 204 });

export const oauthNotFoundResponse = (): Response =>
  new Response('{"error":"not_found"}', {
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
    status: 404,
  });

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** http on localhost, 127.0.0.1 or [::1], without credentials or fragment. */
export const isLoopbackRedirectUri = (uri: string): boolean => {
  if (!URL.canParse(uri)) {
    return false;
  }
  const url = new URL(uri);
  return (
    url.protocol === 'http:' &&
    LOOPBACK_HOSTNAMES.has(url.hostname) &&
    url.username === '' &&
    url.password === '' &&
    url.hash === ''
  );
};

/**
 * Better Auth `validateRedirectUri`: keep the built-in exact match, and accept a loopback redirect on ANY port when a
 * registered loopback URI has the same host, path and query (RFC 8252 §7.3; Claude Code registers
 * http://localhost/callback and uses an ephemeral port).
 */
export const validateAuthorizeRedirectUri = (
  redirectUri: string,
  registeredUris: readonly string[],
  defaultResult: boolean,
): boolean => {
  if (defaultResult) {
    return true;
  }
  if (!isLoopbackRedirectUri(redirectUri)) {
    return false;
  }
  const requested = new URL(redirectUri);
  return registeredUris.some((registered) => {
    if (!isLoopbackRedirectUri(registered)) {
      return false;
    }
    const candidate = new URL(registered);
    return (
      candidate.hostname === requested.hostname &&
      candidate.pathname === requested.pathname &&
      candidate.search === requested.search
    );
  });
};

/**
 * Better Auth issues a refresh token only with `offline_access`. MCP hosts request the scope the resource server
 * challenges with (`ontos`), so the authorization request gets `offline_access` added whenever it asks for `ontos`;
 * otherwise the host would have to sign in again every 10 minutes (§2.5, spike S3). A signed query (`sig`) is left
 * untouched because its scope is already part of the signature.
 */
export const withOfflineAccess = (search: string): string => {
  const params = new URLSearchParams(search);
  const scope = params.get('scope');
  if (scope === null || params.has('sig')) {
    return search;
  }
  const scopes = scope.split(' ').filter((value) => value !== '');
  if (!scopes.includes('ontos') || scopes.includes('offline_access')) {
    return search;
  }
  params.set('scope', [...scopes, 'offline_access'].join(' '));
  return `?${params.toString()}`;
};

const UNSERVED_METADATA_FIELDS = [
  'introspection_endpoint',
  'introspection_endpoint_auth_methods_supported',
  'introspection_endpoint_auth_signing_alg_values_supported',
] as const;
const PUBLIC_CLIENT_AUTH_METHODS = ['none', 'private_key_jwt'] as const;

/**
 * Metadata advertises only what this CIMD-only public AS serves: no introspection endpoint (§2.1) and no client
 * secret authentication methods. Every other field stays as Better Auth wrote it.
 */
export const publicMetadataDocument = (document: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const result: Record<string, unknown> = { ...document };
  for (const field of UNSERVED_METADATA_FIELDS) {
    delete result[field];
  }
  for (const field of ['token_endpoint_auth_methods_supported', 'revocation_endpoint_auth_methods_supported']) {
    if (Array.isArray(result[field])) {
      result[field] = [...PUBLIC_CLIENT_AUTH_METHODS];
    }
  }
  return result;
};

/** Error codes the login page explains in Czech (`/cs/login?oauth_error=<code>`). */
export type OAuthErrorPageCode = 'invalid_client' | 'invalid_redirect' | 'request_failed';

/** Better Auth error code (`invalid_redirect`, `invalid_client`, `invalid_request` ...) -> code of the error page. */
export const oauthErrorPageCode = (error: string | null | undefined): OAuthErrorPageCode => {
  if (error === null || error === undefined) {
    return 'request_failed';
  }
  if (error.includes('redirect')) {
    return 'invalid_redirect';
  }
  return error.includes('client') ? 'invalid_client' : 'request_failed';
};

/**
 * Where the browser goes when the authorization request cannot be returned to the client (unknown client, redirect
 * not registered): the Czech login page with an error card instead of the form (§3.4). Never the client's redirect.
 */
export const oauthErrorPageLocation = (error: string | null | undefined): string =>
  `${OAUTH_LOGIN_PAGE}?oauth_error=${oauthErrorPageCode(error)}`;

export const oauthErrorPageRedirect = (error: string | null | undefined): Response =>
  new Response(null, {
    headers: { 'cache-control': 'no-store', location: oauthErrorPageLocation(error), pragma: 'no-cache' },
    status: 302,
  });

/** RFC 6749 JSON error with no-store (token and consent guards). */
export const oauthJsonError = (status: number, error: string, description: string): Response =>
  new Response(JSON.stringify({ error, error_description: description }), {
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json', pragma: 'no-cache' },
    status,
  });
