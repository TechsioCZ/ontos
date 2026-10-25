// @rstest-environment node
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  Client,
  PROTOCOL_VERSION_META_KEY,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { Crypto, Effect, FiberSet } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ShellCryptoLive } from '../../../api/auth/gateway-issuer.ts';
import { serveMcp, serveMcpMetadata } from '../../../api/mcp/http.ts';
import type { McpEndpointConfig } from '../../../api/mcp/http.ts';
import { buildConnectionTools } from '../../../api/mcp/tools.ts';
import type { McpBackend, ModuleAnswer, ToolSpec } from '../../../api/mcp/types.ts';
import { rootRouteTarget } from '../../../shared/mcp-resource.ts';
import { FIXTURE_APP_ID, FIXTURE_MODULE_ID, connectionDescription, fixtureCatalog } from './fixture-vertical.ts';

const PROTOCOL_VERSION = '2026-07-28';
const CLIENT_INFO = { name: 'ontos-test', version: '1.0.0' };

const CONFIG: McpEndpointConfig = {
  issuer: 'http://localhost:3020/shell-super-app-api/oauth',
  prmUrl: 'http://localhost:3020/.well-known/oauth-protected-resource/mcp',
  publicOrigin: 'http://localhost:3020',
  resource: 'http://localhost:3020/mcp',
};

const toolsListRequest = (token?: string) => {
  const headers = new Headers({
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-method': 'tools/list',
    'mcp-protocol-version': PROTOCOL_VERSION,
  });
  if (token !== undefined) {
    headers.set('authorization', `Bearer ${token}`);
  }
  return new Request(CONFIG.resource, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {
        _meta: {
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: CLIENT_INFO,
          [PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION,
        },
      },
    }),
    headers,
    method: 'POST',
  });
};

interface Recorded {
  readonly appId: string;
  readonly body: unknown;
  readonly options: { readonly idempotencyKey?: string };
  readonly path: string;
}

const fakeBackend = (calls: Recorded[], proposals: unknown[] = []): McpBackend => ({
  callModule: (appId, path, body, options) =>
    Effect.sync((): ModuleAnswer => {
      calls.push({ appId, body, options, path });
      if (path === '/reads/records') {
        return { body: { canWrite: true, notes: [{ text: 'první' }], revision: 7 }, status: 200 };
      }
      return { body: { ok: true }, status: 200 };
    }),
  listProposals: Effect.succeed({
    batches: [],
    company: { legalEntityId: 'le', legalName: 'Obchodní firma' },
    pendingCount: 0,
    unavailableModules: [],
  }),
  submitProposals: (request) =>
    Effect.sync(() => {
      proposals.push(request);
      return { batchId: 'batch-1', proposalIds: ['p-1'], replayed: false, reviewPath: '/cs/sprava/ke-schvaleni' };
    }),
});

const shellCrypto = Effect.service(Crypto.Crypto).pipe(Effect.provide(ShellCryptoLive));

const endpoint = Effect.fn('mcpEndpointTest.endpoint')(function* endpoint(options: {
  readonly backend: McpBackend;
  readonly description: ReturnType<typeof connectionDescription>;
  readonly token?: string;
}) {
  const crypto = yield* shellCrypto;
  return serveMcp({
    authenticate: (token) => {
      if (token === (options.token ?? 'good')) {
        return Effect.succeed({
          clientId: options.description.client.clientId,
          grantId: options.description.grantId,
          kind: 'ok' as const,
          tools: () =>
            buildConnectionTools({
              backend: options.backend,
              catalog: fixtureCatalog(),
              crypto,
              description: options.description,
              prmUrl: CONFIG.prmUrl,
              publicOrigin: CONFIG.publicOrigin,
            }),
        });
      }
      if (token === 'down') {
        return Effect.succeed({ kind: 'unavailable' as const });
      }
      return Effect.succeed({ kind: 'invalid' as const });
    },
    config: Effect.succeed(CONFIG),
  });
});

const connect = Effect.fn('mcpEndpointTest.connect')(function* connect(
  handler: (request: Request) => Effect.Effect<Response>,
  token = 'good',
) {
  // The SDK fetch callback is the only Effect-to-Promise boundary; its fibers belong to this test's scope.
  const run = yield* FiberSet.makeRuntimePromise();
  const client = yield* Effect.acquireRelease(
    Effect.sync(() => new Client(CLIENT_INFO, { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } })),
    (ownedClient) => Effect.promise(() => ownedClient.close()),
  );
  yield* Effect.promise(() =>
    client.connect(
      new StreamableHTTPClientTransport(new URL(CONFIG.resource), {
        fetch: (input, init) => {
          const request = new Request(input, init);
          request.headers.set('authorization', `Bearer ${token}`);
          return run(handler(request), { signal: request.signal });
        },
      }),
    ),
  );
  expect(client.getNegotiatedProtocolVersion()).toBe(PROTOCOL_VERSION);
  return client;
});

const textOf = (result: { readonly content?: unknown }): string =>
  Array.isArray(result.content) ? result.content.map((item: { text?: string }) => item.text ?? '').join('\n') : '';

describe('root routes', () => {
  it.effect('map /mcp and its Protected Resource Metadata to the BFF routes', () =>
    Effect.sync(() => {
      expect(rootRouteTarget('/mcp')).toBe('/shell-super-app-api/mcp');
      expect(rootRouteTarget('/.well-known/oauth-protected-resource/mcp')).toBe(
        '/shell-super-app-api/mcp-resource-metadata',
      );
      expect(rootRouteTarget('/.well-known/oauth-protected-resource')).toBe(
        '/shell-super-app-api/mcp-resource-metadata',
      );
      expect(rootRouteTarget('/cs')).toBeUndefined();
    }),
  );
});

describe('Protected Resource Metadata and challenges', () => {
  it.effect('names the Shell resource and its authorization server', () =>
    Effect.gen(function* protectedResourceMetadata() {
      const response = yield* serveMcpMetadata({ config: Effect.succeed(CONFIG) })(
        new Request('http://localhost:3020/.well-known/oauth-protected-resource/mcp'),
      );
      expect(response.status).toBe(200);
      const metadata = yield* Effect.promise(() => response.json());
      expect(metadata).toMatchObject({
        authorization_servers: [CONFIG.issuer],
        resource: 'http://localhost:3020/mcp',
        scopes_supported: ['ontos'],
      });
    }),
  );

  it.effect('answers a request without a token with 401 and resource_metadata', () =>
    Effect.gen(function* missingTokenChallenge() {
      const handler = yield* endpoint({ backend: fakeBackend([]), description: connectionDescription() });
      const response = yield* handler(toolsListRequest());
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe(
        'Bearer resource_metadata="http://localhost:3020/.well-known/oauth-protected-resource/mcp", scope="ontos"',
      );
    }),
  );

  it.effect('answers a revoked or foreign token with 401 invalid_token, and an unreachable store with 503', () =>
    Effect.gen(function* invalidTokenChallenge() {
      const handler = yield* endpoint({ backend: fakeBackend([]), description: connectionDescription() });
      const post = (token: string) => handler(toolsListRequest(token));
      const revoked = yield* post('revoked');
      expect(revoked.status).toBe(401);
      expect(revoked.headers.get('www-authenticate')).toContain('error="invalid_token"');
      const unavailable = yield* post('down');
      expect(unavailable.status).toBe(503);
    }),
  );
});

describe('current stateless Streamable HTTP revision', () => {
  it.effect('rechecks authentication after the lazy SDK has been loaded', () =>
    Effect.gen(function* rechecksMcpAuthentication() {
      const crypto = yield* shellCrypto;
      let active = true;
      let authenticationCalls = 0;
      const tools = () =>
        buildConnectionTools({
          backend: fakeBackend([]),
          catalog: fixtureCatalog(),
          crypto,
          description: connectionDescription(),
          prmUrl: CONFIG.prmUrl,
          publicOrigin: CONFIG.publicOrigin,
        });
      const serve = serveMcp({
        authenticate: () =>
          Effect.sync(() => {
            authenticationCalls += 1;
            return active
              ? {
                  clientId: 'client',
                  grantId: 'grant',
                  kind: 'ok' as const,
                  tools,
                }
              : { kind: 'invalid' as const };
          }),
        config: Effect.succeed(CONFIG),
      });
      const accepted = yield* serve(toolsListRequest('good'));
      expect(accepted.status).toBe(200);
      active = false;
      const revoked = yield* serve(toolsListRequest('good'));
      expect(revoked.status).toBe(401);
      expect(revoked.headers.get('www-authenticate')).toContain('error="invalid_token"');
      expect(authenticationCalls).toBe(2);
    }),
  );

  it.effect('serves a self-contained tools/list request without an initialize handshake or session', () =>
    Effect.gen(function* statelessToolsList() {
      const handler = yield* endpoint({ backend: fakeBackend([]), description: connectionDescription() });
      const response = yield* handler(toolsListRequest('good'));
      expect(response.status).toBe(200);
      expect(response.headers.has('mcp-session-id')).toBe(false);
      const result = yield* Effect.promise(() => response.json());
      expect(result).toMatchObject({
        id: 1,
        jsonrpc: '2.0',
        result: {
          tools: expect.arrayContaining([expect.objectContaining({ name: 'fixture_notes__read_records' })]),
        },
      });
    }),
  );

  it.effect('rejects a 2025-11-25 initialize with 400 and names the supported revision', () =>
    Effect.gen(function* unsupportedProtocolRevision() {
      const handler = yield* endpoint({ backend: fakeBackend([]), description: connectionDescription() });
      const response = yield* handler(
        new Request(CONFIG.resource, {
          body: JSON.stringify({
            id: 1,
            jsonrpc: '2.0',
            method: 'initialize',
            params: { capabilities: {}, clientInfo: CLIENT_INFO, protocolVersion: '2025-11-25' },
          }),
          headers: {
            accept: 'application/json, text/event-stream',
            authorization: 'Bearer good',
            'content-type': 'application/json',
          },
          method: 'POST',
        }),
      );
      expect(response.status).toBe(400);
      const result = yield* Effect.promise(() => response.json());
      expect(result).toMatchObject({
        error: { code: -32_022, data: { requested: '2025-11-25', supported: [PROTOCOL_VERSION] } },
        id: 1,
        jsonrpc: '2.0',
      });
    }),
  );
});

describe('a vertical present only in the test composition', () => {
  it.effect('contributes typed tools that appear in tools/list and execute against its own BFF', () =>
    Effect.gen(function* typedVerticalTools() {
      const calls: Recorded[] = [];
      const handler = yield* endpoint({ backend: fakeBackend(calls), description: connectionDescription() });
      const client = yield* connect(handler);
      const { tools: namedTools } = yield* Effect.promise(() => client.listTools());
      const names = namedTools.map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'ontos_whoami',
          'ontos_read',
          'ontos_execute',
          'fixture_notes__read_records',
          'fixture_notes__add_note',
        ]),
      );
      const { tools: listedTools } = yield* Effect.promise(() => client.listTools());
      const listed = listedTools.find((tool) => tool.name === 'fixture_notes__add_note');
      expect(JSON.stringify(listed?.inputSchema)).toContain('NoteText');

      const read = yield* Effect.promise(() => client.callTool({ arguments: {}, name: 'fixture_notes__read_records' }));
      expect(read.isError).not.toBe(true);
      expect(textOf(read)).toContain('první');

      const write = yield* Effect.promise(() =>
        client.callTool({
          arguments: { idempotencyKey: 'typed-add-note', text: 'druhá' },
          name: 'fixture_notes__add_note',
        }),
      );
      expect(write.isError).not.toBe(true);
      const command = calls.find((call) => call.path === `/${FIXTURE_APP_ID}/actions/apply-command`);
      expect(command?.appId).toBe(FIXTURE_APP_ID);
      expect(command?.body).toEqual({ command: { _tag: 'AddNote', text: 'druhá' }, expectedRevision: 7 });
      expect(command?.options.idempotencyKey).toBe('typed-add-note');
    }),
  );

  it.effect('refuses invalid arguments with a Czech tool error before calling the module', () =>
    Effect.gen(function* invalidToolArguments() {
      const calls: Recorded[] = [];
      const handler = yield* endpoint({ backend: fakeBackend(calls), description: connectionDescription() });
      const client = yield* connect(handler);
      const result = yield* Effect.promise(() =>
        client.callTool({
          arguments: { idempotencyKey: 'invalid-note', text: '' },
          name: 'fixture_notes__add_note',
        }),
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('příliš krátké');
      expect(calls.some((call) => call.path.includes('/actions/'))).toBe(false);
    }),
  );
});

describe('direct write preflight', () => {
  const toolHandler = Effect.fn('mcpEndpointTest.toolHandler')(function* toolHandler(
    backend: McpBackend,
    name = 'ontos_execute',
  ) {
    const crypto = yield* shellCrypto;
    const tool = buildConnectionTools({
      backend,
      catalog: fixtureCatalog(),
      crypto,
      description: connectionDescription(),
      prmUrl: CONFIG.prmUrl,
      publicOrigin: CONFIG.publicOrigin,
    }).find((entry) => entry.name === name);
    return (args: Parameters<ToolSpec['handler']>[0]) =>
      tool === undefined ? Effect.die(new Error(`Missing fixture tool ${name}`)) : tool.handler(args);
  });

  it.effect('uses one governed snapshot for live rights and the initial revision', () =>
    Effect.gen(function* singlePreflightSnapshot() {
      const calls: Recorded[] = [];
      const base = fakeBackend(calls);
      let reads = 0;
      const backend: McpBackend = {
        ...base,
        callModule: (appId, path, body, options) =>
          Effect.suspend(() => {
            if (path === '/reads/records') {
              reads += 1;
              if (reads > 1) {
                return Effect.succeed({ body: { code: 'read_handler_unavailable' }, status: 503 });
              }
            }
            return base.callModule(appId, path, body, options);
          }),
      };
      const run = yield* toolHandler(backend);
      const result = yield* run({
        id: `${FIXTURE_MODULE_ID}/command/AddNote`,
        idempotencyKey: 'single-preflight',
        input: { text: 'jedna revize' },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ status: 'executed' });
      expect(reads).toBe(1);
      expect(calls.find((call) => call.path.includes('/actions/'))?.body).toEqual({
        command: { _tag: 'AddNote', text: 'jedna revize' },
        expectedRevision: 7,
      });
    }),
  );

  it.effect('does not execute with an unavailable live-rights read, even with a supplied revision', () =>
    Effect.gen(function* unavailablePreflight() {
      const calls: Recorded[] = [];
      const base = fakeBackend(calls);
      let reads = 0;
      const backend: McpBackend = {
        ...base,
        callModule: (appId, path, body, options) =>
          path === '/reads/records'
            ? Effect.sync(() => {
                reads += 1;
                return { body: { code: 'read_handler_unavailable' }, status: 503 };
              })
            : base.callModule(appId, path, body, options),
      };
      const run = yield* toolHandler(backend, 'fixture_notes__add_note');
      const result = yield* run({
        expectedRevision: 7,
        idempotencyKey: 'unavailable-preflight',
        text: 'neprovést',
      });
      expect(result.isError).toBe(true);
      expect(result._meta).toMatchObject({ 'ontos/code': 'read_handler_unavailable', 'ontos/status': 503 });
      expect(reads).toBe(1);
      expect(calls.some((call) => call.path.includes('/actions/'))).toBe(false);
    }),
  );

  it.effect('returns a revision conflict without retrying; only an explicit new caller intent can write again', () =>
    Effect.gen(function* revisionConflictSnapshot() {
      const calls: Recorded[] = [];
      let reads = 0;
      let writes = 0;
      const backend: McpBackend = {
        ...fakeBackend([]),
        callModule: (appId, path, body, options) =>
          Effect.sync(() => {
            calls.push({ appId, body, options, path });
            if (path === '/reads/records') {
              reads += 1;
              return { body: { canWrite: true, revision: reads === 1 ? 7 : 8 }, status: 200 };
            }
            writes += 1;
            return writes === 1
              ? { body: { code: 'fixture_revision_conflict' }, status: 409 }
              : { body: { ok: true }, status: 200 };
          }),
      };
      const run = yield* toolHandler(backend, 'fixture_notes__add_note');
      const conflict = yield* run({
        idempotencyKey: 'preflight-conflict',
        text: 'souběh',
      });
      expect(conflict.isError).toBe(true);
      expect(conflict._meta).toMatchObject({ 'ontos/code': 'fixture_revision_conflict', 'ontos/status': 409 });
      expect(reads).toBe(1);
      expect(writes).toBe(1);
      expect(calls.filter((call) => call.path.includes('/actions/'))).toEqual([
        expect.objectContaining({
          body: { command: { _tag: 'AddNote', text: 'souběh' }, expectedRevision: 7 },
          options: expect.objectContaining({ idempotencyKey: 'preflight-conflict' }),
        }),
      ]);

      // The caller observes the changed record, then deliberately supplies both a revision and a new intent key.
      const read = yield* toolHandler(backend, 'fixture_notes__read_records');
      const observed = yield* read({});
      expect(observed.isError).not.toBe(true);
      expect(observed.structuredContent).toMatchObject({ data: { revision: 8 } });
      expect(reads).toBe(2);
      expect(writes).toBe(1);
      const accepted = yield* run({
        expectedRevision: 8,
        idempotencyKey: 'caller-new-intent-after-observation',
        text: 'souběh',
      });
      expect(accepted.isError).not.toBe(true);
      expect(accepted.structuredContent).toMatchObject({ replayed: false, status: 'executed' });
      // A supplied revision does not skip the new invocation's live-rights preflight.
      expect(reads).toBe(3);
      expect(writes).toBe(2);
      const commands = calls.filter((call) => call.path.includes('/actions/'));
      expect(commands.map((call) => call.body)).toEqual([
        { command: { _tag: 'AddNote', text: 'souběh' }, expectedRevision: 7 },
        { command: { _tag: 'AddNote', text: 'souběh' }, expectedRevision: 8 },
      ]);
      expect(commands.map((call) => call.options.idempotencyKey)).toEqual([
        'preflight-conflict',
        'caller-new-intent-after-observation',
      ]);
    }),
  );

  it.effect('does not reuse a previous request’s live authorization snapshot', () =>
    Effect.gen(function* requestScopedSnapshot() {
      const calls: Recorded[] = [];
      const base = fakeBackend(calls);
      let canWrite = true;
      let reads = 0;
      const backend: McpBackend = {
        ...base,
        callModule: (appId, path, body, options) =>
          path === '/reads/records'
            ? Effect.sync(() => {
                reads += 1;
                return { body: { canWrite, revision: 7 }, status: 200 };
              })
            : base.callModule(appId, path, body, options),
      };
      const run = yield* toolHandler(backend);
      const args = {
        id: `${FIXTURE_MODULE_ID}/command/AddNote`,
        idempotencyKey: 'live-right-recheck',
        input: { text: 'nová práva' },
      };
      const first = yield* run(args);
      expect(first.isError).not.toBe(true);
      canWrite = false;
      const second = yield* run(args);
      expect(second.isError).toBe(true);
      expect(reads).toBe(2);
      expect(calls.filter((call) => call.path.includes('/actions/'))).toHaveLength(1);
    }),
  );
});

describe('effective rights: grant, live rights and write policy', () => {
  it.effect('a read-only connection gets no write tools', () =>
    Effect.gen(function* readOnlyTools() {
      const handler = yield* endpoint({
        backend: fakeBackend([]),
        description: connectionDescription({ writePolicy: 'read_only' }),
      });
      const client = yield* connect(handler);
      const { tools } = yield* Effect.promise(() => client.listTools());
      const names = tools.map((tool) => tool.name);
      expect(names).toContain('fixture_notes__read_records');
      expect(names).not.toContain('fixture_notes__add_note');
      expect(names).not.toContain('ontos_execute');
    }),
  );

  it.effect('a module outside the grant contributes nothing', () =>
    Effect.gen(function* excludedModuleTools() {
      const handler = yield* endpoint({
        backend: fakeBackend([]),
        description: connectionDescription({ modules: [] }),
      });
      const client = yield* connect(handler);
      const { tools } = yield* Effect.promise(() => client.listTools());
      const names = tools.map((tool) => tool.name);
      expect(names.some((name) => name.startsWith('fixture_notes__'))).toBe(false);
    }),
  );

  it.effect('an agent acting directly does not get proposal-only commands', () =>
    Effect.gen(function* directAgentTools() {
      const handler = yield* endpoint({
        backend: fakeBackend([]),
        description: connectionDescription({
          acting: { displayName: 'Agent B', kind: 'agent', principalId: 'agent-1' },
        }),
      });
      const client = yield* connect(handler);
      const { tools } = yield* Effect.promise(() => client.listTools());
      const names = tools.map((tool) => tool.name);
      expect(names).toContain('fixture_notes__add_note');
      expect(names).not.toContain('fixture_notes__wipe_notes');
    }),
  );

  it.effect('approval mode writes go to the platform approval queue and change nothing', () =>
    Effect.gen(function* approvalQueueWrite() {
      const calls: Recorded[] = [];
      const proposals: unknown[] = [];
      const handler = yield* endpoint({
        backend: fakeBackend(calls, proposals),
        description: connectionDescription({ writePolicy: 'approval' }),
      });
      const client = yield* connect(handler);
      const result = yield* Effect.promise(() =>
        client.callTool({
          arguments: {
            id: `${FIXTURE_MODULE_ID}/command/AddNote`,
            idempotencyKey: 'approval-mode-note',
            input: { text: 'návrh' },
            reason: 'test',
          },
          name: 'ontos_execute',
        }),
      );
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ status: 'proposed' });
      expect(proposals).toEqual([
        expect.objectContaining({
          proposals: [
            expect.objectContaining({
              actionSlug: 'apply-command',
              appId: FIXTURE_APP_ID,
              command: { _tag: 'AddNote', text: 'návrh' },
            }),
          ],
        }),
      ]);
      expect(calls.some((call) => call.path.includes('/actions/'))).toBe(false);
    }),
  );
});
