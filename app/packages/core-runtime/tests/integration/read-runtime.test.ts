import { expect, it } from '@app/effect-rstest';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { Effect, Schema } from 'effect';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  makeSystemPrincipalContextResolver,
  registerSystemWorkload,
} from '../../src/auth/system-principal-context.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { coreRelations, dataAccessEvents } from '../../src/db/schema.ts';
import { defineSystemModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import {
  makeOperationalScopeRepository,
  makeOperationalScopeResolver,
} from '../../src/operations/context.ts';
import { defineRead } from '../../src/reads/definition.ts';
import { makeReadRuntime } from '../../src/reads/runtime.ts';
import { makeTestDatabaseFromPool } from '../support/database.ts';
import { openModuleEntrypointGateway } from '../support/open-module-entrypoint-gateway.ts';

it('standalone governed-read evidence permits no Action invocation and requires outcome fields', () => {
  const config = getTableConfig(dataAccessEvents);
  const column = (name: string) => config.columns.find((candidate) => candidate.name === name);
  expect(column('action_invocation_id')?.notNull).toBe(false);
  expect(column('outcome')?.notNull).toBe(true);
  expect(column('outcome_stage')?.notNull).toBe(true);
  expect(column('outcome_code')?.notNull).toBe(true);
});

it.live('commits live allowed evidence before releasing a governed read result', () =>
  Effect.gen(function* readRuntime1() {
    const connections = yield* loadDatabaseConnectionPair();
    const admin = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: connections.admin.connectionString })),
      (ownedPool) => Effect.promise(() => ownedPool.end()).pipe(Effect.orDie),
    );
    const runtimePool = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: connections.runtime.connectionString })),
      (ownedPool) => Effect.promise(() => ownedPool.end()).pipe(Effect.orDie),
    );
    const runtimeDatabase = yield* makeTestDatabaseFromPool(runtimePool, coreRelations);
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

    yield* Effect.acquireRelease(Effect.void, () =>
      Effect.gen(function* readRuntime2() {
        yield* Effect.promise(() =>
          admin.query('delete from core.data_access_events where tenant_id = $1', [tenantId]),
        );
        yield* Effect.promise(() =>
          admin.query('delete from core.principals where tenant_id = $1', [tenantId]),
        );
        yield* Effect.promise(() =>
          admin.query('delete from core.tenants where tenant_id = $1', [tenantId]),
        );
      }).pipe(Effect.orDie),
    );

    yield* Effect.promise(() =>
      admin.query(
        `insert into core.tenants (tenant_id, slug, name, status, default_locale) values ($1, $2, 'Read runtime tenant', 'active', 'en')`,
        [tenantId, `read-runtime-${tenantId}`],
      ),
    );
    yield* Effect.promise(() =>
      admin.query(
        `insert into core.principals (principal_id, tenant_id, kind, display_name, status) values ($1, $2, 'system', 'Read runtime principal', 'active')`,
        [principalId, tenantId],
      ),
    );
    const contextAccess = {
      legalEntities: () => Effect.succeed([]),
      modules: () => Effect.succeed([]),
      resources: () => Effect.succeed([]),
      tenants: () => Effect.succeed([]),
    };
    const principal = yield* makeSystemPrincipalContextResolver({
      executor: runtimeDatabase,
    }).resolve({
      principalId,
      registration: registerSystemWorkload({ jobKey: 'read-runtime-integration' }),
      runReference: readKey,
      tenantId,
    });
    const runtime = makeReadRuntime(
      { executor: runtimeDatabase },
      openModuleEntrypointGateway,
      makeOperationalScopeResolver(
        makeOperationalScopeRepository({ executor: runtimeDatabase }),
        contextAccess,
      ),
      contextAccess,
    );
    expect(
      yield* runtime.runRead({
        input: {},
        principal,
        registration,
        transport: { correlationId },
      }),
    ).toEqual(['visible']);
    const evidence = yield* Effect.promise(() =>
      admin.query<{
        action_invocation_id: null;
        outcome: string;
        outcome_code: string;
        query_hash: null;
        result_count: number;
      }>(
        `select action_invocation_id, outcome, outcome_code, query_hash, result_count from core.data_access_events where tenant_id = $1 and evidence_policy_key = $2`,
        [tenantId, `${readKey}.v1`],
      ),
    );
    expect(evidence.rows).toEqual([
      {
        action_invocation_id: null,
        outcome: 'allowed',
        outcome_code: 'read_allowed',
        query_hash: null,
        result_count: 1,
      },
    ]);
  }),
);
