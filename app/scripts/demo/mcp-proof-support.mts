/**
 * Shared helpers for the MCP proofs (prove-ai-c, prove-ai-c-obchod, prove-ai-levels). LOCAL ONLY.
 *
 * - readDemoEnv / shellUrl: process.env first, then app/.env.demo.local.
 * - issuePersonalKey: signs a demo user in and issues a personal API key through the shell; revoke() ends it.
 * - readAudit: Core audit rows for the given principals since a moment.
 * - ensureMcpServer: reuses a running HTTP MCP server on 3090, otherwise starts one on 3091.
 *
 * No top-level side effects other than constants. Secrets are never printed.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { Config, ConfigProvider, Effect, Layer, Path, Redacted, Schema } from 'effect';
import { NodeServices } from '@effect/platform-node';

import { DatabaseConfig, parseDatabaseConfig } from '../../packages/core-runtime/src/db/config.ts';
import { actionInvocations, auditEvents } from '../../packages/core-runtime/src/db/schema.ts';
import { AuthDatabase, AuthDatabaseFromDatabaseConfigLive } from '../../apps/shell-super-app/api/auth/db/client.ts';
import { apikey } from '../../apps/shell-super-app/api/auth/db/schema.ts';

export const appRoot = new URL('../..', import.meta.url);
const ENV_FILE = new URL('.env.demo.local', appRoot);
const MCP_HTTP_MODULE = new URL('tools/ontos-agent-mcp/src/http-main.ts', appRoot);
const MCP_HTTP_EXISTING_PORT = 3090;
const MCP_HTTP_STARTED_PORT = 3091;

const readEnvFile = (): ReadonlyMap<string, string> =>
  new Map(
    (existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf-8') : '').split('\n').flatMap((line) => {
      const match = /^(?<key>[A-Z][A-Z0-9_]*)=(?<value>.*)$/u.exec(line.trim());
      return match?.groups?.key === undefined ? [] : [[match.groups.key, match.groups.value ?? ''] as const];
    }),
  );

export const readDemoEnv = (key: string): string | undefined => process.env[key] ?? readEnvFile().get(key);

export const shellUrl: string = (readDemoEnv('ONTOS_SHELL_URL') ?? 'http://localhost:3020').replace(/\/+$/u, '');

// ---------------------------------------------------------------------------------------------- auth database

const authDatabaseLayer = AuthDatabaseFromDatabaseConfigLive.pipe(
  Layer.provide(
    Layer.effect(
      DatabaseConfig,
      Config.Redacted('DATABASE_ADMIN_URL').pipe(
        Effect.flatMap((url) => parseDatabaseConfig({ DATABASE_URL: Redacted.value(url) })),
      ),
    ),
  ),
  Layer.provide(
    ConfigProvider.layer(
      Effect.gen(function* loadEnv() {
        const path = yield* Path.Path;
        const root = yield* path.fromFileUrl(appRoot);
        const file = yield* ConfigProvider.fromDotEnv({ path: path.join(root, '.env') });
        return ConfigProvider.orElse(ConfigProvider.fromEnv(), file);
      }),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const runWithAuthDatabase = <A, E>(effect: Effect.Effect<A, E, AuthDatabase>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(authDatabaseLayer), Effect.scoped));

// ---------------------------------------------------------------------------------------------- personal key

export interface PersonalKey {
  readonly secret: string;
  readonly authBindingId: string;
  readonly revoke: () => Promise<void>;
}

const ApiKeyResponse = Schema.Struct({
  authBindingId: Schema.String,
  secret: Schema.String,
});
const isApiKeyResponse = Schema.is(ApiKeyResponse);

export const issuePersonalKey = async (email: string, password: string, name: string): Promise<PersonalKey> => {
  const signIn = await fetch(`${shellUrl}/shell-super-app-api/auth/sign-in`, {
    body: JSON.stringify({ email, password }),
    headers: { 'content-type': 'application/json', origin: shellUrl },
    method: 'POST',
  });
  if (!signIn.ok) {
    throw new Error(`Přihlášení ${email} selhalo: HTTP ${signIn.status}`);
  }
  const cookie = signIn.headers
    .getSetCookie()
    .map((raw) => raw.split(';')[0])
    .join('; ');

  const created = await fetch(`${shellUrl}/shell-super-app-api/auth/identity/api-keys/self`, {
    body: JSON.stringify({ name }),
    headers: {
      'content-type': 'application/json',
      cookie,
      origin: shellUrl,
      'idempotency-key': randomUUID(),
    },
    method: 'POST',
  });
  const text = await created.text();
  if (!created.ok) {
    throw new Error(`Vydání klíče ${name} selhalo: HTTP ${created.status} ${text.slice(0, 200)}`);
  }
  const issued: unknown = JSON.parse(text);
  if (!isApiKeyResponse(issued)) {
    throw new Error(`Vydání klíče ${name}: neočekávaná odpověď HTTP ${created.status} ${text.slice(0, 200)}`);
  }
  const { authBindingId, secret } = issued;

  // Better Auth gives every new key a small daily rate limit; the proofs call MCP many times.
  await runWithAuthDatabase(
    Effect.gen(function* liftApiKeyRateLimit() {
      const { executor } = yield* AuthDatabase;
      yield* executor
        .update(apikey)
        .set({ rateLimitEnabled: false, requestCount: 0 })
        .where(eq(apikey.name, name));
    }),
  );

  return {
    authBindingId,
    revoke: async () => {
      const revoked = await fetch(`${shellUrl}/shell-super-app-api/auth/identity/api-keys/self/status`, {
        body: JSON.stringify({
          authBindingId,
          expectedStatus: 'active',
          newStatus: 'revoked',
          reason: 'Konec důkazu demo:prove:mcp',
        }),
        headers: {
          'content-type': 'application/json',
          cookie,
          origin: shellUrl,
          'idempotency-key': randomUUID(),
        },
        method: 'POST',
      });
      if (!revoked.ok) {
        throw new Error(`Zrušení klíče ${name} selhalo: HTTP ${revoked.status}`);
      }
    },
    secret,
  };
};

// ---------------------------------------------------------------------------------------------- audit

export interface AuditRow {
  readonly actionKey: string | null;
  readonly occurredAt: Date;
  readonly outcome: string;
  readonly outcomeCode: string;
  readonly principalId: string | null;
}

export const readAudit = async (principalIds: readonly string[], since: Date): Promise<readonly AuditRow[]> => {
  if (principalIds.length === 0) {
    return [];
  }
  return await runWithAuthDatabase(
    Effect.gen(function* readAuditRows() {
      const { executor } = yield* AuthDatabase;
      return yield* executor
        .select({
          actionKey: actionInvocations.actionKey,
          occurredAt: auditEvents.occurredAt,
          outcome: auditEvents.outcome,
          outcomeCode: auditEvents.outcomeCode,
          principalId: auditEvents.principalId,
        })
        .from(auditEvents)
        .leftJoin(actionInvocations, eq(actionInvocations.actionInvocationId, auditEvents.actionInvocationId))
        .where(and(inArray(auditEvents.principalId, [...principalIds]), gte(auditEvents.occurredAt, since)))
        .orderBy(desc(auditEvents.occurredAt))
        .limit(100);
    }),
  );
};

// ---------------------------------------------------------------------------------------------- MCP HTTP server

const isHealthy = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.status === 200;
  } catch {
    return false;
  }
};

export const ensureMcpServer = async (): Promise<{ readonly url: string; readonly stop: () => void }> => {
  const existingHealth = `http://127.0.0.1:${MCP_HTTP_EXISTING_PORT}/healthz`;
  if (await isHealthy(existingHealth)) {
    return { stop: () => undefined, url: `http://127.0.0.1:${MCP_HTTP_EXISTING_PORT}/mcp` };
  }

  const child = spawn(process.execPath, ['--no-warnings', fileURLToPath(MCP_HTTP_MODULE)], {
    env: { ...process.env, ONTOS_MCP_HTTP_PORT: String(MCP_HTTP_STARTED_PORT) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const healthUrl = `http://127.0.0.1:${MCP_HTTP_STARTED_PORT}/healthz`;
  const deadline = Date.now() + 60_000;
  while (!(await isHealthy(healthUrl))) {
    if (Date.now() > deadline || child.exitCode !== null) {
      child.kill();
      throw new Error(`MCP HTTP server neodpověděl na ${healthUrl}: ${stderr.slice(-400)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return {
    stop: () => {
      child.kill();
    },
    url: `http://127.0.0.1:${MCP_HTTP_STARTED_PORT}/mcp`,
  };
};
