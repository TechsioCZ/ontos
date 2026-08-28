import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInstalledModuleCatalog } from '../../src/modules/catalog.ts';
import type { OntosOutboxSubscriptionContract } from '../../src/modules/manifest.ts';

const contract = (
  appId: string,
  moduleId: string,
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
  runtime: { outboxSubscriptions },
  schemaVersion: '2',
});

void test('builds immutable deterministic dual indexes for distinct deployment and module IDs', () => {
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

void test('accepts a valid owner-local subscription whose producer is not installed', () => {
  const subscription = {
    consumerModuleKey: 'property.registry',
    entrypoint: {
      access: 'background',
      authorization: { kind: 'owner_local_background' },
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
      contract: contract('property-registry', 'property.registry', [subscription]),
      expectedAppId: 'property-registry',
    },
  ]);
  assert.deepEqual(catalog.outboxSubscriptions, [subscription]);
});

void test('rejects contradictory or incomplete Outbox subscription snapshots', () => {
  const invalidSubscription = {
    consumerModuleKey: 'other.module',
    entrypoint: {
      access: 'background',
      authorization: { kind: 'owner_local_background' },
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
        contract: contract('property-registry', 'property.registry', [invalidSubscription]),
        expectedAppId: 'property-registry',
      },
    ]),
  );
  assert.throws(() =>
    buildInstalledModuleCatalog([
      {
        contract: contract('property-registry', 'property.registry', [
          {
            ...invalidSubscription,
            consumerModuleKey: 'property.registry',
          },
        ]),
        expectedAppId: 'property-registry',
      },
    ]),
  );

  const duplicateWorkerKey = 'shared.projector';
  assert.throws(() =>
    buildInstalledModuleCatalog([
      {
        contract: contract('property-registry', 'property.registry', [
          {
            consumerModuleKey: 'property.registry',
            entrypoint: {
              access: 'background',
              authorization: { kind: 'owner_local_background' },
              entrypointKey: duplicateWorkerKey,
              moduleKey: 'property.registry',
              role: 'worker',
              scope: 'tenant',
            },
            producerModuleKey: 'external.events',
            topic: 'external.events.created',
            workerKey: duplicateWorkerKey,
          },
        ]),
        expectedAppId: 'property-registry',
      },
      {
        contract: contract('documents-center', 'documents.center', [
          {
            consumerModuleKey: 'documents.center',
            entrypoint: {
              access: 'background',
              authorization: { kind: 'owner_local_background' },
              entrypointKey: duplicateWorkerKey,
              moduleKey: 'documents.center',
              role: 'worker',
              scope: 'tenant',
            },
            producerModuleKey: 'external.events',
            topic: 'external.events.created',
            workerKey: duplicateWorkerKey,
          },
        ]),
        expectedAppId: 'documents-center',
      },
    ]),
  );
});

void test('rejects deployment mismatch, duplicate deployment IDs, and duplicate module claims', () => {
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

void test('rejects unsupported contract versions without weakening catalog safety', () => {
  assert.throws(() =>
    buildInstalledModuleCatalog([
      {
        contract: { ...contract('property-registry', 'property.registry'), schemaVersion: '0' },
        expectedAppId: 'property-registry',
      },
    ]),
  );
});
