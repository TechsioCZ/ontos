import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { Effect, Redacted } from 'effect';
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
  assert.ok(Redacted.isRedacted(configuration.authSecret));
  assert.equal(Redacted.value(configuration.authSecret), localEnvironment.BETTER_AUTH_SECRET);
  assert.ok(Redacted.isRedacted(configuration.password));
  assert.equal(Redacted.value(configuration.password), LOCAL_DEVELOPMENT_CONTEXT.password);
  assert.doesNotMatch(
    JSON.stringify(configuration),
    /a-local-secret-with-at-least-32-characters|password1234/u,
  );
  assert.doesNotMatch(
    inspect(configuration),
    /a-local-secret-with-at-least-32-characters|password1234/u,
  );
  assert.ok(Redacted.isRedacted(configuration.databaseAdminUrl));
  assert.equal(Redacted.value(configuration.databaseAdminUrl), localEnvironment.DATABASE_ADMIN_URL);
  assert.ok(Redacted.isRedacted(configuration.spiceDbPreSharedKey));
  assert.equal(
    Redacted.value(configuration.spiceDbPreSharedKey),
    localEnvironment.SPICEDB_PRESHARED_KEY,
  );
  assert.doesNotMatch(JSON.stringify(configuration), /local-spicedb-key/u);

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
    moduleKey: 'contacts.core',
    state: 'active',
    tenantId: LOCAL_DEVELOPMENT_CONTEXT.tenantId,
    tenantModuleStateId: moduleStateIdFor('contacts.core'),
  } as const;
  assert.equal(classifyLocalModuleState('Contacts module state', undefined, expected), 'create');
  assert.equal(
    classifyLocalModuleState(
      'Contacts module state',
      { ...expected, tenantModuleStateId: '7f000000-0000-4000-8000-000000000001' },
      expected,
    ),
    'existing',
  );
  assert.throws(
    () =>
      classifyLocalModuleState(
        'Contacts module state',
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

test('derives only configured Contacts through its generated owner contract', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ontos-local-modules-'));
  await mkdir(path.join(root, 'topology'), { recursive: true });
  await writeFile(
    path.join(root, 'topology/reference-topology.json'),
    JSON.stringify({ verticals: [{ id: 'contacts' }, { id: 'inventory' }] }),
    'utf-8',
  );
  const deriveContract = (async ({ vertical }: { readonly vertical: string }) => ({
    manifest: { module: { id: `${vertical}.core` } },
  })) as unknown as typeof deriveOntosModuleDeploymentContract;
  assert.deepEqual(await deriveActivatedModuleIds(root, deriveContract), ['contacts.core']);
});

test('rejects duplicate module IDs derived from different verticals', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ontos-local-modules-'));
  await mkdir(path.join(root, 'topology'), { recursive: true });
  await writeFile(
    path.join(root, 'topology/reference-topology.json'),
    JSON.stringify({ verticals: [{ id: 'contacts' }, { id: 'inventory' }] }),
    'utf-8',
  );
  const deriveContract = (async () => ({
    manifest: { module: { id: 'duplicate.core' } },
  })) as unknown as typeof deriveOntosModuleDeploymentContract;
  await assert.rejects(
    deriveActivatedModuleIds(root, deriveContract, ['contacts', 'inventory']),
    LocalDevelopmentInitializationError,
  );
});

test('generates stable module state IDs and complete access relationships', () => {
  assert.equal(moduleStateIdFor('contacts.core'), moduleStateIdFor('contacts.core'));
  assert.notEqual(moduleStateIdFor('contacts.core'), moduleStateIdFor('inventory.core'));
  const relationships = buildLocalDevelopmentRelationships(['contacts.core', 'inventory.core']);
  assert.equal(relationships.length, 7);
  assert.equal(relationships.filter(({ relation }) => relation === 'accessor').length, 2);
  assert.equal(relationships.filter(({ relation }) => relation === 'legal_entity').length, 2);
});
