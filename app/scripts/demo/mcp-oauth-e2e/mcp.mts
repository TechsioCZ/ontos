import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

export const MODERN_PROTOCOL_VERSION = '2026-07-28';
export const LEGACY_PROTOCOL_VERSION = '2025-11-25';

/** The server speaks the current MCP revision only, so every client pins it. */
export async function connectMcp(serverUrl: string, accessToken: string) {
  const client = new Client(
    { name: 'ontos-oauth-e2e', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(serverUrl), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    }),
  );
  const protocolVersion = client.getNegotiatedProtocolVersion();
  return { client, protocolVersion };
}

export interface ToolOutcome {
  readonly isError: boolean;
  readonly text: string;
  readonly value: unknown;
}

export async function callJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
  const result = await client.callTool({ name, arguments: args });
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
  const isError = result.isError === true;
  let value: unknown = text;
  if (result.structuredContent !== undefined) {
    value = result.structuredContent;
  } else {
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      value = text;
    }
  }
  return { isError, text, value };
}

/** Plain fetch (no SDK, no caching) so 401 challenges and WWW-Authenticate headers can be checked. */
export async function rawMcpStatus(
  serverUrl: string,
  accessToken: string | undefined,
): Promise<{ status: number; wwwAuthenticate: string | null }> {
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  };
  if (accessToken !== undefined) {
    headers.authorization = `Bearer ${accessToken}`;
  }
  const response = await fetch(serverUrl, {
    method: 'POST',
    headers,
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
  });
  await response.body?.cancel();
  return { status: response.status, wwwAuthenticate: response.headers.get('www-authenticate') };
}

/** A 2025-era `initialize`; a current-only server answers with an error naming the revision it supports. */
export async function rawLegacyInitialize(
  serverUrl: string,
  accessToken: string,
): Promise<{ status: number; body: string }> {
  const response = await fetch(serverUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'ontos-oauth-e2e-legacy', version: '1.0.0' },
      },
    }),
  });
  return { status: response.status, body: await response.text() };
}
