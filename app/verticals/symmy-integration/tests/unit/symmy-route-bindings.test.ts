import type { WorkloadBindingHolder } from '@app/core-runtime/access/enforcement';
import { describe, expect, it } from 'effect-rstest';

import { symmyIntegrationRegisteredWorkloadCalls } from '../../src/registered-workload-calls.ts';
import {
  SYMMY_JOB_KEY,
  checkSymmyRouteBindings,
  deriveSymmyRouteBindings,
  symmyBindingWorkloads,
} from '../../src/ops/symmy-route-bindings.ts';
import type { SymmyRequiredBinding, SymmyRouteContract } from '../../src/ops/symmy-route-bindings.ts';
import { symmyRouteInventoryOf } from '../../src/ops/symmy-route-enrollment.ts';
import type { SymmyRouteInventory } from '../../src/ops/symmy-route-enrollment.ts';

const admit = 'integration.symmy-admit';
const poll = 'integration.symmy-poll';
const productImport = 'commerce.catalog.symmy-product-import';
const productRead = 'commerce.catalog.symmy-product-read';
const groupRead = 'pricing.price-group-catalog.source-read';
const nestedWrite = 'pricing.price-group-catalog.source-write';
const nestedRecovery = 'pricing.price-group-catalog.recovery-read';
const integrationId = '11111111-1111-4111-8111-111111111111';
const systemId = '22222222-2222-4222-8222-222222222222';
const otherSystemId = '33333333-3333-4333-8333-333333333333';

type Surface = SymmyRouteContract['manifest']['publicSurface'];
const contract = (
  appId: string,
  moduleId: string,
  surface: Partial<Surface>,
  calls: NonNullable<SymmyRouteContract['manifest']['registeredWorkloadCalls']> = [],
): SymmyRouteContract => ({
  deployment: { appId },
  manifest: {
    module: { id: moduleId },
    publicSurface: { actions: surface.actions ?? [], operationContracts: surface.operationContracts ?? [] },
    registeredWorkloadCalls: calls,
  },
});
const carrier = (entrypointKey: string, workloads: readonly string[], declarationKey = `${entrypointKey}.read`) => ({
  entrypoint: { entrypointKey },
  schemaVersion: '1',
  workloadCarrier: { declarationKey, workloads },
});
/** The receiving side of every worker call Symmy registers for one entrypoint, exactly as Symmy registers it. */
const received = (entrypointKey: string) =>
  symmyIntegrationRegisteredWorkloadCalls.filter((call) => call.entrypointKey === entrypointKey && 'workerKey' in call);
const receivingAction = (entrypointKey: string) =>
  received(entrypointKey).map((call) => ({
    accessDeclaration: { key: call.declarationKey },
    accessWorkload: { workloads: [call.workloadKey] },
    entrypoint: { entrypointKey },
    legalEntityScope: call.legalEntityScope,
    schemaVersion: call.schemaVersion,
  }));
const receivingRead = (entrypointKey: string) =>
  received(entrypointKey)
    .slice(0, 1)
    .map((call) => carrier(entrypointKey, [call.workloadKey], call.declarationKey));

const symmy = contract('symmy-integration', 'integration.symmy', {
  actions: [
    {
      accessWorkload: { workloads: [admit] },
      entrypoint: { entrypointKey: 'integration.symmy.admit-symmy-job' },
      schemaVersion: '1',
    },
  ],
  operationContracts: [
    carrier('integration.symmy.api.symmy-route-context', [admit, poll]),
    carrier('integration.symmy.api.symmy-job-status', [poll]),
  ],
});
const nestedCall = {
  audience: 'price-group-catalog',
  declarationKey: 'pricing.price-group-catalog.nested.read',
  entrypointKey: 'pricing.price-group-catalog.api.nested',
  jobKey: SYMMY_JOB_KEY,
  legalEntityScope: 'forbidden' as const,
  schemaVersion: '1',
  sourceWorkloadKey: productImport,
  workloadKey: nestedWrite,
};
const nestedRecoveryCall = {
  ...nestedCall,
  allowRecoverySource: true,
  declarationKey: 'pricing.price-group-catalog.nested-recovery.read',
  entrypointKey: 'pricing.price-group-catalog.api.nested-recovery',
  sourceWorkloadKey: productRead,
  workloadKey: nestedRecovery,
};
const catalog = contract(
  'catalog',
  'commerce.catalog',
  {
    actions: receivingAction('commerce.catalog.create-product'),
    operationContracts: [
      ...receivingRead('commerce.catalog.api.catalog-source-products'),
      ...receivingRead('commerce.catalog.api.create-product-recovery'),
    ],
  },
  [nestedCall, nestedRecoveryCall],
);
const priceGroups = contract('price-group-catalog', 'pricing.price-group-catalog', {
  operationContracts: [
    carrier('pricing.price-group-catalog.api.price-group-source-associations', [groupRead]),
    carrier(nestedCall.entrypointKey, [nestedWrite], nestedCall.declarationKey),
    carrier(nestedRecoveryCall.entrypointKey, [nestedRecovery], nestedRecoveryCall.declarationKey),
  ],
});

const products = (): SymmyRouteInventory => {
  const found = symmyRouteInventoryOf('productsBatch');
  if ('code' in found || found._tag === 'None') {
    throw new Error('expected the products inventory');
  }
  return found.value;
};
const enrolledProducts = () =>
  products().operations.filter(
    ({ entrypointKey }) =>
      entrypointKey === 'commerce.catalog.create-product' ||
      entrypointKey === 'pricing.price-group-catalog.api.price-group-source-associations',
  );
const derive = (contracts: readonly SymmyRouteContract[]) =>
  deriveSymmyRouteBindings({ contracts, enrolled: enrolledProducts(), inventory: products() });
const workloadsOf = (bindings: readonly SymmyRequiredBinding[], identity: SymmyRequiredBinding['identity']) =>
  bindings.filter((binding) => binding.identity === identity).map(({ workloads }) => workloads.join(' | '));

describe('Symmy route bindings', () => {
  it('derives the integration and executor bindings of a route from the active composition', () => {
    const plan = derive([symmy, catalog, priceGroups]);
    expect(plan.refusals).toEqual([]);
    expect(plan.moduleKeys).toEqual(['commerce.catalog', 'integration.symmy', 'pricing.price-group-catalog']);
    expect(workloadsOf(plan.bindings, 'integration')).toEqual([
      `${admit} | ${poll}`,
      admit,
      poll,
      groupRead,
      productImport,
      productRead,
      nestedWrite,
    ]);
    expect(workloadsOf(plan.bindings, 'executor')).toEqual([
      productImport,
      productRead,
      nestedWrite,
      nestedRecovery,
      SYMMY_JOB_KEY,
    ]);
    expect(symmyBindingWorkloads(plan.bindings)).toContain(nestedRecovery);
  });

  it('refuses a route whose calls or reads the active composition does not publish', () => {
    const plan = derive([symmy, priceGroups]);
    expect(plan.refusals.map(({ code }) => code)).toEqual([
      'operation_not_published',
      'operation_not_published',
      'operation_not_published',
    ]);
    expect(derive([symmy, catalog]).refusals.map(({ detail }) => detail)).toEqual([
      'pricing.price-group-catalog.api.price-group-source-associations@1 is not published by pricing.price-group-catalog',
      expect.stringContaining('pricing.price-group-catalog.api.nested@1'),
      expect.stringContaining('pricing.price-group-catalog.api.nested-recovery@1'),
    ]);
  });

  it('checks every binding by name and names the executor of each workload', () => {
    const { bindings } = derive([symmy, catalog, priceGroups]);
    const both = [
      { kind: 'integration' as const, principalId: integrationId },
      { kind: 'system' as const, principalId: systemId },
    ];
    const holders = new Map(symmyBindingWorkloads(bindings).map((workload) => [workload, both] as const));
    const satisfied = checkSymmyRouteBindings({ bindings, holders, principalId: integrationId });
    expect(satisfied.refusals).toEqual([]);
    expect(satisfied.executors.get(SYMMY_JOB_KEY)).toBe(systemId);
    expect(satisfied.executors.get(nestedRecovery)).toBe(systemId);

    const missing = new Map<string, readonly WorkloadBindingHolder[]>([...holders, [productImport, []]]);
    expect(checkSymmyRouteBindings({ bindings, holders: missing, principalId: integrationId }).refusals).toEqual([
      {
        code: 'integration_binding_missing',
        detail: `The integration principal holds none of ${productImport}, needed for commerce.catalog.create-product@2`,
      },
      {
        code: 'executor_binding_missing',
        detail: `No active system principal holds ${productImport}, needed for commerce.catalog.create-product@2`,
      },
    ]);

    const shared = new Map<string, readonly WorkloadBindingHolder[]>([
      ...holders,
      [productRead, [...both, { kind: 'system', principalId: otherSystemId }]],
    ]);
    expect(
      checkSymmyRouteBindings({ bindings, holders: shared, principalId: integrationId }).refusals.map(
        ({ code }) => code,
      ),
    ).toEqual(['executor_binding_not_unique']);

    // The route context admits either Symmy workload; the admission needs its own.
    const pollOnly = new Map<string, readonly WorkloadBindingHolder[]>([
      ...holders,
      [admit, [{ kind: 'system', principalId: systemId }]],
    ]);
    expect(
      checkSymmyRouteBindings({ bindings, holders: pollOnly, principalId: integrationId }).refusals.map(
        ({ detail }) => detail,
      ),
    ).toEqual([`The integration principal holds none of ${admit}, needed for job admission`]);
  });

  it('refuses a route principal of another kind than integration', () => {
    const { bindings } = derive([symmy, catalog, priceGroups]);
    const holders = new Map(
      symmyBindingWorkloads(bindings).map(
        (workload) => [workload, [{ kind: 'service' as const, principalId: integrationId }]] as const,
      ),
    );
    expect(checkSymmyRouteBindings({ bindings, holders, principalId: integrationId }).refusals[0]).toEqual({
      code: 'integration_principal_not_integration',
      detail: 'The route principal is a service principal',
    });
  });
});
