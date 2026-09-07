import { runEffectTestPromise } from '../../packages/core-runtime/src/testing/effect-runtime.ts';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
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

const INVENTORY_MODULE_ID = 'inventory.core';
const LOCAL_MODULES_DIRECTORY_PREFIX = 'ontos-local-modules-';
const PARTY_REGISTRY_MODULE_ID = 'party.registry';
const PARTY_REGISTRY_MODULE_STATE_LABEL = 'Party Registry module state';
const TOPOLOGY_DIRECTORY = 'topology';
const TOPOLOGY_PATH = 'topology/reference-topology.json';
const topology = JSON.stringify({ verticals: [{ id: 'party-registry' }, { id: 'inventory' }] });

const moduleContract = (
  moduleId: string,
): Awaited<ReturnType<typeof deriveOntosModuleDeploymentContract>> => ({
  deployment: { appId: 'test-module', buildMarker: 'test-build' },
  manifest: {
    activation: {
      defaultState: 'inactive',
      preservesHistoryWhenInactive: true,
      scope: 'tenant',
      supportedStates: ['inactive', 'active'],
    },
    module: {
      description: `${moduleId} module`,
      displayName: moduleId,
      id: moduleId,
      implementedAs: 'ultramodern_microvertical',
      kind: 'business_module',
    },
    publicSurface: {
      actions: [],
      api: [],
      components: [],
      events: [],
      reports: [],
      resourceTypes: [],
      search: [],
      shellContributions: {
        mediaAttachments: [],
        navigation: [],
        pages: [],
        publicComponents: [],
        reports: [],
        resourceDetails: [],
        search: [],
        timelines: [],
      },
    },
  },
  runtime: { outboxSubscriptions: [] },
  schemaVersion: '2',
});

void test('accepts only a development configuration with local service endpoints', async () => {
  const configuration = await runEffectTestPromise(
    parseLocalDevelopmentConfiguration(localEnvironment),
  );
  assert.equal(configuration.email, LOCAL_DEVELOPMENT_CONTEXT.email);
  assert.equal(configuration.databaseAdminUrl, localEnvironment.DATABASE_ADMIN_URL);

  await Promise.all(
    [
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
    ].map(
      async (environment) =>
        await assert.rejects(
          runEffectTestPromise(parseLocalDevelopmentConfiguration(environment)),
          LocalDevelopmentInitializationError,
        ),
    ),
  );
});

void test('exact reconciliation is idempotent and contradictory records fail closed', () => {
  const expected = { name: 'OntOS Local Development', status: 'active' } as const;
  assert.equal(classifyExactLocalRecord('tenant', undefined, expected), 'create');
  assert.equal(classifyExactLocalRecord('tenant', expected, expected), 'existing');
  assert.throws(
    () => classifyExactLocalRecord('tenant', { ...expected, status: 'suspended' }, expected),
    LocalDevelopmentInitializationError,
  );
});

void test('module-state reconciliation preserves migrated IDs and rejects identity collisions', () => {
  const expected = {
    moduleKey: PARTY_REGISTRY_MODULE_ID,
    state: 'active',
    tenantId: LOCAL_DEVELOPMENT_CONTEXT.tenantId,
    tenantModuleStateId: moduleStateIdFor(PARTY_REGISTRY_MODULE_ID),
  } as const;
  assert.equal(
    classifyLocalModuleState(PARTY_REGISTRY_MODULE_STATE_LABEL, undefined, expected),
    'create',
  );
  assert.equal(
    classifyLocalModuleState(
      PARTY_REGISTRY_MODULE_STATE_LABEL,
      { ...expected, tenantModuleStateId: '7f000000-0000-4000-8000-000000000001' },
      expected,
    ),
    'existing',
  );
  assert.throws(
    () =>
      classifyLocalModuleState(
        PARTY_REGISTRY_MODULE_STATE_LABEL,
        {
          ...expected,
          moduleKey: INVENTORY_MODULE_ID,
          tenantModuleStateId: expected.tenantModuleStateId,
        },
        expected,
      ),
    LocalDevelopmentInitializationError,
  );
});

void test('derives only configured Party Registry through its generated owner contract', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), LOCAL_MODULES_DIRECTORY_PREFIX));
  await mkdir(path.join(root, TOPOLOGY_DIRECTORY), { recursive: true });
  await writeFile(path.join(root, TOPOLOGY_PATH), topology, 'utf-8');
  const deriveContract = async ({ vertical }: { readonly vertical: string }) =>
    moduleContract(`${vertical}.core`);
  assert.deepEqual(await deriveActivatedModuleIds(root, deriveContract), ['party-registry.core']);
});

void test('rejects duplicate module IDs derived from different verticals', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), LOCAL_MODULES_DIRECTORY_PREFIX));
  await mkdir(path.join(root, TOPOLOGY_DIRECTORY), { recursive: true });
  await writeFile(path.join(root, TOPOLOGY_PATH), topology, 'utf-8');
  const deriveContract = async () => moduleContract('duplicate.core');
  await assert.rejects(
    deriveActivatedModuleIds(root, deriveContract, ['party-registry', 'inventory']),
    LocalDevelopmentInitializationError,
  );
});

void test('generates stable module state IDs and complete access relationships', () => {
  assert.equal(
    moduleStateIdFor(PARTY_REGISTRY_MODULE_ID),
    moduleStateIdFor(PARTY_REGISTRY_MODULE_ID),
  );
  assert.notEqual(
    moduleStateIdFor(PARTY_REGISTRY_MODULE_ID),
    moduleStateIdFor(INVENTORY_MODULE_ID),
  );
  const relationships = buildLocalDevelopmentRelationships([
    PARTY_REGISTRY_MODULE_ID,
    INVENTORY_MODULE_ID,
  ]);
  assert.equal(relationships.length, 7);
  assert.equal(relationships.filter(({ relation }) => relation === 'accessor').length, 2);
  assert.equal(relationships.filter(({ relation }) => relation === 'legal_entity').length, 2);
});
