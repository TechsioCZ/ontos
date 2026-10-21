import { createOntosMcpServer } from './create-server.ts';
import { readSetting } from './config.ts';
import { startHttpServer, verifyTokenWithShell } from './http.ts';

const port = Number(readSetting('ONTOS_MCP_HTTP_PORT') ?? '3090');
const host = readSetting('ONTOS_MCP_HTTP_HOST') ?? '127.0.0.1';
const extraHosts = (readSetting('ONTOS_MCP_ALLOWED_HOSTS') ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);
const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, ...extraHosts];

// Legacy level-C keys keep the approval policy when used over HTTP.
const approvalTokens = new Set(
  [readSetting('ONTOS_AGENT_C_HANAK_API_KEY'), readSetting('ONTOS_AGENT_C_OBCHOD_API_KEY')].filter(
    (value): value is string => value !== undefined,
  ),
);

const server = await startHttpServer({
  host,
  port,
  allowedHosts,
  allowUrlToken: readSetting('ONTOS_MCP_ALLOW_URL_TOKEN') === '1',
  approvalTokens,
  createServer: (session) => createOntosMcpServer(session, { legacyTools: false }),
  verifyToken: verifyTokenWithShell,
});

process.stderr.write(`ontos-mcp HTTP ready on ${server.url}\n`);

const shutdown = async (): Promise<void> => {
  await server.close();
  process.exit(0);
};

process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});
