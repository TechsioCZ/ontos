/**
 * Stateless OAuth resource server (design §5.1–§5.2). One web-standard fetch pipeline in front of an SDK v2 stateless
 * handler; the node:http server only adapts sockets. No sessions, no URL tokens, no API keys: every request carries
 * its own bearer JWT and is verified, described and served from scratch.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { buildMcpServer } from './mcp/server-factory.ts';
import type { ConnectionContext, ToolSpec } from './mcp/types.ts';
import { PUBLIC_CORS_HEADERS, prmPaths, prmResponse, unauthorizedResponse } from './oauth/prm.ts';
import type { ConnectionDescription, RsConfig, VerifiedAccessToken } from './oauth/types.ts';
import { ConnectionInactiveError, ConnectorUnavailableError } from './oauth/types.ts';
import type { OAuthConnectionSession } from './session.ts';

export interface OntosMcpDeps {
  readonly config: RsConfig;
  readonly verifyAccessToken: (token: string) => Promise<VerifiedAccessToken>;
  readonly describeConnection: (token: VerifiedAccessToken) => Promise<ConnectionDescription>;
  readonly buildTools: (connection: ConnectionContext) => Promise<readonly ToolSpec[]>;
}

export interface RunningHttpServer {
  readonly url: string;
  readonly close: () => Promise<void>;
}

const MCP_KEEP_ALIVE_MS = 15_000;
const UNAVAILABLE_BODY = {
  error: 'temporarily_unavailable',
  error_description: 'OntOS je dočasně nedostupný. Zkuste to za chvíli.',
};

const escapeHtml = (value: string): string =>
  value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');

/** Czech HTML landing page for browser GETs of the MCP endpoint. */
export const landingPage = (config: Pick<RsConfig, 'resourceUrl' | 'connectGuideUrl'>): Response => {
  const resourceUrl = escapeHtml(config.resourceUrl);
  const connectGuideUrl = escapeHtml(config.connectGuideUrl);
  const html =
    '<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width, initial-scale=1"><title>OntOS MCP server</title></head>' +
    '<body style="font-family: system-ui, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1rem; line-height: 1.5">' +
    '<h1>OntOS MCP server</h1>' +
    '<p>Toto je adresa MCP serveru OntOS. Vložte ji do ChatGPT nebo Claude.</p>' +
    `<p><code>${resourceUrl}</code></p>` +
    '<p>Po vložení adresy se otevře přihlášení do OntOS. Tam zvolíte firmu, za koho bude aplikace jednat a jak smí zapisovat.</p>' +
    `<p><a href="${connectGuideUrl}">Návod: jak připojit aplikaci</a></p>` +
    '</body></html>';
  return new Response(html, {
    headers: { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex' },
    status: 200,
  });
};

const jsonError = (status: number, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Response =>
  Response.json(body, {
    headers: { ...PUBLIC_CORS_HEADERS, 'cache-control': 'no-store', ...extraHeaders },
    status,
  });

const unavailableResponse = (): Response => jsonError(503, UNAVAILABLE_BODY, { 'retry-after': '5' });

const BEARER = /^Bearer\s+(.+)$/iu;

export const createOntosMcpFetch = (deps: OntosMcpDeps): ((request: Request) => Promise<Response>) => {
  const { config } = deps;
  const handler = createMcpHandler(
    async (ctx) => {
      const connection = ctx.authInfo?.extra?.['connection'] as ConnectionContext | undefined;
      if (connection === undefined) {
        throw new Error('missing connection context');
      }
      return buildMcpServer(await deps.buildTools(connection));
    },
    {
      keepAliveMs: MCP_KEEP_ALIVE_MS,
      onerror: (error) => {
        process.stderr.write(`mcp handler error: ${error.message}\n`);
      },
    },
  );
  const paths = prmPaths(config.resourceUrl);
  const mcpPath = new URL(config.resourceUrl).pathname;

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const { pathname } = url;

    // 1. Host allow-list (DNS rebinding guard).
    const host = request.headers.get('host') ?? '';
    if (config.allowedHosts.length > 0 && !config.allowedHosts.includes(host)) {
      return jsonError(403, { error: 'Nepovolený Host.' });
    }

    // 2. CORS preflight.
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          ...PUBLIC_CORS_HEADERS,
          'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
          'access-control-allow-headers': 'authorization, content-type, accept, mcp-protocol-version, mcp-method, mcp-name, last-event-id',
          'access-control-max-age': '600',
        },
        status: 204,
      });
    }

    // 3. Liveness.
    if (request.method === 'GET' && pathname === '/healthz') {
      return Response.json({ name: 'ontos-mcp', ok: true }, { headers: { ...PUBLIC_CORS_HEADERS, 'cache-control': 'no-store' } });
    }

    // 4. Protected Resource Metadata (root and path-inserted).
    if (request.method === 'GET' && paths.includes(pathname)) {
      return prmResponse(config);
    }

    // 5. Only the MCP endpoint itself is served.
    if (pathname !== mcpPath) {
      return jsonError(404, { error: 'Neznámá cesta.' });
    }

    // 6. Origin allow-list, only when the client sends an Origin.
    const origin = request.headers.get('origin');
    if (origin !== null && !config.allowedOrigins.includes(origin)) {
      return jsonError(403, { error: 'Nepovolený Origin.' });
    }

    // 7. Browser visitors get the landing page instead of a 401.
    if (request.method === 'GET' && !(request.headers.get('accept') ?? '').includes('text/event-stream')) {
      return landingPage(config);
    }

    // 8. Bearer token presence.
    const match = BEARER.exec((request.headers.get('authorization') ?? '').trim());
    if (match === null || match[1] === undefined) {
      return unauthorizedResponse(config.prmUrl, false);
    }
    const bearer = match[1];

    // 9. Local JWT verification (issuer, audience, signature, expiry, scope, grant claim).
    let verified: VerifiedAccessToken;
    try {
      verified = await deps.verifyAccessToken(bearer);
    } catch (error) {
      if (error instanceof ConnectorUnavailableError) {
        return unavailableResponse();
      }
      return unauthorizedResponse(config.prmUrl, true);
    }

    // 10. The grant must still be active at the shell.
    let description: ConnectionDescription;
    try {
      description = await deps.describeConnection(verified);
    } catch (error) {
      if (error instanceof ConnectionInactiveError) {
        return unauthorizedResponse(config.prmUrl, true);
      }
      return unavailableResponse();
    }

    // 11. Per-request connection context; the user token only ever reaches the shell connector.
    const session: OAuthConnectionSession = {
      accessToken: verified.token,
      connectorSecret: config.connectorSecret,
      grantId: verified.grantId,
      kind: 'oauth_connection',
      label: `${description.acting.displayName} přes ${description.client.name}`,
      legalEntityId: description.legalEntityId,
      transport: 'http',
      writePolicyOverride: undefined,
    };
    const connection: ConnectionContext = { description, session, token: verified };

    // 12. Serve the MCP request statelessly.
    const started = Date.now();
    const response = await handler.fetch(request, {
      authInfo: {
        clientId: verified.clientId,
        expiresAt: verified.expiresAt,
        extra: { connection },
        resource: new URL(config.resourceUrl),
        scopes: [...verified.scopes],
        token: verified.token,
      },
    });
    process.stderr.write(
      `${JSON.stringify({ event: 'mcp.request', grantId: verified.grantId, method: request.method, status: response.status, ms: Date.now() - started })}\n`,
    );

    // 13. CORS on every MCP response; SSE must not be buffered by proxies.
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(PUBLIC_CORS_HEADERS)) {
      headers.set(name, value);
    }
    if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      headers.set('x-accel-buffering', 'no');
      headers.set('cache-control', 'no-cache');
    }
    return new Response(response.body, { headers, status: response.status, statusText: response.statusText });
  };
};

/** node:http listener around the fetch pipeline. `port: 0` picks a free port (tests). */
export const startHttpServer = async (deps: OntosMcpDeps): Promise<RunningHttpServer> => {
  const fetchHandler = createOntosMcpFetch(deps);
  const nodeHandler = toNodeHandler(
    { fetch: fetchHandler },
    {
      onerror: (error) => {
        process.stderr.write(`mcp http error: ${error.message}\n`);
      },
    },
  );
  const server = createServer((req, res) => {
    void nodeHandler(req as unknown as Parameters<typeof nodeHandler>[0], res as unknown as Parameters<typeof nodeHandler>[1]);
  });

  const port = await new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once('error', onError);
    server.listen(deps.config.port, deps.config.host, () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    });
  });

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
    url: `http://${deps.config.host}:${port}/mcp`,
  };
};
