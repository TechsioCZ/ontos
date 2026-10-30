// @rstest-environment node
import { Effect } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it, rs } from 'effect-rstest';

import { fetchClientMetadataResource } from '../../api/auth/cimd-transport.workerd.ts';
import { forwardOAuthRequest } from '../../api/auth/oauth-server/forward.ts';
import {
  oauthErrorPageRedirect,
  oauthJsonError,
  oauthNotFoundResponse,
  oauthPreflightResponse,
  withOAuthResponseHeaders,
} from '../../api/auth/oauth-server/policy.ts';
import { serveMcp, serveMcpMetadata, unauthorizedResponse } from '../../api/mcp/http.ts';

let sdkResponse: Response;
let sdkRequest: Request | undefined;

// This fixture controls only the external SDK response, not the production response adapter.
rs.mock('@modelcontextprotocol/server', () => ({
  createMcpHandler: () => ({
    fetch: (request: Request) => {
      sdkRequest = request;
      return sdkResponse;
    },
  }),
}));

const config = {
  issuer: 'https://shell.test/shell-super-app-api/oauth',
  prmUrl: 'https://shell.test/.well-known/oauth-protected-resource/mcp',
  publicOrigin: 'https://shell.test',
  resource: 'https://shell.test/mcp',
};
const clientMetadataUrl = 'https://client.example/oauth/client.json';
const cookies = [
  'session=first; Path=/; HttpOnly; Secure; SameSite=None; Partitioned',
  'session=second; Path=/oauth; HttpOnly; Secure; Priority=High',
];
const headersWithCookies = (headers: HeadersInit): Headers => {
  const result = new Headers(headers);
  for (const cookie of cookies) {
    result.append('set-cookie', cookie);
  }
  return result;
};
const encode = (value: string) => new TextEncoder().encode(value);
const sdkDeps = {
  authenticate: () =>
    Effect.succeed({
      clientId: 'client',
      grantId: 'grant',
      kind: 'ok' as const,
      tools: () => [],
    }),
  config: Effect.succeed(config),
};
const mcpRequest = (signal: AbortSignal = new AbortController().signal) =>
  new Request(config.resource, {
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    headers: { accept: 'application/json, text/event-stream', authorization: 'Bearer credential' },
    method: 'POST',
    signal,
  });

it.effect('CIMD preserves exact UTF-8 bytes, status text and repeated cookies without adding a length', () =>
  Effect.gen(function* cimdBytesAndHeaders() {
    const bytes = encode('{\n "name": "Příliš 😀", "number": 1e2, "escaped": "\\u0061"\n}\n');
    const headers = headersWithCookies({
      'content-encoding': 'gzip',
      'content-length': '999',
      'content-type': 'application/json; charset=utf-8',
      etag: '"client-v2"',
      'x-client-metadata': 'retained',
    });
    const source = new Response(bytes, { headers, status: 203, statusText: 'Client Metadata' });
    const fetch = rs.fn<typeof globalThis.fetch>().mockResolvedValue(source);
    const response = yield* fetchClientMetadataResource(clientMetadataUrl).pipe(
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
    const expectedHeaders = new Headers(headers);
    expectedHeaders.delete('content-length');
    expectedHeaders.delete('content-encoding');
    expect(response.status).toBe(203);
    expect(response.statusText).toBe('Client Metadata');
    expect([...response.headers]).toEqual([...expectedHeaders]);
    expect(response.headers.getSetCookie()).toEqual(cookies);
    expect(new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))).toEqual(bytes);
  }),
);

it.effect('CIMD HEAD and conditional 304 retain bodyless headers and cancel an unused body', () =>
  Effect.gen(function* cimdBodylessHeaders() {
    for (const method of ['GET', 'HEAD']) {
      const cancel = rs.fn();
      const headers = headersWithCookies({ 'content-length': '123', etag: '"client-v3"' });
      const source = new Response(method === 'HEAD' ? new ReadableStream<Uint8Array>({ cancel }) : null, {
        headers,
        status: method === 'HEAD' ? 200 : 304,
        statusText: 'Conditional Metadata',
      });
      const fetch = rs.fn<typeof globalThis.fetch>().mockResolvedValue(source);
      const response = yield* fetchClientMetadataResource(clientMetadataUrl, { method }).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );
      expect(response.body).toBeNull();
      expect(response.status).toBe(source.status);
      expect(response.statusText).toBe(source.statusText);
      expect([...response.headers]).toEqual([...headers]);
      expect(response.headers.getSetCookie()).toEqual(cookies);
      expect(cancel).toHaveBeenCalledTimes(method === 'HEAD' ? 1 : 0);
    }
  }),
);

it.effect('OAuth policy retains exact error JSON and bodyless redirect/preflight responses', () =>
  Effect.gen(function* oauthStaticResponses() {
    const missing = oauthNotFoundResponse();
    expect(missing.status).toBe(404);
    expect([...missing.headers]).toEqual([
      ['cache-control', 'no-store'],
      ['content-type', 'application/json'],
    ]);
    expect(yield* Effect.promise(() => missing.text())).toBe('{"error":"not_found"}');
    const error = oauthJsonError(400, 'invalid_grant', 'Příliš "starý" token 😀');
    expect([...error.headers]).toEqual([
      ['cache-control', 'no-store'],
      ['content-type', 'application/json'],
      ['pragma', 'no-cache'],
    ]);
    expect(yield* Effect.promise(() => error.text())).toBe(
      String.raw`{"error":"invalid_grant","error_description":"Příliš \"starý\" token 😀"}`,
    );
    const redirect = oauthErrorPageRedirect('invalid_client');
    expect(redirect.status).toBe(302);
    expect(redirect.body).toBeNull();
    expect([...redirect.headers]).toEqual([
      ['cache-control', 'no-store'],
      ['location', '/cs/login?oauth_error=invalid_client'],
      ['pragma', 'no-cache'],
    ]);
    const preflight = oauthPreflightResponse();
    expect(preflight.status).toBe(204);
    expect(preflight.body).toBeNull();
    expect(preflight.headers.has('content-length')).toBe(false);
  }),
);

it.effect('OAuth header policy retains the original stream, repeated cookies and cancellation', () =>
  Effect.gen(function* oauthStreamIdentity() {
    const cancel = rs.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const headers = headersWithCookies({
      'access-control-allow-credentials': 'true',
      'content-type': 'application/octet-stream',
      'x-owner-header': 'retained',
    });
    const source = new Response(stream, { headers, status: 207, statusText: 'Provider Stream' });
    const response = withOAuthResponseHeaders('endpoint', source);
    expect(response).not.toBe(source);
    expect(response.body).toBe(stream);
    expect(response.status).toBe(207);
    expect(response.statusText).toBe('Provider Stream');
    expect(response.headers.getSetCookie()).toEqual(cookies);
    expect(response.headers.get('x-owner-header')).toBe('retained');
    expect(response.headers.has('content-length')).toBe(false);
    expect(response.headers.has('access-control-allow-credentials')).toBe(false);
    expect(source.headers.get('access-control-allow-credentials')).toBe('true');
    yield* Effect.promise(() => stream.cancel('browser cancelled'));
    expect(cancel).toHaveBeenCalledExactlyOnceWith('browser cancelled');
  }),
);

it.effect('OAuth forwarding retains metadata JSON bytes and all repeated provider cookies', () =>
  Effect.gen(function* oauthMetadataBytes() {
    const metadata = {
      extension: { label: 'Příliš 😀' },
      introspection_endpoint: 'https://must-not-advertise.test',
      issuer: config.issuer,
      revocation_endpoint_auth_methods_supported: ['client_secret_basic'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
    };
    const response = yield* forwardOAuthRequest({
      handler: () =>
        Effect.succeed(
          Response.json(metadata, {
            headers: headersWithCookies({ 'content-length': '999', etag: '"metadata-v1"' }),
            status: 203,
            statusText: 'Provider Discovery',
          }),
        ),
      issuer: config.issuer,
    })(new Request('https://shell.test/oauth/.well-known/openid-configuration'));
    expect(response.status).toBe(203);
    expect(response.statusText).toBe('Provider Discovery');
    expect(response.headers.getSetCookie()).toEqual(cookies);
    expect(response.headers.has('content-length')).toBe(false);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('etag')).toBe('"metadata-v1"');
    expect(yield* Effect.promise(() => response.text())).toBe(
      '{"issuer":"https://shell.test/shell-super-app-api/oauth","revocation_endpoint_auth_methods_supported":["none","private_key_jwt"],"token_endpoint_auth_methods_supported":["none","private_key_jwt"],"extension":{"label":"Příliš 😀"}}',
    );
  }),
);

it.effect('MCP protocol errors and discovery preserve full JSON bytes without inferred lengths', () =>
  Effect.gen(function* mcpStaticBytes() {
    const unauthorized = unauthorizedResponse(config.prmUrl, true);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('content-type')).toBe('application/json');
    expect(unauthorized.headers.has('content-length')).toBe(false);
    expect(yield* Effect.promise(() => unauthorized.text())).toBe(
      '{"error":"invalid_token","error_description":"Přístupový token neplatí. Připojte aplikaci znovu."}',
    );
    const response = yield* serveMcpMetadata(sdkDeps)(new Request(config.prmUrl));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.has('content-length')).toBe(false);
    expect(yield* Effect.promise(() => response.text())).toBe(
      '{"authorization_servers":["https://shell.test/shell-super-app-api/oauth"],"bearer_methods_supported":["header"],"resource":"https://shell.test/mcp","resource_documentation":"https://shell.test/cs/profil","resource_name":"OntOS","scopes_supported":["ontos"]}',
    );
  }),
);

it.effect('MCP SDK streaming keeps status, cookies, stream identity and both cancellation paths', () =>
  Effect.gen(function* mcpSdkStream() {
    const cancel = rs.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    sdkResponse = new Response(stream, {
      headers: headersWithCookies({ 'content-type': 'text/event-stream', 'mcp-protocol-version': '2026-07-28' }),
      status: 202,
      statusText: 'SDK Stream',
    });
    const abort = new AbortController();
    const response = yield* serveMcp(sdkDeps)(mcpRequest(abort.signal));
    expect(response).not.toBe(sdkResponse);
    expect(response.status).toBe(202);
    expect(response.statusText).toBe('SDK Stream');
    expect(response.body).toBe(stream);
    expect(response.headers.getSetCookie()).toEqual(cookies);
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('mcp-protocol-version')).toBe('2026-07-28');
    expect(response.headers.has('content-length')).toBe(false);
    expect(sdkResponse.headers.has('x-accel-buffering')).toBe(false);
    abort.abort();
    expect(sdkRequest?.signal.aborted).toBe(true);
    yield* Effect.promise(() => stream.cancel('SDK consumer cancelled'));
    expect(cancel).toHaveBeenCalledExactlyOnceWith('SDK consumer cancelled');
  }),
);

it.effect('MCP SDK opaque bytes keep a missing content type and a non-default error status', () =>
  Effect.gen(function* mcpSdkOpaqueBytes() {
    const bytes = Uint8Array.from([0, 255, 13, 10, 128, 42]);
    sdkResponse = new Response(bytes, {
      headers: headersWithCookies({ 'retry-after': '7', 'x-sdk-detail': 'retained' }),
      status: 503,
      statusText: 'SDK Retry',
    });
    const response = yield* serveMcp(sdkDeps)(mcpRequest());
    expect(response.status).toBe(503);
    expect(response.statusText).toBe('SDK Retry');
    expect(response.headers.getSetCookie()).toEqual(cookies);
    expect(response.headers.get('retry-after')).toBe('7');
    expect(response.headers.get('x-sdk-detail')).toBe('retained');
    expect(response.headers.has('content-type')).toBe(false);
    expect(response.headers.has('content-length')).toBe(false);
    expect(new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))).toEqual(bytes);
  }),
);
