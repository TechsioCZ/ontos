import { afterAll, beforeAll, describe, expect, it } from '@rstest/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type RunningHttpServer, startHttpServer } from '../src/http.ts';
import type { PrincipalSession } from '../src/session.ts';

const sessions: PrincipalSession[] = [];
const clients: Client[] = [];
let running: RunningHttpServer | undefined;

const baseUrl = (): string => {
  if (running === undefined) {
    throw new Error('server not started');
  }
  return running.url;
};

const connectClient = async (url: URL, headers?: Record<string, string>): Promise<Client> => {
  const client = new Client({ name: 'test-client', version: '1' });
  const transport = new StreamableHTTPClientTransport(url, headers === undefined ? {} : { requestInit: { headers } });
  await client.connect(transport);
  clients.push(client);
  return client;
};

beforeAll(async () => {
  running = await startHttpServer({
    host: '127.0.0.1',
    port: 0,
    allowedHosts: [],
    allowUrlToken: true,
    approvalTokens: new Set(['c-token']),
    verifyToken: async (token) => token === 'good-token' || token === 'c-token',
    createServer: async (session) => {
      sessions.push(session);
      const server = new McpServer({ name: 'test', version: '1' });
      server.registerTool('ping', { description: 'ping', inputSchema: {} }, async () => ({
        content: [{ type: 'text', text: 'pong' }],
      }));
      return server;
    },
  });
});

afterAll(async () => {
  for (const client of clients) {
    await client.close().catch(() => undefined);
  }
  await running?.close();
});

describe('ontos-mcp HTTP endpoint', () => {
  it('answers the health check', async () => {
    const response = await fetch(baseUrl().replace('/mcp', '/healthz'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, name: 'ontos-mcp' });
  });

  it('rejects MCP requests without a token', async () => {
    const response = await fetch(baseUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('connects with a bearer token, lists and calls tools', async () => {
    const client = await connectClient(new URL(baseUrl()), { authorization: 'Bearer good-token' });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('ping');
    const result = await client.callTool({ name: 'ping', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: 'pong' }]);

    const session = sessions.find((candidate) => candidate.apiKey === 'good-token');
    expect(session?.transport).toBe('http');
    expect(session?.writePolicyOverride).toBeUndefined();
  });

  it('rejects an unknown bearer token during initialize', async () => {
    await expect(connectClient(new URL(baseUrl()), { authorization: 'Bearer bad' })).rejects.toThrow();
  });

  it('accepts a token in the URL path and applies approval policy for C keys', async () => {
    const url = new URL(baseUrl().replace('/mcp', '/mcp/k/c-token'));
    const client = await connectClient(url);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('ping');

    const session = sessions.find((candidate) => candidate.apiKey === 'c-token');
    expect(session?.writePolicyOverride).toBe('approval');
  });
});
