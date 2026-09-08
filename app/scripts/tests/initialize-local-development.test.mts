import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { NodeFileSystem, NodePath } from '@effect/platform-node';
import { Effect, Exit, Layer } from 'effect';
import { ConnectionError, SqlError } from 'effect/unstable/sql/SqlError';

import { runEffectTestPromise } from '../../packages/core-runtime/src/testing/effect-runtime.ts';
import { makeModuleContractFixture } from '../../packages/core-runtime/src/testing/module-contract.ts';
import { makeTestDatabase } from '../../packages/core-runtime/tests/support/database.ts';
import type { deriveOntosModuleDeploymentContract } from '../generate-ontos-module-contract.mts';
import {
  LOCAL_DEVELOPMENT_CONTEXT,
  LocalDevelopmentInitializationError,
  buildLocalDevelopmentRelationships,
  classifyExactLocalRecord,
  classifyLocalModuleState,
  deriveActivatedModuleIds,
  moduleStateIdFor,
  parseLocalDevelopmentConfiguration,
  reconcileCoreContext,
} from '../initialize-local-development.mts';

const localEnvironment = {
  BETTER_AUTH_SECRET: 'a-local-secret-with-at-least-32-characters',
  BETTER_AUTH_URL: 'http://localhost:3020',
  DATABASE_ADMIN_URL: 'postgres://ontos_admin:admin@localhost:5432/ontos',
  DATABASE_URL: 'postgres://ontos_runtime:runtime@localhost:5432/ontos',
  SPICEDB_ENDPOINT: 'localhost:50051',
  SPICEDB_INSECURE: 'true',
  SPICEDB_PRESHARED_KEY: 'local-spicedb-key',
  ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'development',
} as const;

const LOCAL_AUTH_USER_ID = 'local-auth-user';
const INVENTORY_MODULE_ID = 'inventory.core';
const LOCAL_MODULES_DIRECTORY_PREFIX = 'ontos-local-modules-';
const PARTY_REGISTRY_MODULE_ID = 'party.registry';
const PARTY_REGISTRY_MODULE_STATE_LABEL = 'Party Registry module state';
const TOPOLOGY_DIRECTORY = 'topology';
const TOPOLOGY_PATH = 'topology/reference-topology.json';
const topology = JSON.stringify({
  verticals: [{ id: 'party-registry' }, { id: 'inventory' }],
});

const moduleContract = (
  moduleId: string
): Awaited<ReturnType<typeof deriveOntosModuleDeploymentContract>> =>
  makeModuleContractFixture({
    appId: 'test-module',
    buildMarker: 'test-build',
    moduleId,
  });

void test('accepts only a development configuration with local service endpoints', async () => {
  const configuration = await runEffectTestPromise(
    parseLocalDevelopmentConfiguration(localEnvironment)
  );
  assert.equal(configuration.email, LOCAL_DEVELOPMENT_CONTEXT.email);
  assert.equal(
    configuration.databaseAdminUrl,
    localEnvironment.DATABASE_ADMIN_URL
  );

  await Promise.all(
    [
      { ...localEnvironment, ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage' },
      {
        ...localEnvironment,
        DATABASE_ADMIN_URL:
          'postgres://ontos_admin:admin@database.example.com:5432/ontos',
      },
      {
        ...localEnvironment,
        SPICEDB_ENDPOINT: 'spicedb.example.com:50051',
        SPICEDB_INSECURE: 'false',
      },
    ].map(
      async (environment) =>
        await assert.rejects(
          runEffectTestPromise(parseLocalDevelopmentConfiguration(environment)),
          LocalDevelopmentInitializationError
        )
    )
  );
});

void test('exact reconciliation is idempotent and contradictory records fail in the typed channel', async () => {
  const expected = {
    name: 'OntOS Local Development',
    status: 'active',
  } as const;
  assert.equal(
    await runEffectTestPromise(
      classifyExactLocalRecord('tenant', undefined, expected)
    ),
    'create'
  );
  assert.equal(
    await runEffectTestPromise(
      classifyExactLocalRecord('tenant', expected, expected)
    ),
    'existing'
  );
  const conflict = await runEffectTestPromise(
    classifyExactLocalRecord(
      'tenant',
      { ...expected, status: 'suspended' },
      expected
    ).pipe(Effect.flip)
  );
  assert.equal(conflict.code, 'local_conflict');
  assert.match(conflict.reason, /status/u);
});

void test('module-state reconciliation preserves migrated IDs and rejects identity collisions', async () => {
  const expected = {
    moduleKey: PARTY_REGISTRY_MODULE_ID,
    state: 'active',
    tenantId: LOCAL_DEVELOPMENT_CONTEXT.tenantId,
    tenantModuleStateId: moduleStateIdFor(PARTY_REGISTRY_MODULE_ID),
  } as const;
  assert.equal(
    await runEffectTestPromise(
      classifyLocalModuleState(
        PARTY_REGISTRY_MODULE_STATE_LABEL,
        undefined,
        expected
      )
    ),
    'create'
  );
  assert.equal(
    await runEffectTestPromise(
      classifyLocalModuleState(
        PARTY_REGISTRY_MODULE_STATE_LABEL,
        {
          ...expected,
          tenantModuleStateId: '7f000000-0000-4000-8000-000000000001',
        },
        expected
      )
    ),
    'existing'
  );
  await assert.rejects(
    runEffectTestPromise(
      classifyLocalModuleState(
        PARTY_REGISTRY_MODULE_STATE_LABEL,
        {
          ...expected,
          moduleKey: INVENTORY_MODULE_ID,
          tenantModuleStateId: expected.tenantModuleStateId,
        },
        expected
      )
    ),
    LocalDevelopmentInitializationError
  );
});

void test('derives only configured Party Registry through its generated owner contract', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), LOCAL_MODULES_DIRECTORY_PREFIX)
  );
  await mkdir(path.join(root, TOPOLOGY_DIRECTORY), { recursive: true });
  await writeFile(path.join(root, TOPOLOGY_PATH), topology, 'utf-8');
  const deriveContract = async ({ vertical }: { readonly vertical: string }) =>
    moduleContract(`${vertical}.core`);
  assert.deepEqual(
    await runEffectTestPromise(
      deriveActivatedModuleIds(root, deriveContract).pipe(
        Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))
      )
    ),
    ['party-registry.core']
  );
});

void test('rejects duplicate module IDs derived from different verticals', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), LOCAL_MODULES_DIRECTORY_PREFIX)
  );
  await mkdir(path.join(root, TOPOLOGY_DIRECTORY), { recursive: true });
  await writeFile(path.join(root, TOPOLOGY_PATH), topology, 'utf-8');
  const deriveContract = async () => moduleContract('duplicate.core');
  await assert.rejects(
    runEffectTestPromise(
      deriveActivatedModuleIds(root, deriveContract, [
        'party-registry',
        'inventory',
      ]).pipe(
        Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))
      )
    ),
    LocalDevelopmentInitializationError
  );
});

void test('generates stable module state IDs and complete access relationships', async () => {
  assert.equal(
    moduleStateIdFor(PARTY_REGISTRY_MODULE_ID),
    moduleStateIdFor(PARTY_REGISTRY_MODULE_ID)
  );
  assert.notEqual(
    moduleStateIdFor(PARTY_REGISTRY_MODULE_ID),
    moduleStateIdFor(INVENTORY_MODULE_ID)
  );
  const relationships = await runEffectTestPromise(
    buildLocalDevelopmentRelationships([
      PARTY_REGISTRY_MODULE_ID,
      INVENTORY_MODULE_ID,
    ])
  );
  assert.equal(relationships.length, 7);
  assert.equal(
    relationships.filter(({ relation }) => relation === 'accessor').length,
    2
  );
  assert.equal(
    relationships.filter(({ relation }) => relation === 'legal_entity').length,
    2
  );
});

void test('a late module conflict rolls back Core bootstrap and retains its typed reason', async () => {
  const statements: string[] = [];
  const database = makeTestDatabase((sql) =>
    Effect.sync(() => {
      statements.push(sql);
      return sql.includes('from "core"."tenant_module_states"') ? [{}, {}] : [];
    })
  );

  const conflict = await runEffectTestPromise(
    reconcileCoreContext(database, LOCAL_AUTH_USER_ID, [
      PARTY_REGISTRY_MODULE_ID,
    ]).pipe(Effect.flip)
  );

  assert.equal(conflict.code, 'local_conflict');
  assert.match(conflict.reason, /module-state identity conflicts/u);
  assert.ok(
    statements.some((sql) => sql.startsWith('insert into "core"."tenants"'))
  );
  assert.equal(statements.at(-1), 'ROLLBACK');
  assert.ok(!statements.includes('COMMIT'));
});

void test('native commit failure becomes a typed bootstrap error', async () => {
  const database = makeTestDatabase((sql) =>
    sql === 'COMMIT'
      ? Effect.fail(
          new SqlError({
            reason: new ConnectionError({
              cause: new Error('connection closed'),
            }),
          })
        )
      : Effect.succeed([])
  );

  const error = await runEffectTestPromise(
    reconcileCoreContext(database, LOCAL_AUTH_USER_ID, []).pipe(Effect.flip)
  );
  assert.equal(error.code, 'local_persistence_failed');
});

void test('bootstrap preserves unrelated defects after native rollback', async () => {
  const defect = new Error('unexpected query defect');
  const statements: string[] = [];
  const database = makeTestDatabase((sql) =>
    Effect.suspend(() => {
      statements.push(sql);
      return sql.startsWith('select ')
        ? Effect.die(defect)
        : Effect.succeed([]);
    })
  );

  const exit = await runEffectTestPromise(
    reconcileCoreContext(database, LOCAL_AUTH_USER_ID, []).pipe(Effect.exit)
  );
  assert.deepEqual(exit, Exit.die(defect));
  assert.equal(statements.at(-1), 'ROLLBACK');
});
