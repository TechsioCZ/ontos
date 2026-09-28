import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/unstable/process';
import type { SqlError } from 'effect/unstable/sql/SqlError';

import { findPostgresFailure } from '../../packages/core-runtime/src/database/postgres-failure.ts';
import { loadDatabaseConnectionPair } from '../../packages/core-runtime/src/db/config.ts';
import { makeTestPgClient } from '../../packages/core-runtime/tests/support/database.ts';
import { collectToolingProcess } from '../tests/tooling-process-fixture.mts';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const owners = ['pricing', 'storefront-registry'] as const;
const bootstrapScript = 'scripts/postgres/bootstrap-runtime-role.mts';
const pricingTable = 'pricing.currency_support_revisions';
const tenantId = randomUUID();
const legalEntityId = randomUUID();
const otherScopeId = randomUUID();
const effectiveFrom = '2026-09-01T00:00:00.000Z';
const nextEffectiveFrom = '2026-09-02T00:00:00.000Z';
const pricingContext = {
  cartId: 'acl-proof-cart',
  channelId: 'B2B',
  contextRevision: 'acl-proof-context',
  marketId: 'acl-proof-market',
  storefrontId: 'acl-proof-storefront',
  subjectFingerprint: 'acl-proof-subject',
};

type Environment = Readonly<{ DATABASE_ADMIN_URL: string; DATABASE_URL: string }>;

const databaseUrl = (connectionString: string, database: string): string => {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.href;
};

const runCommand = (executable: string, args: readonly string[], env: Environment, cwd = workspaceRoot) =>
  collectToolingProcess(
    ChildProcess.make(executable, args, { cwd, env, extendEnv: true, stderr: 'pipe', stdin: 'ignore', stdout: 'pipe' }),
  ).pipe(Effect.scoped, Effect.timeout('30 seconds'));

const runScript = (script: string, env: Environment) =>
  runCommand(process.execPath, [path.join(workspaceRoot, script)], env);

const expectScriptSuccess = Effect.fn('MigratorRuntimeAccess.expectScriptSuccess')(function* expectScriptSuccessEffect(
  script: string,
  env: Environment,
) {
  const result = yield* runScript(script, env);
  expect(result.status, result.stderr).toBe(0);
});

const expectVerifierFailure = Effect.fn('MigratorRuntimeAccess.expectVerifierFailure')(
  function* expectVerifierFailureEffect(owner: (typeof owners)[number], env: Environment) {
    const result = yield* runScript(`verticals/${owner}/scripts/verify-db-schema.mts`, env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('inventory mismatch');
  },
);

const inScope = <Value, Failure>(
  runtime: PgClient.PgClient,
  scopeTenantId: string,
  scopeLegalEntityId: string,
  operation: Effect.Effect<Value, Failure>,
) =>
  Effect.gen(function* scopedOperation() {
    yield* runtime.unsafe(
      "select set_config('ontos.tenant_id', $1, true), set_config('ontos.legal_entity_id', $2, true)",
      [scopeTenantId, scopeLegalEntityId],
    );
    return yield* operation;
  }).pipe(runtime.withTransaction);

const denied = (operation: Effect.Effect<unknown, SqlError>) =>
  operation.pipe(
    Effect.flip,
    Effect.map((failure) => expect(Option.getOrUndefined(findPostgresFailure(failure))?.code).toBe('42501')),
  );

const setCurrencies = (runtime: PgClient.PgClient, generation: number) =>
  runtime.unsafe<{ readonly result: unknown }>(
    'select result from pricing.set_supported_currencies($1::uuid, $2::uuid, $3::jsonb)',
    [
      tenantId,
      legalEntityId,
      JSON.stringify({
        ...pricingContext,
        actionInvocationId: randomUUID(),
        actorPrincipalId: randomUUID(),
        effectiveFrom: generation === 0 ? effectiveFrom : nextEffectiveFrom,
        expectedGeneration: generation,
        reason: 'Prove exact invoker privileges under forced RLS.',
        supportedCurrencies: generation === 0 ? ['CZK'] : ['CZK', 'EUR'],
      }),
    ],
  );

const readCurrencies = (runtime: PgClient.PgClient) =>
  runtime.unsafe<{ readonly result: unknown }>(
    'select result from pricing.read_current_supported_currencies($1::uuid, $2::uuid, $3::jsonb)',
    [tenantId, legalEntityId, JSON.stringify({ ...pricingContext, effectiveAt: nextEffectiveFrom })],
  );

const verifyRuntimeCalls = Effect.fn('MigratorRuntimeAccess.verifyRuntimeCalls')(function* verifyRuntimeCallsEffect(
  runtime: PgClient.PgClient,
) {
  for (const generation of [0, 1]) {
    const written = yield* inScope(runtime, tenantId, legalEntityId, setCurrencies(runtime, generation));
    expect(written[0]?.result).toMatchObject({ actualGeneration: generation + 1, outcome: 'APPLIED' });
  }
  const current = yield* inScope(runtime, tenantId, legalEntityId, readCurrencies(runtime));
  expect(current[0]?.result).toMatchObject({ generation: 2, supportedCurrencies: ['CZK', 'EUR'] });
  for (const [scopeTenant, scopeEntity] of [
    [otherScopeId, legalEntityId],
    [tenantId, otherScopeId],
  ] as const) {
    expect(yield* inScope(runtime, scopeTenant, scopeEntity, readCurrencies(runtime))).toEqual([]);
    yield* denied(inScope(runtime, scopeTenant, scopeEntity, setCurrencies(runtime, 0)));
  }
  yield* denied(inScope(runtime, tenantId, legalEntityId, runtime.unsafe(`delete from ${pricingTable}`)));
  const storefront = yield* inScope(
    runtime,
    tenantId,
    '',
    runtime.unsafe<{ readonly payload: unknown }>(
      'select payload from storefront_registry.register_storefront_application($1::uuid, $2::jsonb)',
      [
        tenantId,
        JSON.stringify({
          actionInvocationId: randomUUID(),
          allowedChannels: ['B2B'],
          effectiveInterval: { effectiveFrom, effectiveTo: null },
          lifecycle: 'ACTIVE',
          principalId: randomUUID(),
          reason: 'Prove definer access without raw table grants.',
          recordedAt: effectiveFrom,
          storefrontAppId: 'acl-proof-app',
        }),
      ],
    ),
  );
  yield* Schema.decodeUnknownEffect(Schema.Struct({ _tag: Schema.Literal('created'), changed: Schema.Literal(true) }))(
    storefront[0]?.payload,
  );
  const read = yield* inScope(
    runtime,
    tenantId,
    '',
    runtime.unsafe<{ readonly payload: unknown }>(
      'select payload from storefront_registry.read_current_storefront_application($1::uuid, $2::jsonb)',
      [tenantId, JSON.stringify({ effectiveAt: nextEffectiveFrom, storefrontAppId: 'acl-proof-app' })],
    ),
  );
  yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      _tag: Schema.Literal('found'),
      current: Schema.Struct({ lifecycle: Schema.Literal('ACTIVE'), revision: Schema.Literal(1) }),
    }),
  )(read[0]?.payload);
  yield* denied(
    inScope(runtime, tenantId, '', runtime.unsafe('select * from storefront_registry.storefront_applications')),
  );
});

it.live('D1 bootstraps exact owner access and rejects incomplete readiness on a fresh isolated database', () =>
  Effect.gen(function* migratorRuntimeAccess() {
    const connections = yield* loadDatabaseConnectionPair();
    const admin = yield* makeTestPgClient(connections.admin.connectionString);
    // Only this uniquely named test database is created, mutated and removed.
    const database = `ontos_acl_${randomUUID().replaceAll('-', '')}`;
    yield* Effect.acquireRelease(admin.unsafe(`create database "${database}"`), () =>
      admin.unsafe(`drop database "${database}" with (force)`).pipe(Effect.orDie),
    );
    const env = {
      DATABASE_ADMIN_URL: databaseUrl(connections.admin.connectionString, database),
      DATABASE_URL: databaseUrl(connections.runtime.connectionString, database),
    };
    yield* expectScriptSuccess(bootstrapScript, env);
    for (const owner of owners) {
      const directory = path.join(workspaceRoot, 'verticals', owner);
      const migration = yield* runCommand(
        path.join(directory, 'node_modules/.bin/drizzle-kit'),
        ['migrate', '--config', 'drizzle.config.ts'],
        env,
        directory,
      );
      expect(migration.status, migration.stderr).toBe(0);
      yield* expectVerifierFailure(owner, env);
    }
    const isolatedAdmin = yield* makeTestPgClient(env.DATABASE_ADMIN_URL);
    const runtime = yield* makeTestPgClient(env.DATABASE_URL);
    yield* denied(inScope(runtime, tenantId, legalEntityId, readCurrencies(runtime)));
    // Schema USAGE alone is insufficient for Pricing's SECURITY INVOKER routines.
    yield* isolatedAdmin.unsafe('grant usage on schema pricing to ontos_runtime');
    yield* denied(inScope(runtime, tenantId, legalEntityId, setCurrencies(runtime, 0)));
    yield* expectVerifierFailure('pricing', env);
    yield* expectScriptSuccess(bootstrapScript, env);
    for (const owner of owners) {
      yield* expectScriptSuccess(`verticals/${owner}/scripts/verify-db-schema.mts`, env);
    }
    yield* verifyRuntimeCalls(runtime);
    for (const [owner, schema] of [
      ['pricing', 'pricing'],
      ['storefront-registry', 'storefront_registry'],
    ] as const) {
      yield* isolatedAdmin.unsafe(`revoke usage on schema ${schema} from ontos_runtime`);
      yield* expectVerifierFailure(owner, env);
      yield* expectScriptSuccess(bootstrapScript, env);
      yield* expectScriptSuccess(`verticals/${owner}/scripts/verify-db-schema.mts`, env);
    }
    yield* isolatedAdmin.unsafe(`revoke select on ${pricingTable} from ontos_runtime`);
    yield* expectVerifierFailure('pricing', env);
    yield* expectScriptSuccess(bootstrapScript, env);
    yield* expectScriptSuccess('verticals/pricing/scripts/verify-db-schema.mts', env);
    yield* isolatedAdmin.unsafe(`grant delete on ${pricingTable} to ontos_runtime`);
    yield* expectVerifierFailure('pricing', env);
    yield* isolatedAdmin.unsafe(`revoke delete on ${pricingTable} from ontos_runtime`);
    yield* expectScriptSuccess('verticals/pricing/scripts/verify-db-schema.mts', env);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
