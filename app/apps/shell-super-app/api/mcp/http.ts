/**
 * The Shell's stateless MCP endpoint (Streamable HTTP, `<shell>/mcp`) and its RFC 9728 Protected Resource Metadata.
 * Web-standard Request -> Response only, so the same pipeline runs in the Node BFF and in the Cloudflare Worker. No
 * sessions, no URL tokens, no API keys: every request carries its own OAuth access token and is verified, described
 * and served from scratch.
 */
import { createMcpHandler } from '@modelcontextprotocol/server';

import { buildMcpServer } from './server-factory.ts';
import type { ToolSpec } from './types.ts';

export const OAUTH_SCOPE = 'ontos';

export interface McpEndpointConfig {
  /** Exact authorization server issuer. */
  readonly issuer: string;
  /** Protected Resource Metadata URL, `<shell>/.well-known/oauth-protected-resource/mcp`. */
  readonly prmUrl: string;
  /** `<shell>` (links for people). */
  readonly publicOrigin: string;
  /** `<shell>/mcp` = access-token audience. */
  readonly resource: string;
}

export type McpAuthentication =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'ok'; readonly clientId: string; readonly grantId: string; readonly tools: () => readonly ToolSpec[] }
  | { readonly kind: 'unavailable' };

export interface McpEndpointDeps {
  readonly authenticate: (token: string) => Promise<McpAuthentication>;
  readonly config: (request: Request) => Promise<McpEndpointConfig>;
}

export const PUBLIC_CORS_HEADERS: Readonly<Record<string, string>> = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'www-authenticate, mcp-protocol-version',
};

const PREFLIGHT_HEADERS: Readonly<Record<string, string>> = {
  ...PUBLIC_CORS_HEADERS,
  'access-control-allow-headers':
    'authorization, content-type, accept, mcp-protocol-version, mcp-method, mcp-name, last-event-id',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-max-age': '600',
};

export const protectedResourceMetadata = (config: McpEndpointConfig) => ({
  authorization_servers: [config.issuer],
  bearer_methods_supported: ['header'],
  resource: config.resource,
  resource_documentation: `${config.publicOrigin}/cs/profil`,
  resource_name: 'OntOS',
  scopes_supported: [OAUTH_SCOPE],
});

/** ASCII only (HTTP header). `error="invalid_token"` only when a token was sent. */
export const wwwAuthenticate = (prmUrl: string, tokenWasSent: boolean): string =>
  tokenWasSent
    ? `Bearer resource_metadata="${prmUrl}", scope="${OAUTH_SCOPE}", error="invalid_token"`
    : `Bearer resource_metadata="${prmUrl}", scope="${OAUTH_SCOPE}"`;

const json = (status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): Response =>
  Response.json(body, { headers: { ...PUBLIC_CORS_HEADERS, 'cache-control': 'no-store', ...headers }, status });

export const unauthorizedResponse = (prmUrl: string, tokenWasSent: boolean): Response =>
  json(
    401,
    tokenWasSent
      ? { error: 'invalid_token', error_description: 'Přístupový token neplatí. Připojte aplikaci znovu.' }
      : { error: 'unauthorized', error_description: 'Chybí přístupový token. Připojte aplikaci přes OAuth.' },
    { 'www-authenticate': wwwAuthenticate(prmUrl, tokenWasSent) },
  );

const unavailableResponse = (): Response =>
  json(
    503,
    { error: 'temporarily_unavailable', error_description: 'OntOS je dočasně nedostupný. Zkuste to za chvíli.' },
    { 'retry-after': '5' },
  );

const escapeHtml = (value: string): string =>
  value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');

/** Czech landing page for browser visits of the MCP URL. */
export const landingPage = (config: McpEndpointConfig): Response => {
  const resource = escapeHtml(config.resource);
  const guide = escapeHtml(`${config.publicOrigin}/cs/profil`);
  const html =
    '<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width, initial-scale=1"><title>OntOS MCP</title></head>' +
    '<body style="font-family: system-ui, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1rem; line-height: 1.5">' +
    '<h1>OntOS MCP</h1><p>Toto je adresa MCP serveru OntOS. Vložte ji do ChatGPT, Claude nebo jiné aplikace.</p>' +
    `<p><code>${resource}</code></p>` +
    '<p>Po vložení adresy se otevře přihlášení do OntOS. Tam zvolíte firmu, za koho bude aplikace jednat a jak smí zapisovat.</p>' +
    `<p><a href="${guide}">Návod: jak připojit aplikaci</a></p></body></html>`;
  return new Response(html, {
    headers: { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex' },
  });
};

const BEARER = /^Bearer\s+(\S+)$/iu;

/** Serves `/.well-known/oauth-protected-resource[/mcp]`. */
export const createMcpMetadataFetch =
  (deps: Pick<McpEndpointDeps, 'config'>) =>
  async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: PREFLIGHT_HEADERS, status: 204 });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { headers: { allow: 'GET, HEAD, OPTIONS' }, status: 405 });
    }
    const config = await deps.config(request);
    return Response.json(protectedResourceMetadata(config), {
      headers: { ...PUBLIC_CORS_HEADERS, 'cache-control': 'public, max-age=300' },
    });
  };

/** Serves the MCP endpoint itself. */
export const createMcpFetch = (deps: McpEndpointDeps) => {
  const handler = createMcpHandler(
    (context) => {
      const tools = context.authInfo?.extra?.['tools'];
      if (typeof tools !== 'function') {
        throw new Error('missing connection tools');
      }
      return buildMcpServer((tools as () => readonly ToolSpec[])());
    },
    {
      // Current MCP revision only: 2025-era requests get the unsupported-version error naming 2026-07-28.
      legacy: 'reject',
      onerror: (error) => {
        console.error(`mcp handler error: ${error.message}`);
      },
    },
  );

  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: PREFLIGHT_HEADERS, status: 204 });
    }
    const config = await deps.config(request);
    if (request.method === 'GET' && !(request.headers.get('accept') ?? '').includes('text/event-stream')) {
      return landingPage(config);
    }
    const bearer = BEARER.exec((request.headers.get('authorization') ?? '').trim())?.[1];
    if (bearer === undefined) {
      return unauthorizedResponse(config.prmUrl, false);
    }
    const authentication = await deps.authenticate(bearer);
    if (authentication.kind === 'invalid') {
      return unauthorizedResponse(config.prmUrl, true);
    }
    if (authentication.kind === 'unavailable') {
      return unavailableResponse();
    }
    const started = Date.now();
    const response = await handler.fetch(request, {
      authInfo: {
        clientId: authentication.clientId,
        extra: { tools: authentication.tools },
        resource: new URL(config.resource),
        scopes: [OAUTH_SCOPE],
        token: bearer,
      },
    });
    console.log(
      JSON.stringify({
        event: 'mcp.request',
        grantId: authentication.grantId,
        method: request.method,
        ms: Date.now() - started,
        status: response.status,
      }),
    );
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(PUBLIC_CORS_HEADERS)) {
      headers.set(name, value);
    }
    if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      headers.set('cache-control', 'no-cache');
      headers.set('x-accel-buffering', 'no');
    }
    return new Response(response.body, { headers, status: response.status, statusText: response.statusText });
  };
};
