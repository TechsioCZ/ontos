import { expect, it } from 'effect-rstest';

import {
  buildInstalledModuleCatalog,
  resolveInstalledModuleCatalog,
} from '../../src/modules/catalog.ts';
import type { OntosOutboxSubscriptionContract } from '../../src/modules/manifest.ts';
import { validateOutboxWorkerSubscriptions } from '../../src/outbox/definition.ts';
import { makeModuleContractFixture } from '../../src/testing/module-contract.ts';

const contract = (
  appId: string,
  moduleId: string,
  outboxSubscriptions: readonly OntosOutboxSubscriptionContract[] = []
) =>
  makeModuleContractFixture({
    appId,
    buildMarker: `build-${appId}`,
    moduleId,
    outboxSubscriptions,
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

  expect(catalog.deploymentAppIds).toEqual([
    'documents-center',
    'property-registry',
  ]);
  expect(catalog.moduleIds).toEqual(['documents.center', 'property.registry']);
  expect(
    catalog.getByDeploymentAppId('property-registry')?.manifest.module.id
  ).toBe('property.registry');
  expect(catalog.getByModuleId('property.registry')?.deployment.appId).toBe(
    'property-registry'
  );
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
      contract: contract('property-registry', 'property.registry', [
        subscription,
      ]),
      expectedAppId: 'property-registry',
    },
  ]);
  expect(catalog.outboxSubscriptions).toEqual([subscription]);
  expect(() =>
    validateOutboxWorkerSubscriptions(catalog.outboxSubscriptions)
  ).not.toThrow();
  expect(Object.isFrozen(catalog.outboxSubscriptions[0]?.entrypoint)).toBe(
    true
  );
  expect(Object.isFrozen(subscription.entrypoint)).toBe(false);
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
        contract: contract('property-registry', 'property.registry', [
          invalidSubscription,
        ]),
        expectedAppId: 'property-registry',
      },
    ])
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
    ])
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
    ])
  ).toThrow();
});

it('rejects deployment mismatch, duplicate deployment IDs, and duplicate module claims', () => {
  expect(() =>
    buildInstalledModuleCatalog([
      {
        contract: contract('property-registry', 'property.registry'),
        expectedAppId: 'different-app',
      },
    ])
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
    ])
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
    ])
  ).toThrow();
});

it('rejects unsupported contract versions without weakening catalog safety', () => {
  expect(() =>
    buildInstalledModuleCatalog([
      {
        contract: {
          ...contract('property-registry', 'property.registry'),
          schemaVersion: '0',
        },
        expectedAppId: 'property-registry',
      },
    ])
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
    {
      appId: 'documents-center',
      moduleId: 'documents.center',
      status: 'available',
    },
    {
      appId: 'property-registry',
      reason: 'incompatible',
      status: 'unavailable',
    },
    { appId: 'reporting-center', reason: 'timeout', status: 'unavailable' },
    { appId: 'revoked-center', status: 'revoked' },
  ]);
});

for (const scenario of [
  {
    identities: [
      ['documents-center', 'shared.module'],
      ['property-registry', 'shared.module'],
      ['reporting-center', 'reporting.center'],
    ],
    moduleIds: ['reporting.center'],
    name: 'excludes every contradictory claimant while preserving unrelated deployments',
    statuses: [
      {
        appId: 'documents-center',
        reason: 'incompatible',
        status: 'unavailable',
      },
      {
        appId: 'property-registry',
        reason: 'incompatible',
        status: 'unavailable',
      },
      {
        appId: 'reporting-center',
        moduleId: 'reporting.center',
        status: 'available',
      },
    ],
  },
  {
    identities: [
      ['property-registry', 'property.registry'],
      ['property-registry', 'property.duplicate'],
      ['documents-center', 'documents.center'],
    ],
    moduleIds: ['documents.center'],
    name: 'rejects duplicate deployment identities from tolerant candidate promotion',
    statuses: [
      {
        appId: 'documents-center',
        moduleId: 'documents.center',
        status: 'available',
      },
      {
        appId: 'property-registry',
        reason: 'incompatible',
        status: 'unavailable',
      },
    ],
  },
] as const) {
  it(scenario.name, () => {
    const catalog = resolveInstalledModuleCatalog(
      scenario.identities.map(([appId, moduleId]) => ({
        contract: contract(appId, moduleId),
        expectedAppId: appId,
        outcome: 'fetched',
      }))
    );
    expect(catalog.moduleIds).toEqual(scenario.moduleIds);
    expect(catalog.deploymentStatuses).toEqual(scenario.statuses);
  });
}

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
    {
      appId: 'documents-center',
      moduleId: 'documents.center',
      status: 'available',
    },
    { appId: 'property-registry', status: 'revoked' },
  ]);
});
