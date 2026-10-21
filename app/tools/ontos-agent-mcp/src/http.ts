import { createHash, randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { getGatewayContext } from './gateway.ts';
import type { PrincipalSession } from './session.ts';
import { runWithPrincipal } from './session.ts';

/** Audience of the shell gateway used to check that a token is still accepted. */
export const VERIFY_AUDIENCE = 'workforce';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;
const BEARER_HEADER = 'Bearer realm="ontos-mcp"';

export interface HttpServerOptions {
  readonly host: string;
  /** 0 = random port (tests). */
  readonly port: number;
  /** Exact Host header values; empty = no Host check. */
  readonly allowedHosts: readonly string[];
  /** Also accept `/mcp/k/<token>`. */
  readonly allowUrlToken: boolean;
  /** Tokens whose sessions get writePolicyOverride 'approval'. */
  readonly approvalTokens: ReadonlySet<string>;
  readonly createServer: (session: PrincipalSession) => Promise<McpServer>;
  readonly verifyToken: (token: string) => Promise<boolean>;
}

export interface RunningHttpServer {
  readonly url: string;
  readonly close: () => Promise<void>;
}

interface SessionEntry {
  readonly transport: StreamableHTTPServerTransport;
  readonly server: McpServer;
  readonly tokenHash: string;
}

/** Checks a token against the shell: a rejected key answers HTTP 401/403, anything else is a real error. */
export const verifyTokenWithShell = async (token: string): Promise<boolean> => {
  try {
    await runWithPrincipal(
      { apiKey: token, legalEntityId: undefined, label: 'ověření tokenu', transport: 'http', writePolicyOverride: undefined },
      () => getGatewayContext(VERIFY_AUDIENCE),
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/HTTP 40[13]/u.test(message)) {
      return false;
    }
    throw error;
  }
};

const sendJson = (res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}) => {
  res.writeHead(status, { ...JSON_HEADERS, ...extraHeaders });
  res.end(JSON.stringify(body));
};

const sendUnauthorized = (res: ServerResponse, message: string) =>
  sendJson(res, 401, { error: message }, { 'www-authenticate': BEARER_HEADER });

class BodyTooLargeError extends Error {}
class InvalidJsonError extends Error {}

/** Reads and parses a JSON request body, up to MAX_BODY_BYTES. */
const readJson = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new BodyTooLargeError('body too large');
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf-8');
  if (text.trim() === '') {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InvalidJsonError('invalid JSON');
  }
};

const bearerToken = (header: string | undefined): string | undefined => {
  const match = /^bearer\s+(.+)$/iu.exec(header?.trim() ?? '');
  const token = match?.[1]?.trim();
  return token === undefined || token === '' ? undefined : token;
};

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Starts the MCP Streamable HTTP endpoint; each initialized MCP session is bound to the token that opened it. */
export const startHttpServer = async (options: HttpServerOptions): Promise<RunningHttpServer> => {
  const sessions = new Map<string, SessionEntry>();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const pathname = new URL(req.url ?? '/', 'http://local').pathname;

    if (options.allowedHosts.length > 0 && !options.allowedHosts.includes(req.headers.host ?? '')) {
      sendJson(res, 403, { error: 'Nepovolený Host.' });
      return;
    }

    if (req.method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { ok: true, name: 'ontos-mcp' });
      return;
    }

    let urlToken: string | undefined;
    if (pathname === '/mcp') {
      urlToken = undefined;
    } else {
      const match = options.allowUrlToken ? /^\/mcp\/k\/([^/]+)$/u.exec(pathname) : null;
      if (match?.[1] === undefined) {
        sendJson(res, 404, { error: 'Neznámá cesta.' });
        return;
      }
      try {
        urlToken = decodeURIComponent(match[1]);
      } catch {
        sendJson(res, 404, { error: 'Neznámá cesta.' });
        return;
      }
    }

    const token = bearerToken(req.headers.authorization) ?? urlToken;
    if (token === undefined) {
      sendUnauthorized(res, 'Chybí přístupový token (Authorization: Bearer …).');
      return;
    }
    const tokenHash = sha256(token);

    let body: unknown;
    if (req.method === 'POST') {
      try {
        body = await readJson(req);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          sendJson(res, 413, { error: 'Požadavek je příliš velký.' });
          return;
        }
        if (error instanceof InvalidJsonError) {
          sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
          return;
        }
        throw error;
      }
    }

    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') {
      const entry = sessions.get(sessionId);
      if (entry === undefined) {
        sendJson(res, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
        return;
      }
      if (entry.tokenHash !== tokenHash) {
        sendJson(res, 403, { error: 'Token nepatří k této relaci.' });
        return;
      }
      await entry.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method !== 'POST' || !isInitializeRequest(body)) {
      sendJson(res, 400, { error: 'Chybí mcp-session-id; začněte požadavkem initialize.' });
      return;
    }
    if (!(await options.verifyToken(token))) {
      sendUnauthorized(res, 'Neplatný nebo zneplatněný token.');
      return;
    }

    const session: PrincipalSession = {
      apiKey: token,
      legalEntityId: undefined,
      label: `API klíč ${token.slice(0, 6)}…`,
      transport: 'http',
      writePolicyOverride: options.approvalTokens.has(token) ? 'approval' : undefined,
    };
    const server = await options.createServer(session);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, tokenHash });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId !== undefined) {
        sessions.delete(transport.sessionId);
      }
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    if (transport.sessionId === undefined || !sessions.has(transport.sessionId)) {
      // Initialize did not open a session: release the per-token server instead of leaking it.
      await server.close().catch(() => undefined);
    }
  };

  const httpServer: Server = createHttpServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`mcp http error: ${message}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Interní chyba MCP brány.' });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port, options.host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const actualPort = (httpServer.address() as AddressInfo).port;
  const url = `http://${options.host}:${actualPort}/mcp`;

  const close = async (): Promise<void> => {
    for (const entry of sessions.values()) {
      await entry.transport.close().catch(() => undefined);
      await entry.server.close().catch(() => undefined);
    }
    sessions.clear();
    httpServer.closeIdleConnections();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  };

  return { url, close };
};
