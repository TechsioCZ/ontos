import { Config, Context, Effect, Redacted } from 'effect';

interface E2eConfiguration {
  readonly issuer: string;
  readonly mcpUrl: string;
  readonly outDir: string;
  readonly password: Redacted.Redacted;
  readonly shellUrl: string;
  readonly shotsDir: string;
}

export class E2eSettings extends Context.Service<E2eSettings, E2eConfiguration>()('OAuthProof/E2eSettings') {}

/** Loaded once at the executable edge, with ConfigProvider supplied by the runtime. */
export const loadE2eSettings = Effect.gen(function* loadSettings() {
  const shellUrl = yield* Config.String('ONTOS_SHELL_URL').pipe(Config.withDefault('http://localhost:3020'));
  return {
    issuer: yield* Config.String('ONTOS_OAUTH_ISSUER').pipe(
      Config.withDefault('http://localhost:3020/shell-super-app-api/oauth'),
    ),
    mcpUrl: `${shellUrl.replace(/\/+$/u, '')}/mcp`,
    outDir: yield* Config.String('E2E_OUT_DIR').pipe(
      Config.withDefault('/Volumes/TraceDecayKingston/techsio-demo/v2/qa'),
    ),
    password: yield* Config.Redacted('E2E_PASSWORD').pipe(Config.withDefault(Redacted.make('password1234'))),
    shellUrl,
    shotsDir: yield* Config.String('E2E_SHOTS_DIR').pipe(
      Config.withDefault('/Volumes/TraceDecayKingston/techsio-demo/v2/shots/mcp-oauth-e2e'),
    ),
  } satisfies E2eConfiguration;
});

export const VERIFICATION_PERSONA = 'verification@ci.ontos';

export const PERSONA = 'management@najempark.demo';

/** Company administrator of Obchodní firma; operator of its seeded AI agents (variant 2 acts as agent B). */
export const AGENT_OPERATOR_PERSONA = 'obchod@demo.ontos';

/** Client ID Metadata Document; its redirect allows http://localhost/callback (port-agnostic). */
export const CIMD_CLIENT_ID = 'https://claude.ai/oauth/claude-code-client-metadata';

export const OAUTH_SCOPES = 'openid profile email offline_access ontos';

export const GRANT_CLAIM = 'https://ontos.cz/grant';
