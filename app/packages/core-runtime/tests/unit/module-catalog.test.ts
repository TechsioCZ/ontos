import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInstalledModuleCatalog } from '../../src/modules/catalog.ts';
import type { OntosOutboxSubscriptionContract } from '../../src/modules/manifest.ts';

const contract = (
  appId: string,
  moduleId: string,
  modules: readonly {
    readonly activation: 'must_be_active_first' | 'optional_enhancement';
    readonly id: string;
    readonly required: boolean;
  }[] = [],
  outboxSubscriptions: readonly OntosOutboxSubscriptionContract[] = [],
) => ({
  deployment: { appId, buildMarker: `build-${appId}` },
  manifest: {
    activation: {
      defaultState: 'inactive',
      preservesHistoryWhenInactive: true,
      scope: 'tenant',
      supportedStates: ['inactive', 'active'],
    },
    dependencies: {
      core: ['core.identity', 'core.authz', 'core.modules', 'core.actions'],
      externalSystems: [],
      modules: modules.map((value) => ({ ...value, reason: 'Required by test' })),
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
    },
  },
  runtime: { outboxSubscriptions },
  schemaVersion: '0',
});

test('builds immutable deterministic dual indexes for distinct deployment and module IDs', () => {
  const catalog = buildInstalledModuleCatalog([
    {
      contract: contract('property-registry', 'property.registry'),
      expectedAppId: 'property-registry',
    },
    {
      contract: contract('documents-center', 'documents.center'),
      expectedAppId: 'documents-center',
    },
  ]);

  assert.deepEqual(catalog.deploymentAppIds, ['documents-center', 'property-registry']);
  assert.deepEqual(catalog.moduleIds, ['documents.center', 'property.registry']);
  assert.equal(
    catalog.getByDeploymentAppId('property-registry')?.manifest.module.id,
    'property.registry',
  );
  assert.equal(catalog.getByModuleId('property.registry')?.deployment.appId, 'property-registry');
  assert.equal(Object.isFrozen(catalog), true);
  assert.equal(Object.isFrozen(catalog.contracts), true);
  assert.equal(Object.isFrozen(catalog.outboxSubscriptions), true);
});

test('derives one complete deterministic Outbox subscription snapshot', () => {
  const subscription = {
    consumerModuleKey: 'property.registry',
    entrypoint: {
      access: 'background',
      entrypointKey: 'property.registry.document-projector',
      moduleKey: 'property.registry',
      role: 'worker',
      scope: 'tenant',
    },
    producerModuleKey: 'documents.center',
    topic: 'documents.center.created',
    workerKey: 'property.registry.document-projector',
  } as const;
  const catalog = buildInstalledModuleCatalog([
    {
      contract: contract('property-registry', 'property.registry', [], [subscription]),
      expectedAppId: 'property-registry',
    },
    {
      contract: contract('documents-center', 'documents.center'),
      expectedAppId: 'documents-center',
    },
  ]);
  assert.deepEqual(catalog.outboxSubscriptions, [subscription]);
});

test('rejects contradictory or incomplete Outbox subscription snapshots', () => {
  const invalidSubscription = {
    consumerModuleKey: 'other.module',
    entrypoint: {
      access: 'background',
      entrypointKey: 'property.registry.projector',
      moduleKey: 'other.module',
      role: 'worker',
      scope: 'tenant',
    },
    producerModuleKey: 'missing.producer',
    topic: 'missing.producer.created',
    workerKey: 'property.registry.projector',
  } as const;
  assert.throws(() =>
    buildInstalledModuleCatalog([
      {
        contract: contract('property-registry', 'property.registry', [], [invalidSubscription]),
        expectedAppId: 'property-registry',
      },
    ]),
  );
});

test('rejects deployment mismatch, duplicate deployment IDs, and duplicate module claims', () => {
  assert.throws(() =>
    buildInstalledModuleCatalog([
      {
        contract: contract('property-registry', 'property.registry'),
        expectedAppId: 'different-app',
      },
    ]),
  );
  assert.throws(() =>
    buildInstalledModuleCatalog([
      {
        contract: contract('property-registry', 'property.registry'),
        expectedAppId: 'property-registry',
      },
      {
        contract: contract('property-registry', 'property.other'),
        expectedAppId: 'property-registry',
      },
    ]),
  );
  assert.throws(() =>
    buildInstalledModuleCatalog([
      {
        contract: contract('property-registry', 'property.registry'),
        expectedAppId: 'property-registry',
      },
      {
        contract: contract('property-other', 'property.registry'),
        expectedAppId: 'property-other',
      },
    ]),
  );
});

test('rejects missing, self, cyclic, and unknown-version dependencies', () => {
  assert.throws(() =>
    buildInstalledModuleCatalog([
      {
        contract: contract('property-registry', 'property.registry', [
          { activation: 'must_be_active_first', id: 'documents.center', required: true },
        ]),
        expectedAppId: 'property-registry',
      },
    ]),
  );
  assert.throws(() =>
    buildInstalledModuleCatalog([
      {
        contract: contract('property-registry', 'property.registry', [
          { activation: 'must_be_active_first', id: 'property.registry', required: true },
        ]),
        expectedAppId: 'property-registry',
      },
    ]),
  );
  assert.throws(() =>
    buildInstalledModuleCatalog([
      {
        contract: contract('property-registry', 'property.registry', [
          { activation: 'must_be_active_first', id: 'documents.center', required: true },
        ]),
        expectedAppId: 'property-registry',
      },
      {
        contract: contract('documents-center', 'documents.center', [
          { activation: 'must_be_active_first', id: 'property.registry', required: true },
        ]),
        expectedAppId: 'documents-center',
      },
    ]),
  );
  assert.throws(() =>
    buildInstalledModuleCatalog([
      {
        contract: { ...contract('property-registry', 'property.registry'), schemaVersion: '1' },
        expectedAppId: 'property-registry',
      },
    ]),
  );
});
