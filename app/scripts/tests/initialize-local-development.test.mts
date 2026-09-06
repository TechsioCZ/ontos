import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Effect } from 'effect';
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

test('accepts only a development configuration with local service endpoints', async () => {
  const configuration = await Effect.runPromise(
    parseLocalDevelopmentConfiguration(localEnvironment),
  );
  assert.equal(configuration.email, LOCAL_DEVELOPMENT_CONTEXT.email);
  assert.equal(configuration.databaseAdminUrl, localEnvironment.DATABASE_ADMIN_URL);

  for (const environment of [
    { ...localEnvironment, ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage' },
    {
      ...localEnvironment,
      DATABASE_ADMIN_URL: 'postgres://ontos_admin:admin@database.example.com:5432/ontos',
    },
    {
      ...localEnvironment,
      SPICEDB_ENDPOINT: 'spicedb.example.com:50051',
      SPICEDB_INSECURE: 'false',
    },
  ]) {
    await assert.rejects(
      Effect.runPromise(parseLocalDevelopmentConfiguration(environment)),
      LocalDevelopmentInitializationError,
    );
  }
});

test('exact reconciliation is idempotent and contradictory records fail closed', () => {
  const expected = { name: 'OntOS Local Development', status: 'active' } as const;
  assert.equal(classifyExactLocalRecord('tenant', undefined, expected), 'create');
  assert.equal(classifyExactLocalRecord('tenant', expected, expected), 'existing');
  assert.throws(
    () => classifyExactLocalRecord('tenant', { ...expected, status: 'suspended' }, expected),
    LocalDevelopmentInitializationError,
  );
});

test('module-state reconciliation preserves migrated IDs and rejects identity collisions', () => {
  const expected = {
    moduleKey: 'party.registry',
    state: 'active',
    tenantId: LOCAL_DEVELOPMENT_CONTEXT.tenantId,
    tenantModuleStateId: moduleStateIdFor('party.registry'),
  } as const;
  assert.equal(
    classifyLocalModuleState('Party Registry module state', undefined, expected),
    'create',
  );
  assert.equal(
    classifyLocalModuleState(
      'Party Registry module state',
      { ...expected, tenantModuleStateId: '7f000000-0000-4000-8000-000000000001' },
      expected,
    ),
    'existing',
  );
  assert.throws(
    () =>
      classifyLocalModuleState(
        'Party Registry module state',
        {
          ...expected,
          moduleKey: 'inventory.core',
          tenantModuleStateId: expected.tenantModuleStateId,
        },
        expected,
      ),
    LocalDevelopmentInitializationError,
  );
});

test('derives only configured Party Registry through its generated owner contract', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ontos-local-modules-'));
  await mkdir(path.join(root, 'topology'), { recursive: true });
  await writeFile(
    path.join(root, 'topology/reference-topology.json'),
    JSON.stringify({ verticals: [{ id: 'party-registry' }, { id: 'inventory' }] }),
    'utf-8',
  );
  const deriveContract = (async ({ vertical }: { readonly vertical: string }) => ({
    manifest: { module: { id: `${vertical}.core` } },
  })) as unknown as typeof deriveOntosModuleDeploymentContract;
  assert.deepEqual(await deriveActivatedModuleIds(root, deriveContract), ['party-registry.core']);
});

test('rejects duplicate module IDs derived from different verticals', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ontos-local-modules-'));
  await mkdir(path.join(root, 'topology'), { recursive: true });
  await writeFile(
    path.join(root, 'topology/reference-topology.json'),
    JSON.stringify({ verticals: [{ id: 'party-registry' }, { id: 'inventory' }] }),
    'utf-8',
  );
  const deriveContract = (async () => ({
    manifest: { module: { id: 'duplicate.core' } },
  })) as unknown as typeof deriveOntosModuleDeploymentContract;
  await assert.rejects(
    deriveActivatedModuleIds(root, deriveContract, ['party-registry', 'inventory']),
    LocalDevelopmentInitializationError,
  );
});

test('generates stable module state IDs and complete access relationships', () => {
  assert.equal(moduleStateIdFor('party.registry'), moduleStateIdFor('party.registry'));
  assert.notEqual(moduleStateIdFor('party.registry'), moduleStateIdFor('inventory.core'));
  const relationships = buildLocalDevelopmentRelationships(['party.registry', 'inventory.core']);
  assert.equal(relationships.length, 7);
  assert.equal(relationships.filter(({ relation }) => relation === 'accessor').length, 2);
  assert.equal(relationships.filter(({ relation }) => relation === 'legal_entity').length, 2);
});
