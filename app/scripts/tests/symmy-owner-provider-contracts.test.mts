import { defineTenantModuleEntrypoint, OntosModuleDeploymentContractSchema } from '@app/core-runtime';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { symmyIntegrationManifest } from '../../verticals/symmy-integration/vertical.manifest.ts';
import { symmyIntegrationRegisteredWorkloadCalls } from '../../verticals/symmy-integration/src/registered-workload-calls.ts';
import { symmyOwnerProviderContractProof } from '../integration/support/symmy-c14-product-runtime.mts';

const catalogOperation = 'commerce.catalog.govern-variant-axes';
const inventoryOperation = 'commerce.inventory.provision-source-stock-item';
const catalogModuleId = 'commerce.catalog';
const inventoryModuleId = 'commerce.inventory';
const workerKey = 'integration.symmy.execute-symmy-job';
const providerContract = (appId: string, moduleId: string, entrypointKey: string, schemaVersion = '1') => {
  const base = makeModuleContractFixture({ appId, moduleId });
  return Schema.decodeUnknownSync(OntosModuleDeploymentContractSchema)({
    ...base,
    manifest: {
      ...base.manifest,
      publicSurface: {
        ...base.manifest.publicSurface,
        api: [{ key: `${entrypointKey}-action`, operationKeys: ['ownerAction.execute'] }],
        operationContracts: [
          {
            apiKey: `${entrypointKey}-action`,
            entrypoint: defineTenantModuleEntrypoint({
              access: 'write',
              authorization: { kind: 'protected' },
              entrypointKey,
              moduleKey: moduleId,
              role: 'action',
            }),
            operationKey: 'ownerAction.execute',
            schemaVersion,
          },
        ],
      },
    },
  });
};
const consumerContract = () => {
  const base = makeModuleContractFixture({ appId: 'symmy-integration', moduleId: 'integration.symmy' });
  return Schema.decodeUnknownSync(OntosModuleDeploymentContractSchema)({
    ...base,
    manifest: {
      ...base.manifest,
      requirements: {
        coreCapabilities: [],
        intrinsic: [],
        operations: [
          [catalogModuleId, catalogOperation],
          [inventoryModuleId, inventoryOperation],
        ].map(([moduleId, entrypointKey]) => ({
          condition: 'integration.symmy.condition.accepted-owner-effect',
          entrypointKey: workerKey,
          evidence: ['integration.symmy.evidence.current-owner-contract'],
          key: `integration.symmy.requirement.worker.${entrypointKey}`,
          provider: { entrypointKey, moduleId, schemaVersion: '1' },
        })),
        schemaVersion: '1',
      },
    },
  });
};

it('checks published deployment data with the real Core exact-version predicate', () => {
  const consumer = consumerContract();
  const catalog = providerContract('catalog', catalogModuleId, catalogOperation);
  const inventory = providerContract('inventory', inventoryModuleId, inventoryOperation);
  expect(symmyOwnerProviderContractProof([consumer, catalog, inventory])).toEqual({ checked: 2, missing: [] });
  expect(symmyOwnerProviderContractProof([consumer, catalog])).toEqual({
    checked: 2,
    missing: [inventoryOperation],
  });
  expect(
    symmyOwnerProviderContractProof([
      consumer,
      catalog,
      providerContract('inventory', inventoryModuleId, inventoryOperation, '2'),
    ]),
  ).toEqual({ checked: 2, missing: [inventoryOperation] });
});

it('does not claim a provider proof when the published consumer contract is absent', () => {
  expect(symmyOwnerProviderContractProof([providerContract('catalog', catalogModuleId, catalogOperation)])).toEqual({
    checked: 0,
    missing: [],
  });
});

it('publishes the exact conditional worker leases for source Category assignment and its recovery', () => {
  for (const entrypointKey of [
    'commerce.catalog.add-product-category-assignment',
    'commerce.catalog.api.add-product-category-assignment-recovery',
  ]) {
    const call = symmyIntegrationRegisteredWorkloadCalls.find(
      (candidate) => candidate.entrypointKey === entrypointKey && 'workerKey' in candidate,
    );
    expect(call).toMatchObject({
      audience: 'catalog',
      legalEntityScope: 'forbidden',
      schemaVersion: '1',
      workerKey,
    });
    expect(
      symmyIntegrationManifest.requirements?.operations.filter(
        ({ key }) => key === `integration.symmy.requirement.worker.${entrypointKey}`,
      ),
    ).toEqual([
      {
        condition: 'integration.symmy.condition.accepted-owner-effect',
        entrypointKey: workerKey,
        evidence: [
          'integration.symmy.evidence.pinned-owner-intent',
          'integration.symmy.evidence.current-owner-contract',
        ],
        key: `integration.symmy.requirement.worker.${entrypointKey}`,
        provider: { entrypointKey, moduleId: catalogModuleId, schemaVersion: '1' },
      },
    ]);
  }
});
