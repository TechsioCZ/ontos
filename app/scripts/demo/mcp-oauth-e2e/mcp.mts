import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

export type Era = 'legacy' | 'modern';

export const MODERN_PROTOCOL_VERSION = '2026-07-28';

export async function connectMcp(serverUrl: string, accessToken: string, era: Era) {
  const client = new Client(
    { name: 'ontos-oauth-e2e', version: '1.0.0' },
    { versionNegotiation: { mode: era === 'legacy' ? 'legacy' : { pin: MODERN_PROTOCOL_VERSION } } },
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
