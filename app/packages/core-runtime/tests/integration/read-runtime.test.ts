// @effect-diagnostics asyncFunction:off
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Effect, Schema } from 'effect';
import { Pool } from 'pg';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { coreDatabaseSchema, dataAccessEvents } from '../../src/db/schema.ts';
import { defineSystemModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import {
  makeOperationalScopeRepository,
  makeOperationalScopeResolver,
} from '../../src/operations/context.ts';
import { defineRead } from '../../src/reads/definition.ts';
import { makeReadRuntime } from '../../src/reads/runtime.ts';
import {
  makeSystemPrincipalContextResolver,
  registerSystemWorkload,
} from '../../src/auth/system-principal-context.ts';
import { openModuleEntrypointGateway } from '../support/open-module-entrypoint-gateway.ts';

void test('standalone governed-read evidence permits no Action invocation and requires outcome fields', () => {
  const config = getTableConfig(dataAccessEvents);
  const column = (name: string) => config.columns.find((candidate) => candidate.name === name);
  assert.equal(column('action_invocation_id')?.notNull, false);
  assert.equal(column('outcome')?.notNull, true);
  assert.equal(column('outcome_stage')?.notNull, true);
  assert.equal(column('outcome_code')?.notNull, true);
});

void test('commits live allowed evidence before releasing a governed read result', async () => {
  const connections = await Effect.runPromise(loadDatabaseConnectionPair());
  const admin = new Pool({ connectionString: connections.admin.connectionString });
  const runtimePool = new Pool({ connectionString: connections.runtime.connectionString });
  const runtimeDatabase = drizzle({ client: runtimePool, schema: coreDatabaseSchema });
  const tenantId = randomUUID();
  const principalId = randomUUID();
  const readKey = `core.shell.integration.${randomUUID()}`;
  const correlationId = randomUUID();
  const registration = defineRead(
    {
      accessKind: 'list',
      entrypoint: defineSystemModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'context_permission', permission: 'module.access' },
        entrypointKey: readKey,
        moduleKey: 'core.shell',
        role: 'api',
      }),
      evidencePolicy: { captureMode: 'metadata_only', policyKey: `${readKey}.v1` },
      inputSchema: Schema.Struct({}),
      legalEntityScope: 'forbidden',
      owningModuleKey: 'core.shell',
      permissionTarget: 'module',
      policies: [],
      readKey,
      resultSchema: Schema.Array(Schema.String),
      schemaVersion: '1',
    },
    () => Effect.succeed({ evidence: { resultCount: 1 }, result: ['visible'] }),
    () => Effect.succeed({}),
    () => ({ kind: 'module', moduleId: 'core.shell' }),
  );

  try {
    await admin.query(
      `insert into core.tenants (tenant_id, slug, name, status, default_locale) values ($1, $2, 'Read runtime tenant', 'active', 'en')`,
      [tenantId, `read-runtime-${tenantId}`],
    );
    await admin.query(
      `insert into core.principals (principal_id, tenant_id, kind, display_name, status) values ($1, $2, 'system', 'Read runtime principal', 'active')`,
      [principalId, tenantId],
    );
    const contextAccess = {
      legalEntities: () => Effect.succeed([]),
      modules: () => Effect.succeed([]),
      resources: () => Effect.succeed([]),
      tenants: () => Effect.succeed([]),
    };
    const principal = await Effect.runPromise(
      makeSystemPrincipalContextResolver({ executor: runtimeDatabase }).resolve({
        principalId,
        registration: registerSystemWorkload({ jobKey: 'read-runtime-integration' }),
        runReference: readKey,
        tenantId,
      }),
    );
    const runtime = makeReadRuntime(
      { executor: runtimeDatabase },
      openModuleEntrypointGateway,
      makeOperationalScopeResolver(
        makeOperationalScopeRepository({ executor: runtimeDatabase }),
        contextAccess,
      ),
      contextAccess,
    );
    assert.deepEqual(
      await Effect.runPromise(
        runtime.runRead({
          input: {},
          principal,
          registration,
          transport: { correlationId },
        }),
      ),
      ['visible'],
    );
    const evidence = await admin.query<{
      action_invocation_id: null;
      outcome: string;
      outcome_code: string;
      query_hash: null;
      result_count: number;
    }>(
      `select action_invocation_id, outcome, outcome_code, query_hash, result_count from core.data_access_events where tenant_id = $1 and evidence_policy_key = $2`,
      [tenantId, `${readKey}.v1`],
    );
    assert.deepEqual(evidence.rows, [
      {
        action_invocation_id: null,
        outcome: 'allowed',
        outcome_code: 'read_allowed',
        query_hash: null,
        result_count: 1,
      },
    ]);
  } finally {
    await admin.query('delete from core.data_access_events where tenant_id = $1', [tenantId]);
    await admin.query('delete from core.principals where tenant_id = $1', [tenantId]);
    await admin.query('delete from core.tenants where tenant_id = $1', [tenantId]);
    await runtimePool.end();
    await admin.end();
  }
});
