// @rstest-environment node
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  Client,
  PROTOCOL_VERSION_META_KEY,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { describe, expect, it } from '@rstest/core';

import { createMcpFetch, createMcpMetadataFetch } from '../../../api/mcp/http.ts';
import type { McpEndpointConfig } from '../../../api/mcp/http.ts';
import { buildConnectionTools } from '../../../api/mcp/tools.ts';
import type { McpBackend, ModuleAnswer } from '../../../api/mcp/types.ts';
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
  callModule: async (appId, path, body, options): Promise<ModuleAnswer> => {
    calls.push({ appId, body, options, path });
    if (path === '/reads/records') {
      return { body: { canWrite: true, notes: [{ text: 'první' }], revision: 7 }, status: 200 };
    }
    return { body: { ok: true }, status: 200 };
  },
  listProposals: async () => ({
    batches: [],
    company: { legalEntityId: 'le', legalName: 'Obchodní firma' },
    pendingCount: 0,
    unavailableModules: [],
  }),
  submitProposals: async (request) => {
    proposals.push(request);
    return { batchId: 'batch-1', proposalIds: ['p-1'], replayed: false, reviewPath: '/cs/sprava/ke-schvaleni' };
  },
});

const endpoint = (options: {
  readonly backend: McpBackend;
  readonly description: ReturnType<typeof connectionDescription>;
  readonly token?: string;
}) =>
  createMcpFetch({
    authenticate: async (token) =>
      token === (options.token ?? 'good')
        ? {
            clientId: options.description.client.clientId,
            grantId: options.description.grantId,
            kind: 'ok',
            tools: () =>
              buildConnectionTools({
                backend: options.backend,
                catalog: fixtureCatalog(),
                description: options.description,
                prmUrl: CONFIG.prmUrl,
                publicOrigin: CONFIG.publicOrigin,
              }),
          }
        : token === 'down'
          ? { kind: 'unavailable' }
          : { kind: 'invalid' },
    config: async () => CONFIG,
  });

const connect = async (handler: (request: Request) => Promise<Response>, token = 'good') => {
  const client = new Client(CLIENT_INFO, { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(CONFIG.resource), {
      fetch: (input, init) => {
        const request = new Request(input, init);
        request.headers.set('authorization', `Bearer ${token}`);
        return handler(request);
      },
    }),
  );
  expect(client.getNegotiatedProtocolVersion()).toBe(PROTOCOL_VERSION);
  return client;
};

const textOf = (result: { readonly content?: unknown }): string =>
  Array.isArray(result.content) ? result.content.map((item: { text?: string }) => item.text ?? '').join('\n') : '';

describe('root routes', () => {
  it('map /mcp and its Protected Resource Metadata to the BFF routes', () => {
    expect(rootRouteTarget('/mcp')).toBe('/shell-super-app-api/mcp');
    expect(rootRouteTarget('/.well-known/oauth-protected-resource/mcp')).toBe(
      '/shell-super-app-api/mcp-resource-metadata',
    );
    expect(rootRouteTarget('/.well-known/oauth-protected-resource')).toBe('/shell-super-app-api/mcp-resource-metadata');
    expect(rootRouteTarget('/cs')).toBeUndefined();
  });
});

describe('Protected Resource Metadata and challenges', () => {
  it('names the Shell resource and its authorization server', async () => {
    const response = await createMcpMetadataFetch({ config: async () => CONFIG })(
      new Request('http://localhost:3020/.well-known/oauth-protected-resource/mcp'),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      authorization_servers: [CONFIG.issuer],
      resource: 'http://localhost:3020/mcp',
      scopes_supported: ['ontos'],
    });
  });

  it('answers a request without a token with 401 and resource_metadata', async () => {
    const handler = endpoint({ backend: fakeBackend([]), description: connectionDescription() });
    const response = await handler(toolsListRequest());
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="http://localhost:3020/.well-known/oauth-protected-resource/mcp", scope="ontos"',
    );
  });

  it('answers a revoked or foreign token with 401 invalid_token, and an unreachable store with 503', async () => {
    const handler = endpoint({ backend: fakeBackend([]), description: connectionDescription() });
    const post = (token: string) => handler(toolsListRequest(token));
    const revoked = await post('revoked');
    expect(revoked.status).toBe(401);
    expect(revoked.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect((await post('down')).status).toBe(503);
  });
});

describe('current stateless Streamable HTTP revision', () => {
  it('serves a self-contained tools/list request without an initialize handshake or session', async () => {
    const handler = endpoint({ backend: fakeBackend([]), description: connectionDescription() });
    const response = await handler(toolsListRequest('good'));
    expect(response.status).toBe(200);
    expect(response.headers.has('mcp-session-id')).toBe(false);
    expect(await response.json()).toMatchObject({
      id: 1,
      jsonrpc: '2.0',
      result: {
        tools: expect.arrayContaining([expect.objectContaining({ name: 'fixture_notes__read_records' })]),
      },
    });
  });

  it('rejects a 2025-11-25 initialize with 400 and names the supported revision', async () => {
    const handler = endpoint({ backend: fakeBackend([]), description: connectionDescription() });
    const response = await handler(
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
    expect(await response.json()).toMatchObject({
      error: { code: -32_022, data: { requested: '2025-11-25', supported: [PROTOCOL_VERSION] } },
      id: 1,
      jsonrpc: '2.0',
    });
  });
});

describe('a vertical present only in the test composition', () => {
  it('contributes typed tools that appear in tools/list and execute against its own BFF', async () => {
    const calls: Recorded[] = [];
    const client = await connect(endpoint({ backend: fakeBackend(calls), description: connectionDescription() }));
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'ontos_whoami',
        'ontos_read',
        'ontos_execute',
        'fixture_notes__read_records',
        'fixture_notes__add_note',
      ]),
    );
    const listed = (await client.listTools()).tools.find((tool) => tool.name === 'fixture_notes__add_note');
    expect(JSON.stringify(listed?.inputSchema)).toContain('NoteText');

    const read = await client.callTool({ arguments: {}, name: 'fixture_notes__read_records' });
    expect(read.isError).not.toBe(true);
    expect(textOf(read)).toContain('první');

    const write = await client.callTool({ arguments: { text: 'druhá' }, name: 'fixture_notes__add_note' });
    expect(write.isError).not.toBe(true);
    const command = calls.find((call) => call.path === `/${FIXTURE_APP_ID}/actions/apply-command`);
    expect(command?.appId).toBe(FIXTURE_APP_ID);
    expect(command?.body).toEqual({ command: { _tag: 'AddNote', text: 'druhá' }, expectedRevision: 7 });
    expect(command?.options.idempotencyKey).toBeTypeOf('string');
    await client.close();
  });

  it('refuses invalid arguments with a Czech tool error before calling the module', async () => {
    const calls: Recorded[] = [];
    const client = await connect(endpoint({ backend: fakeBackend(calls), description: connectionDescription() }));
    const result = await client.callTool({ arguments: { text: '' }, name: 'fixture_notes__add_note' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('příliš krátké');
    expect(calls.some((call) => call.path.includes('/actions/'))).toBe(false);
    await client.close();
  });
});

describe('effective rights: grant, live rights and write policy', () => {
  it('a read-only connection gets no write tools', async () => {
    const client = await connect(
      endpoint({ backend: fakeBackend([]), description: connectionDescription({ writePolicy: 'read_only' }) }),
    );
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('fixture_notes__read_records');
    expect(names).not.toContain('fixture_notes__add_note');
    expect(names).not.toContain('ontos_execute');
    await client.close();
  });

  it('a module outside the grant contributes nothing', async () => {
    const client = await connect(
      endpoint({ backend: fakeBackend([]), description: connectionDescription({ modules: [] }) }),
    );
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names.some((name) => name.startsWith('fixture_notes__'))).toBe(false);
    await client.close();
  });

  it('an agent acting directly does not get proposal-only commands', async () => {
    const client = await connect(
      endpoint({
        backend: fakeBackend([]),
        description: connectionDescription({
          acting: { displayName: 'Agent B', kind: 'agent', principalId: 'agent-1' },
        }),
      }),
    );
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('fixture_notes__add_note');
    expect(names).not.toContain('fixture_notes__wipe_notes');
    await client.close();
  });

  it('approval mode writes go to the platform approval queue and change nothing', async () => {
    const calls: Recorded[] = [];
    const proposals: unknown[] = [];
    const client = await connect(
      endpoint({
        backend: fakeBackend(calls, proposals),
        description: connectionDescription({ writePolicy: 'approval' }),
      }),
    );
    const result = await client.callTool({
      arguments: { id: `${FIXTURE_MODULE_ID}/command/AddNote`, input: { text: 'návrh' }, reason: 'test' },
      name: 'ontos_execute',
    });
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
    await client.close();
  });
});
