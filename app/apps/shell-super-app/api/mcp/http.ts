/**
 * The Shell's stateless MCP endpoint (Streamable HTTP, `<shell>/mcp`) and its RFC 9728 Protected Resource Metadata.
 * Web-standard Request -> Response only, so the same pipeline runs in the Node BFF and in the Cloudflare Worker. No
 * sessions, no URL tokens, no API keys: every request carries its own OAuth access token and is verified, described
 * and served from scratch.
 */
import { Duration, Effect, Function as Fn, Schema } from 'effect';
import { HttpServerResponse } from 'effect/http';

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
  | {
      readonly clientId: string;
      readonly grantId: string;
      readonly kind: 'ok';
      readonly tools: () => readonly ToolSpec[];
    }
  | { readonly kind: 'unavailable' };

/** Per-request inputs of the endpoint; the Shell transport reads them from the request's services. */
export interface McpEndpointDeps<Failure = never, Requirements = never> {
  readonly authenticate: (token: string) => Effect.Effect<McpAuthentication, Failure, Requirements>;
  readonly config: Effect.Effect<McpEndpointConfig, Failure, Requirements>;
}

export const PUBLIC_CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'www-authenticate, mcp-protocol-version',
};

const PREFLIGHT_HEADERS = {
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

const McpErrorResponseSchema = Schema.Struct({ error: Schema.String, error_description: Schema.String });
const ProtectedResourceMetadataSchema = Schema.Struct({
  authorization_servers: Schema.Array(Schema.String),
  bearer_methods_supported: Schema.Array(Schema.String),
  resource: Schema.String,
  resource_documentation: Schema.String,
  resource_name: Schema.String,
  scopes_supported: Schema.Array(Schema.String),
});

const json = (
  status: number,
  body: typeof McpErrorResponseSchema.Type,
  headers: Readonly<Record<string, string>> = {},
): Response => {
  const response = HttpServerResponse.jsonUnsafe(body, {
    headers: { ...PUBLIC_CORS_HEADERS, 'cache-control': 'no-store', ...headers },
    status,
  }).pipe(HttpServerResponse.toWeb);
  response.headers.delete('content-length');
  return response;
};

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
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

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
  return HttpServerResponse.raw(html, {
    headers: { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex' },
  }).pipe(HttpServerResponse.toWeb);
};

const BEARER = /^Bearer\s+(?<token>\S+)$/iu;

/** Serves `/.well-known/oauth-protected-resource[/mcp]`. */
export const serveMcpMetadata =
  <Failure, Requirements>(deps: Pick<McpEndpointDeps<Failure, Requirements>, 'config'>) =>
  (request: Request): Effect.Effect<Response, Failure, Requirements> => {
    if (request.method === 'OPTIONS') {
      return Effect.succeed(
        HttpServerResponse.empty({ headers: PREFLIGHT_HEADERS, status: 204 }).pipe(HttpServerResponse.toWeb),
      );
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return Effect.succeed(
        HttpServerResponse.empty({ headers: { allow: 'GET, HEAD, OPTIONS' }, status: 405 }).pipe(
          HttpServerResponse.toWeb,
        ),
      );
    }
    return deps.config.pipe(
      Effect.flatMap((config) =>
        HttpServerResponse.schemaJson(ProtectedResourceMetadataSchema)(protectedResourceMetadata(config), {
          headers: { ...PUBLIC_CORS_HEADERS, 'cache-control': 'public, max-age=300' },
        }),
      ),
      Effect.orDie,
      Effect.map((response) => {
        const adapted = HttpServerResponse.toWeb(response);
        adapted.headers.delete('content-length');
        return adapted;
      }),
    );
  };

/** Serves the MCP endpoint itself. */
export const serveMcp = <Failure, Requirements>(deps: McpEndpointDeps<Failure, Requirements>) =>
  Effect.fn('Mcp.serve')(function* serveMcpRequest(
    request: Request,
  ): Effect.fn.Return<Response, Failure, Requirements> {
    if (request.method === 'OPTIONS') {
      return HttpServerResponse.empty({ headers: PREFLIGHT_HEADERS, status: 204 }).pipe(HttpServerResponse.toWeb);
    }
    const config = yield* deps.config;
    if (request.method === 'GET' && !(request.headers.get('accept') ?? '').includes('text/event-stream')) {
      return landingPage(config);
    }
    const bearer = BEARER.exec((request.headers.get('authorization') ?? '').trim())?.groups?.['token'];
    if (bearer === undefined) {
      return unauthorizedResponse(config.prmUrl, false);
    }
    const authentication = yield* deps.authenticate(bearer);
    if (authentication.kind === 'invalid') {
      return unauthorizedResponse(config.prmUrl, true);
    }
    if (authentication.kind === 'unavailable') {
      return unavailableResponse();
    }
    // Only an authenticated MCP request evaluates the SDK and its protocol schemas. Gateway,
    // metadata, preflight, landing-page and rejected requests do not need that runtime.
    // This is local module loading, not external I/O; its Promise stays at the Effect adapter boundary.
    const [sdk, { buildMcpServer }] = yield* Effect.promise(
      Fn.constant(Promise.all([import('@modelcontextprotocol/server'), import('./server-factory.ts')])),
    );
    // The SDK calls back with Promises; tools and logs run with the services of this request.
    const services = yield* Effect.context();
    const handler = sdk.createMcpHandler(
      () => buildMcpServer(authentication.tools(), { run: Effect.runPromiseWith(services), sdk }),
      {
        // Current MCP revision only: 2025-era requests get the unsupported-version error naming 2026-07-28.
        legacy: 'reject',
        onerror: (error) => {
          Effect.runForkWith(services)(Effect.logError(`mcp handler error: ${error.message}`));
        },
      },
    );
    const [elapsed, response] = yield* Effect.timed(
      Effect.promise(
        // Effect creates its cancellation signal only for a callback with nonzero runtime arity.
        // compose preserves this unary boundary; flow's variadic wrapper has length zero.
        Fn.compose(
          (signal: AbortSignal) =>
            Promise.resolve.bind<typeof Promise, [Response | PromiseLike<Response>], [], Promise<Response>>(
              Promise,
              handler.fetch(new Request(request, { signal: AbortSignal.any([request.signal, signal]) }), {
                authInfo: {
                  clientId: authentication.clientId,
                  resource: new URL(config.resource),
                  scopes: [OAUTH_SCOPE],
                  token: bearer,
                },
              }),
            ),
          Fn.apply({}),
        ),
      ).pipe(
        Effect.timeoutOrElse({
          duration: '2 minutes',
          orElse: () => Effect.succeed(unavailableResponse()),
        }),
      ),
    );
    yield* Effect.logInfo('mcp.request').pipe(
      Effect.annotateLogs({
        grantId: authentication.grantId,
        method: request.method,
        ms: Duration.toMillis(elapsed),
        status: response.status,
      }),
    );
    const adapted = HttpServerResponse.raw(response, { headers: PUBLIC_CORS_HEADERS }).pipe(HttpServerResponse.toWeb);
    if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      adapted.headers.set('cache-control', 'no-cache');
      adapted.headers.set('x-accel-buffering', 'no');
    }
    return adapted;
  });
