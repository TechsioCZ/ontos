import { getCatalog } from './catalog/discover.ts';
import { loadRsConfig } from './config.ts';
import { startHttpServer } from './http.ts';
import { buildConnectionTools } from './mcp/tools.ts';
import { createConnectionDescriber } from './oauth/connector.ts';
import type { RsConfig } from './oauth/types.ts';
import { createAccessTokenVerifier, remoteJwks } from './oauth/verify.ts';

const config = loadRsConfig();
// Gateway assertions and vertical calls go to the shell over the internal URL (gateway.ts reads ONTOS_SHELL_URL).
process.env['ONTOS_SHELL_URL'] = config.shellInternalUrl;

/** Design §1: PRM authorization_servers[0] must equal the AS metadata issuer byte for byte. Warn only: the shell may start later. */
const checkIssuer = async (rs: RsConfig): Promise<void> => {
  const issuerUrl = new URL(rs.issuer);
  const metadataUrl = `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname}`;
  try {
    const response = await fetch(metadataUrl);
    const body = response.ok ? ((await response.json()) as { issuer?: unknown }) : {};
    process.stderr.write(body.issuer === rs.issuer ? `issuer OK (${rs.issuer})\n` : `WARNING issuer mismatch or AS metadata unavailable at ${metadataUrl} (HTTP ${response.status})\n`);
  } catch {
    process.stderr.write(`WARNING AS metadata unreachable at ${metadataUrl}\n`);
  }
};

const server = await startHttpServer({
  buildTools: (connection) => buildConnectionTools(connection, { config, getCatalog: () => getCatalog() }),
  config,
  describeConnection: createConnectionDescriber({ config }),
  verifyAccessToken: createAccessTokenVerifier({ audience: config.resourceUrl, issuer: config.issuer, keys: remoteJwks(config.jwksUrl) }),
});
process.stderr.write(`ontos-mcp OAuth resource server ready on ${server.url} (resource ${config.resourceUrl}, issuer ${config.issuer})\n`);
void checkIssuer(config);
void getCatalog().catch((error: unknown) => {
  process.stderr.write(`WARNING catalog not loaded yet: ${error instanceof Error ? error.message : String(error)}\n`);
});

const shutdown = async (): Promise<void> => {
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
