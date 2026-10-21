// @effect-diagnostics asyncFunction:off globalFetch:off processEnv:off -- Modern.js server middleware (Hono) is a Promise boundary: it serves the RFC 8414 path-inserted OAuth metadata URLs and sets security headers on the OAuth login and connect pages. expires: 2027-03-31.
/**
 * Shell web-server middlewares of the OAuth authorization server (ONTOS-MCP-AUTH-DESIGN.md §2.1, §2.2).
 * Self-contained on purpose: Modern.js compiles server/ separately from api/.
 */
const OAUTH_ISSUER_PATH = '/shell-super-app-api/oauth';

/** Root discovery URL -> canonical issuer-relative document served by Better Auth inside the BFF. */
export const ROOT_METADATA_ALIASES: ReadonlyMap<string, string> = new Map([
  [`/.well-known/oauth-authorization-server${OAUTH_ISSUER_PATH}`, `${OAUTH_ISSUER_PATH}/.well-known/oauth-authorization-server`],
  [`/.well-known/openid-configuration${OAUTH_ISSUER_PATH}`, `${OAUTH_ISSUER_PATH}/.well-known/openid-configuration`],
]);

const OAUTH_PAGE_PATH = /^\/(?:cs|en)\/(?:login|pripojit|connect)(?:\/.*)?$/u;

export const isOAuthPagePath = (path: string): boolean => OAUTH_PAGE_PATH.test(path);

export const rootMetadataTarget = (path: string): string | undefined => ROOT_METADATA_ALIASES.get(path);

/** Origin the shell reaches itself on (Zerops: http://shellsuperapp:<port>). */
export const shellInternalOrigin = (environment: Readonly<Record<string, string | undefined>>): string =>
  (environment['ONTOS_SHELL_INTERNAL_URL'] ?? 'http://localhost:3020').replace(/\/+$/u, '');

export interface MiddlewareContext {
  readonly req: { readonly method: string; readonly path: string };
  res: Response;
}
type Next = () => Promise<void>;

const METADATA_CORS_HEADERS = {
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-origin': '*',
} as const;

export const serveRootMetadataAlias =
  (fetchCanonical: (url: string) => Promise<Response>, origin: () => string) =>
  async (context: MiddlewareContext, next: Next): Promise<Response | undefined> => {
    const target = rootMetadataTarget(context.req.path);
    if (target === undefined) {
      await next();
      return undefined;
    }
    if (context.req.method === 'OPTIONS') {
      return new Response(null, { headers: METADATA_CORS_HEADERS, status: 204 });
    }
    if (context.req.method !== 'GET' && context.req.method !== 'HEAD') {
      return new Response(null, { headers: { allow: 'GET, HEAD, OPTIONS' }, status: 405 });
    }
    const upstream = await fetchCanonical(`${origin()}${target}`);
    const body = await upstream.text();
    return new Response(context.req.method === 'HEAD' ? null : body, {
      headers: {
        ...METADATA_CORS_HEADERS,
        'cache-control': 'public, max-age=300',
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      },
      status: upstream.status,
    });
  };

export const oauthPageSecurityHeaders = async (context: MiddlewareContext, next: Next): Promise<void> => {
  await next();
  if (!isOAuthPagePath(context.req.path)) {
    return;
  }
  const headers = new Headers(context.res.headers);
  headers.set('cache-control', 'no-store');
  headers.set('content-security-policy', "frame-ancestors 'none'");
  headers.set('x-frame-options', 'DENY');
  context.res = new Response(context.res.body, {
    headers,
    status: context.res.status,
    statusText: context.res.statusText,
  });
};

export default {
  middlewares: [
    {
      handler: serveRootMetadataAlias(
        (url) => fetch(url, { headers: { accept: 'application/json' }, redirect: 'manual' }),
        () => shellInternalOrigin(process.env),
      ),
      name: 'ontos-oauth-root-metadata',
      order: 'pre',
    },
    { handler: oauthPageSecurityHeaders, name: 'ontos-oauth-page-headers', order: 'pre' },
  ],
};
