import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildInstalledModuleCatalog,
  resolveInstalledModuleCatalog,
} from '../../src/modules/catalog.ts';
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

void test('resolves healthy, incompatible, and unreachable deployments independently', () => {
  const catalog = resolveInstalledModuleCatalog([
    {
      contract: contract('documents-center', 'documents.center'),
      expectedAppId: 'documents-center',
      outcome: 'fetched',
    },
    {
      contract: { schemaVersion: '0' },
      expectedAppId: 'property-registry',
      outcome: 'fetched',
    },
    {
      expectedAppId: 'reporting-center',
      outcome: 'failed',
      reason: 'timeout',
    },
    { expectedAppId: 'disabled-center', outcome: 'disabled' },
    { expectedAppId: 'revoked-center', outcome: 'revoked' },
  ]);

  assert.deepEqual(catalog.moduleIds, ['documents.center']);
  assert.deepEqual(catalog.deploymentStatuses, [
    { appId: 'disabled-center', status: 'disabled' },
    { appId: 'documents-center', moduleId: 'documents.center', status: 'available' },
    { appId: 'property-registry', reason: 'incompatible', status: 'unavailable' },
    { appId: 'reporting-center', reason: 'timeout', status: 'unavailable' },
    { appId: 'revoked-center', status: 'revoked' },
  ]);
});

void test('excludes every contradictory claimant while preserving unrelated deployments', () => {
  const catalog = resolveInstalledModuleCatalog([
    {
      contract: contract('documents-center', 'shared.module'),
      expectedAppId: 'documents-center',
      outcome: 'fetched',
    },
    {
      contract: contract('property-registry', 'shared.module'),
      expectedAppId: 'property-registry',
      outcome: 'fetched',
    },
    {
      contract: contract('reporting-center', 'reporting.center'),
      expectedAppId: 'reporting-center',
      outcome: 'fetched',
    },
  ]);

  assert.deepEqual(catalog.moduleIds, ['reporting.center']);
  assert.deepEqual(catalog.deploymentStatuses, [
    { appId: 'documents-center', reason: 'incompatible', status: 'unavailable' },
    { appId: 'property-registry', reason: 'incompatible', status: 'unavailable' },
    { appId: 'reporting-center', moduleId: 'reporting.center', status: 'available' },
  ]);
});

void test('rejects duplicate deployment identities from tolerant candidate promotion', () => {
  const catalog = resolveInstalledModuleCatalog([
    {
      contract: contract('property-registry', 'property.registry'),
      expectedAppId: 'property-registry',
      outcome: 'fetched',
    },
    {
      contract: contract('property-registry', 'property.duplicate'),
      expectedAppId: 'property-registry',
      outcome: 'fetched',
    },
    {
      contract: contract('documents-center', 'documents.center'),
      expectedAppId: 'documents-center',
      outcome: 'fetched',
    },
  ]);

  assert.deepEqual(catalog.moduleIds, ['documents.center']);
  assert.deepEqual(catalog.deploymentStatuses, [
    { appId: 'documents-center', moduleId: 'documents.center', status: 'available' },
    { appId: 'property-registry', reason: 'incompatible', status: 'unavailable' },
  ]);
});

void test('keeps authoritative revocation ahead of a stale fetched candidate', () => {
  const catalog = resolveInstalledModuleCatalog([
    {
      contract: contract('property-registry', 'property.registry'),
      expectedAppId: 'property-registry',
      outcome: 'fetched',
    },
    { expectedAppId: 'property-registry', outcome: 'disabled' },
    { expectedAppId: 'property-registry', outcome: 'revoked' },
    {
      contract: contract('documents-center', 'documents.center'),
      expectedAppId: 'documents-center',
      outcome: 'fetched',
    },
  ]);

  assert.deepEqual(catalog.moduleIds, ['documents.center']);
  assert.deepEqual(catalog.deploymentStatuses, [
    { appId: 'documents-center', moduleId: 'documents.center', status: 'available' },
    { appId: 'property-registry', status: 'revoked' },
  ]);
});
