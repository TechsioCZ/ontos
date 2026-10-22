// @effect-diagnostics asyncFunction:off -- Modern.js server middleware (Hono) is a Promise boundary: it serves the RFC 8414 path-inserted OAuth metadata URLs and sets security headers on the OAuth login and connect pages. expires: 2027-03-31.
import { rootRouteTarget } from '../shared/mcp-resource.ts';
import { oauthMetadataTarget } from '../shared/oauth-metadata-routes.ts';

const OAUTH_PAGE_PATH = /^\/(?:cs|en)\/(?:login|pripojit|connect)(?:\/.*)?$/u;

export const isOAuthPagePath = (path: string): boolean => OAUTH_PAGE_PATH.test(path);

export interface MiddlewareContext {
  readonly req: { readonly method: string; readonly path: string; readonly raw?: Request; readonly url?: string };
  res: Response;
}
type Next = () => Promise<void>;

const METADATA_CORS_HEADERS = {
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-origin': '*',
} as const;

export const serveRootMetadataAlias =
  (handleCanonical: (request: Request) => Promise<Response>) =>
  async (context: MiddlewareContext, next: Next): Promise<Response | undefined> => {
    const target = oauthMetadataTarget(context.req.path);
    if (target === undefined) {
      await next();
      return undefined;
    }
    if (context.req.method === 'OPTIONS') {
      return new Response(null, { headers: METADATA_CORS_HEADERS, status: 204 });
    }
    if (context.req.method !== 'GET' && context.req.method !== 'HEAD') {
      return new Response(null, { headers: { ...METADATA_CORS_HEADERS, allow: 'GET, HEAD, OPTIONS' }, status: 405 });
    }
    // Only the origin is carried into the canonical request; Better Auth pins its configured issuer.
    const canonical = new URL(target, context.req.url ?? 'https://shell.invalid');
    const upstream = await handleCanonical(new Request(canonical, { headers: { accept: 'application/json' } }));
    const body = await upstream.text();
    const headers = new Headers(upstream.headers);
    headers.delete('content-length');
    headers.delete('access-control-allow-credentials');
    for (const [name, value] of Object.entries(METADATA_CORS_HEADERS)) {
      headers.set(name, value);
    }
    return new Response(context.req.method === 'HEAD' ? null : body, { headers, status: upstream.status });
  };

const BFF_PREFIX = '/shell-super-app-api';

/**
 * Root routes the BFF owns (`/mcp`, its Protected Resource Metadata): any method, served in-process by the BFF
 * handler with the request path rewritten to the BFF route. The Cloudflare Worker does the same via `rootRouteTarget`.
 */
export const serveRootRoute =
  (handle: (request: Request) => Promise<Response>) =>
  async (context: MiddlewareContext, next: Next): Promise<Response | undefined> => {
    const target = rootRouteTarget(context.req.path);
    const raw = context.req.raw;
    if (target === undefined || raw === undefined) {
      await next();
      return undefined;
    }
    const url = new URL(raw.url);
    url.pathname = target.slice(BFF_PREFIX.length);
    return handle(new Request(url, raw));
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
      handler: serveRootMetadataAlias(async (request) => {
        const { handleOAuthMetadata } = await import('../api/index.ts');
        return handleOAuthMetadata(request);
      }),
      name: 'ontos-oauth-root-metadata',
      order: 'pre',
    },
    {
      handler: serveRootRoute(async (request) => {
        const { handleRootRoute } = await import('../api/index.ts');
        return handleRootRoute(request);
      }),
      name: 'ontos-bff-root-routes',
      order: 'pre',
    },
    { handler: oauthPageSecurityHeaders, name: 'ontos-oauth-page-headers', order: 'pre' },
  ],
};
