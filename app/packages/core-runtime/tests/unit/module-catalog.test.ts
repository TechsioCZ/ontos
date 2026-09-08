import { expect, it } from '@app/effect-rstest';
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

it('builds immutable deterministic dual indexes for distinct deployment and module IDs', () => {
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

  expect(catalog.deploymentAppIds).toEqual(['documents-center', 'property-registry']);
  expect(catalog.moduleIds).toEqual(['documents.center', 'property.registry']);
  expect(catalog.getByDeploymentAppId('property-registry')?.manifest.module.id).toBe(
    'property.registry',
  );
  expect(catalog.getByModuleId('property.registry')?.deployment.appId).toBe('property-registry');
  expect(Object.isFrozen(catalog)).toBe(true);
  expect(Object.isFrozen(catalog.contracts)).toBe(true);
  expect(Object.isFrozen(catalog.outboxSubscriptions)).toBe(true);
});

it('accepts a valid owner-local subscription whose producer is not installed', () => {
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
  expect(catalog.outboxSubscriptions).toEqual([subscription]);
});

it('rejects contradictory or incomplete Outbox subscription snapshots', () => {
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
  expect(() =>
    buildInstalledModuleCatalog([
      {
        contract: contract('property-registry', 'property.registry', [invalidSubscription]),
        expectedAppId: 'property-registry',
      },
    ]),
  ).toThrow();
  expect(() =>
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
  ).toThrow();

  const duplicateWorkerKey = 'shared.projector';
  expect(() =>
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
  ).toThrow();
});

it('rejects deployment mismatch, duplicate deployment IDs, and duplicate module claims', () => {
  expect(() =>
    buildInstalledModuleCatalog([
      {
        contract: contract('property-registry', 'property.registry'),
        expectedAppId: 'different-app',
      },
    ]),
  ).toThrow();
  expect(() =>
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
  ).toThrow();
  expect(() =>
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
  ).toThrow();
});

it('rejects unsupported contract versions without weakening catalog safety', () => {
  expect(() =>
    buildInstalledModuleCatalog([
      {
        contract: { ...contract('property-registry', 'property.registry'), schemaVersion: '0' },
        expectedAppId: 'property-registry',
      },
    ]),
  ).toThrow();
});

it('resolves healthy, incompatible, and unreachable deployments independently', () => {
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

  expect(catalog.moduleIds).toEqual(['documents.center']);
  expect(catalog.deploymentStatuses).toEqual([
    { appId: 'disabled-center', status: 'disabled' },
    { appId: 'documents-center', moduleId: 'documents.center', status: 'available' },
    { appId: 'property-registry', reason: 'incompatible', status: 'unavailable' },
    { appId: 'reporting-center', reason: 'timeout', status: 'unavailable' },
    { appId: 'revoked-center', status: 'revoked' },
  ]);
});

it('excludes every contradictory claimant while preserving unrelated deployments', () => {
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

  expect(catalog.moduleIds).toEqual(['reporting.center']);
  expect(catalog.deploymentStatuses).toEqual([
    { appId: 'documents-center', reason: 'incompatible', status: 'unavailable' },
    { appId: 'property-registry', reason: 'incompatible', status: 'unavailable' },
    { appId: 'reporting-center', moduleId: 'reporting.center', status: 'available' },
  ]);
});

it('rejects duplicate deployment identities from tolerant candidate promotion', () => {
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

  expect(catalog.moduleIds).toEqual(['documents.center']);
  expect(catalog.deploymentStatuses).toEqual([
    { appId: 'documents-center', moduleId: 'documents.center', status: 'available' },
    { appId: 'property-registry', reason: 'incompatible', status: 'unavailable' },
  ]);
});

it('keeps authoritative revocation ahead of a stale fetched candidate', () => {
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

  expect(catalog.moduleIds).toEqual(['documents.center']);
  expect(catalog.deploymentStatuses).toEqual([
    { appId: 'documents-center', moduleId: 'documents.center', status: 'available' },
    { appId: 'property-registry', status: 'revoked' },
  ]);
});
