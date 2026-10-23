const env = process.env;

export const E2E = {
  shellUrl: env.ONTOS_SHELL_URL ?? 'http://localhost:3020',
  mcpUrl: `${(env.ONTOS_SHELL_URL ?? 'http://localhost:3020').replace(/\/+$/u, '')}/mcp`,
  issuer: env.ONTOS_OAUTH_ISSUER ?? 'http://localhost:3020/shell-super-app-api/oauth',
  password: env.E2E_PASSWORD ?? 'password1234',
  outDir: env.E2E_OUT_DIR ?? '/Volumes/TraceDecayKingston/techsio-demo/v2/qa',
  shotsDir: env.E2E_SHOTS_DIR ?? '/Volumes/TraceDecayKingston/techsio-demo/v2/shots/mcp-oauth-e2e',
} as const;

export const VERIFICATION_PERSONA = 'verification@ci.ontos';

export const PERSONA = 'management@siampark.demo';

/** Company administrator of Obchodní firma; operator of its seeded AI agents (variant 2 acts as agent B). */
export const AGENT_OPERATOR_PERSONA = 'obchod@demo.ontos';

/** Client ID Metadata Document; its redirect allows http://localhost/callback (port-agnostic). */
export const CIMD_CLIENT_ID = 'https://claude.ai/oauth/claude-code-client-metadata';

export const OAUTH_SCOPES = 'openid profile email offline_access ontos';

export const GRANT_CLAIM = 'https://ontos.cz/grant';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
