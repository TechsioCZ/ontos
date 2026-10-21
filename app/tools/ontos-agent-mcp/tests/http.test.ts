import { afterAll, beforeAll, describe, expect, it } from '@rstest/core';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createOntosMcpFetch, startHttpServer } from '../src/http.ts';
import type { OntosMcpDeps, RunningHttpServer } from '../src/http.ts';
import type { ToolSpec } from '../src/mcp/types.ts';
import type { ConnectionDescription, RsConfig, VerifiedAccessToken } from '../src/oauth/types.ts';
import { ConnectionInactiveError, ConnectorUnavailableError, InvalidTokenError } from '../src/oauth/types.ts';

const CONFIG: RsConfig = {
  allowedHosts: [],
  allowedOrigins: ['https://claude.ai'],
  connectGuideUrl: 'http://localhost:3020/cs/profil',
  connectorSecret: 'secret-1',
  host: '127.0.0.1',
  issuer: 'http://localhost:3020/shell-super-app-api/oauth',
  jwksUrl: 'http://localhost:3020/shell-super-app-api/oauth/jwks',
  port: 0,
  prmUrl: 'http://localhost:3090/.well-known/oauth-protected-resource/mcp',
  resourceUrl: 'http://localhost:3090/mcp',
  shellInternalUrl: 'http://shell.test',
  shellPublicUrl: 'http://localhost:3020',
};

const DESCRIPTION: ConnectionDescription = {
  acting: { displayName: 'Jana Testerová', kind: 'human', principalId: 'principal-1' },
  client: { clientId: 'client-1', host: 'claude.ai', kind: 'cimd', name: 'Claude' },
  compositionRevision: 'a'.repeat(64),
  delegatedBy: null,
  grantId: 'grant-1',
  legalEntityId: '71000000-0000-4000-8000-000000000020',
  legalName: 'Obchodní firma',
  modules: [{ label: 'Siampark', moduleId: 'work.tasks', read: true, write: true }],
  profileId: 'profile-1',
  status: 'active',
  tenantId: 'tenant-1',
  writePolicy: 'approval',
};

const WHOAMI: ToolSpec = {
  annotations: { readOnlyHint: true },
  description: 'test',
  handler: async () => ({
    content: [{ text: '{"profile_id":"profile-1"}', type: 'text' }],
    structuredContent: { profile_id: 'profile-1' },
  }),
  inputSchema: { properties: {}, type: 'object' },
  name: 'ontos_whoami',
  title: 'Kdo jsem',
};

const deps = (overrides: Partial<OntosMcpDeps> = {}): OntosMcpDeps => ({
  buildTools: async () => [WHOAMI],
  config: CONFIG,
  describeConnection: async () => DESCRIPTION,
  verifyAccessToken: async (token: string): Promise<VerifiedAccessToken> => {
    if (token !== 'good') {
      throw new InvalidTokenError('bad token');
    }
    return {
      clientId: 'client-1',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      grantId: 'grant-1',
      scopes: ['ontos'],
      subject: 'user-1',
      token,
    };
  },
  ...overrides,
});

const send = (handler: (request: Request) => Promise<Response>, path: string, init?: RequestInit): Promise<Response> =>
  handler(new Request(`http://localhost:3090${path}`, init));

const json = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

describe('createOntosMcpFetch: discovery and public routes', () => {
  const handler = createOntosMcpFetch(deps());

  it('answers /healthz', async () => {
    const response = await send(handler, '/healthz');
    expect(response.status).toBe(200);
    expect((await json(response))['ok']).toBe(true);
  });

  it('serves the protected resource metadata at both well-known paths with CORS', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const response = await send(handler, path);
      expect(response.status).toBe(200);
      const body = await json(response);
      expect(body['authorization_servers']).toEqual([CONFIG.issuer]);
      expect(body['scopes_supported']).toEqual(['ontos']);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
    }
  });

  it('answers the CORS preflight', async () => {
    const response = await send(handler, '/mcp', { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, POST, DELETE, OPTIONS');
  });

  it('serves the Czech landing page to browser GETs', async () => {
    const response = await send(handler, '/mcp', { headers: { accept: 'text/html' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toContain('Toto je adresa MCP serveru OntOS');
  });

  it('answers 404 for unknown paths', async () => {
    const response = await send(handler, '/unknown');
    expect(response.status).toBe(404);
  });
});

describe('createOntosMcpFetch: authentication', () => {
  const PRM_CHALLENGE = 'Bearer resource_metadata="http://localhost:3090/.well-known/oauth-protected-resource/mcp", scope="ontos"';

  it('challenges a request without a token', async () => {
    const response = await send(createOntosMcpFetch(deps()), '/mcp', { method: 'POST' });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(PRM_CHALLENGE);
  });

  it('rejects an invalid bearer token', async () => {
    const response = await send(createOntosMcpFetch(deps()), '/mcp', { headers: { authorization: 'Bearer bad' }, method: 'POST' });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toMatch(/, error="invalid_token"$/u);
  });

  it('never accepts a Better Auth API key as a bearer token', async () => {
    const response = await send(createOntosMcpFetch(deps()), '/mcp', {
      headers: { authorization: 'Bearer ontos_k7Hq2sXbY1zzAPIKEY' },
      method: 'POST',
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toMatch(/error="invalid_token"$/u);
  });

  it('answers 401 when the grant is inactive', async () => {
    const handler = createOntosMcpFetch(
      deps({ describeConnection: async () => { throw new ConnectionInactiveError('revoked'); } }),
    );
    const response = await send(handler, '/mcp', { headers: { authorization: 'Bearer good' }, method: 'POST' });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toMatch(/error="invalid_token"$/u);
  });

  it('answers 503 when the shell is down', async () => {
    const handler = createOntosMcpFetch(
      deps({ describeConnection: async () => { throw new ConnectorUnavailableError('down'); } }),
    );
    const response = await send(handler, '/mcp', { headers: { authorization: 'Bearer good' }, method: 'POST' });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
  });

  it('rejects a foreign Origin', async () => {
    const response = await send(createOntosMcpFetch(deps()), '/mcp', {
      headers: { origin: 'https://evil.example' },
      method: 'POST',
    });
    expect(response.status).toBe(403);
  });
});

describe('streamable HTTP end to end (both protocol eras)', () => {
  let server: RunningHttpServer;

  beforeAll(async () => {
    server = await startHttpServer(deps());
  });

  afterAll(async () => {
    await server.close();
  });

  for (const era of ['legacy', 'modern'] as const) {
    it(`lists and calls the connection tool over the ${era} era`, async () => {
      const client = new Client(
        { name: 'test', version: '1.0.0' },
        { versionNegotiation: { mode: era === 'legacy' ? 'legacy' : { pin: '2026-07-28' } } },
      );
      const transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { authorization: 'Bearer good' } },
      });
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(['ontos_whoami']);
      const result = await client.callTool({ arguments: {}, name: 'ontos_whoami' });
      expect(result.structuredContent).toEqual({ profile_id: 'profile-1' });
      await client.close();
    });
  }
});
