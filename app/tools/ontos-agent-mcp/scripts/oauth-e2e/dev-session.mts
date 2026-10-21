// Developer helper for live checks of the OntOS MCP resource server (lane mcp-mcp-rs).
//
//   node --experimental-strip-types scripts/oauth-e2e/dev-session.mts connect <file> <persona> <read_only|approval|direct>
//   node --experimental-strip-types scripts/oauth-e2e/dev-session.mts call <file> <tool> '<json args>'
//   node --experimental-strip-types scripts/oauth-e2e/dev-session.mts tools <file>
//   node --experimental-strip-types scripts/oauth-e2e/dev-session.mts revoke <file>
//
// <file> keeps the client registration and tokens (put it outside the repository). Access tokens are refreshed on demand.
import { readFileSync, writeFileSync } from 'node:fs';
import { decodeJwt } from 'jose';
import { E2E, CIMD_CLIENT_ID, GRANT_CLAIM } from './env.mts';
import { startLoopbackCallback } from './loopback.mts';
import { E2eOAuthProvider } from './provider.mts';
import { runOAuthFlow, rotateRefreshToken } from './flow.mts';
import { connectMcp, callJson } from './mcp.mts';
import { openSharedTab, approveConnection, ensureLoggedIn, sessionPost } from './browser.mts';
import type { StoredOAuthTokens } from '@modelcontextprotocol/client';

interface SavedSession {
  readonly persona: string;
  readonly writeMode: string;
  readonly grantId: string;
  readonly tokens: StoredOAuthTokens;
}

const [command, file, ...rest] = process.argv.slice(2);
if (command === undefined || file === undefined) {
  throw new Error('usage: dev-session.mts <connect|call|tools|revoke> <file> ...');
}

const load = (): SavedSession => JSON.parse(readFileSync(file, 'utf8')) as SavedSession;
const save = (session: SavedSession): void => writeFileSync(file, JSON.stringify(session, null, 1), { mode: 0o600 });

const providerFor = (tokens?: StoredOAuthTokens): E2eOAuthProvider => {
  const provider = new E2eOAuthProvider({
    clientMetadataUrl: CIMD_CLIENT_ID,
    clientName: 'Claude Code',
    onRedirect: async () => undefined,
    redirectUrl: 'http://localhost:1/callback',
  });
  if (tokens !== undefined) {
    provider.saveTokens(tokens);
  }
  return provider;
};

const freshAccess = async (): Promise<string> => {
  const session = load();
  const exp = Number(decodeJwt(session.tokens.access_token).exp ?? 0);
  if (exp * 1000 - Date.now() > 30_000) {
    return session.tokens.access_token;
  }
  const provider = providerFor(session.tokens);
  const next = await rotateRefreshToken({ issuer: E2E.issuer, provider, resource: E2E.mcpUrl });
  save({ ...session, tokens: provider.currentTokens() });
  return next.accessToken;
};

if (command === 'connect') {
  const [persona, writeMode] = rest;
  if (persona === undefined || (writeMode !== 'read_only' && writeMode !== 'approval' && writeMode !== 'direct')) {
    throw new Error('connect <file> <persona> <read_only|approval|direct>');
  }
  const tab = await openSharedTab();
  const loopback = await startLoopbackCallback();
  try {
    const provider = new E2eOAuthProvider({
      clientMetadataUrl: CIMD_CLIENT_ID,
      clientName: 'Claude Code',
      onRedirect: (url: URL) =>
        approveConnection(tab.page, url.toString(), {
          actAs: { kind: 'me' },
          email: persona,
          password: E2E.password,
          shotPrefix: `dev-${persona.split('@')[0] ?? 'x'}`,
          shotsDir: process.env['DEV_SHOTS_DIR'] ?? `${process.env['TMPDIR'] ?? '.'}/mcp-dev-shots`,
          writeMode,
        }),
      redirectUrl: loopback.redirectUrl,
    });
    const flow = await runOAuthFlow({ loopback, provider, serverUrl: E2E.mcpUrl });
    const grantId = String(decodeJwt(flow.accessToken)[GRANT_CLAIM]);
    save({ grantId, persona, tokens: provider.currentTokens(), writeMode });
    process.stdout.write(`${JSON.stringify({ grantId, iss: flow.iss, persona, writeMode })}\n`);
  } finally {
    await loopback.close();
    await tab.close();
  }
} else if (command === 'tools' || command === 'call') {
  // DEV_MCP_URL points at a second RS instance (same resource/audience) for checks before the live restart.
  const { client } = await connectMcp(process.env['DEV_MCP_URL'] ?? E2E.mcpUrl, await freshAccess(), 'modern');
  try {
    if (command === 'tools') {
      const listed = await client.listTools();
      process.stdout.write(`${JSON.stringify(listed.tools, null, 1)}\n`);
    } else {
      const [tool, json] = rest;
      const outcome = await callJson(client, tool ?? 'ontos_whoami', JSON.parse(json ?? '{}') as Record<string, unknown>);
      process.stdout.write(`${JSON.stringify({ chars: outcome.text.length, isError: outcome.isError, text: outcome.text })}\n`);
    }
  } finally {
    await client.close();
  }
} else if (command === 'revoke') {
  const session = load();
  const tab = await openSharedTab();
  try {
    await ensureLoggedIn(tab.page, E2E.shellUrl, session.persona, E2E.password);
    const result = await sessionPost(tab.page, E2E.shellUrl, '/shell-super-app-api/auth/oauth-connections/revoke', {
      grantId: session.grantId,
      reason: 'user',
    });
    process.stdout.write(`${JSON.stringify({ status: result.status, text: result.text.slice(0, 300) })}\n`);
  } finally {
    await tab.close();
  }
} else {
  throw new Error(`unknown command ${command}`);
}
