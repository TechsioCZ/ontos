import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, Exit } from 'effect';
import { expect, it } from 'effect-rstest';

const { assertRegisteredWorkloadCallers, assertRegisteredWorkloadCallsReceived, REVIEWED_REGISTERED_WORKLOAD_CALLERS } =
  await import(
    /* webpackIgnore: true */
    '../../check-ontos-module-contracts.mts'
  );
const { deriveOntosModuleDeploymentContract, registeredWorkloadCallTopologyIssue } = await import(
  /* webpackIgnore: true */
  '../../generate-ontos-module-contract.mts'
);
const { registeredWorkloadCallDrift, REVIEWED_REGISTERED_WORKLOAD_CALLS } = await import(
  /* webpackIgnore: true */
  '../registered-workload-calls.mts'
);

const workspaceRoot = path.resolve(import.meta.dirname, '../../..');
const receivers = [
  'catalog',
  'commerce-market-catalog',
  'inventory',
  'price-group-catalog',
  'storefront-registry',
  'tax',
];
type Contract = Parameters<typeof assertRegisteredWorkloadCallsReceived>[0][number];
type Call = NonNullable<Contract['manifest']['registeredWorkloadCalls']>[number];

const replacingPricingCalls = (contracts: readonly Contract[], calls: readonly Call[]) =>
  contracts.map((contract) =>
    contract.deployment.appId === 'pricing'
      ? { ...contract, manifest: { ...contract.manifest, registeredWorkloadCalls: calls } }
      : contract,
  );
const refusal = (contracts: readonly Contract[]) =>
  Effect.exit(assertRegisteredWorkloadCallsReceived(contracts)).pipe(
    Effect.map((exit) => (Exit.isFailure(exit) ? String(exit.cause) : 'accepted')),
  );

const callerRefusal = (contracts: Parameters<typeof assertRegisteredWorkloadCallers>[0]) =>
  Effect.exit(assertRegisteredWorkloadCallers(contracts)).pipe(
    Effect.map((exit) => (Exit.isFailure(exit) ? String(exit.cause) : 'accepted')),
  );
const declaring = (appId: string, ...workloadKeys: readonly string[]) => ({
  deployment: { appId },
  manifest: { registeredWorkloadCalls: workloadKeys.map((workloadKey) => ({ workloadKey })) },
});
const sourceWrite = 'commerce.customer-context.source-write';
const sourceProcessingCheck = 'privacy.core.source-processing-check';
const symmyIntegration = 'symmy-integration';

it.effect('admits each registered workload only from its reviewed callers', () =>
  Effect.gen(function* reviewedCallers() {
    expect(REVIEWED_REGISTERED_WORKLOAD_CALLERS.get(sourceWrite)).toEqual([symmyIntegration]);
    expect(
      yield* callerRefusal([
        declaring(symmyIntegration, sourceWrite, sourceProcessingCheck),
        declaring('party-registry', sourceProcessingCheck),
        declaring('catalog'),
      ]),
    ).toBe('accepted');
    // A second declarer of a one-caller workload.
    expect(yield* callerRefusal([declaring(symmyIntegration, sourceWrite), declaring('pricing', sourceWrite)])).toMatch(
      /pricing declares a call as registered workload commerce\.customer-context\.source-write, whose reviewed callers are symmy-integration/u,
    );
    // A sole declarer the table does not name.
    expect(yield* callerRefusal([declaring('privacy', sourceWrite)])).toMatch(
      /privacy declares .* whose reviewed callers are/u,
    );
    expect(yield* callerRefusal([declaring('payment', sourceProcessingCheck)])).toMatch(
      /payment declares .* whose reviewed callers are commerce-customer-context, party-registry, symmy-integration/u,
    );
    // A workload without a reviewed entry.
    expect(yield* callerRefusal([declaring(symmyIntegration, 'commerce.customer-context.source-delete')])).toMatch(
      /source-delete, which has no reviewed caller/u,
    );
  }),
);

it('reports a reviewed call a caller lost and a call nobody reviewed', () => {
  const read = {
    audience: 'catalog',
    declarationKey: 'commerce.catalog.selection-evidence.read',
    schemaVersion: '1',
    workloadKey: 'commerce.catalog.symmy-product-read',
  };
  const market = {
    audience: 'commerce-market-catalog',
    declarationKey: 'commerce.market-catalog.market-catalog.read',
    schemaVersion: '1',
    workloadKey: 'commerce.market-catalog.source-read',
  };
  expect(registeredWorkloadCallDrift('pricing', [read, market])).toEqual([]);
  expect(registeredWorkloadCallDrift('pricing', [read])).toEqual([
    { built: 0, call: `${market.workloadKey} ${market.audience} ${market.declarationKey} 1`, reviewed: 1 },
  ]);
  expect(registeredWorkloadCallDrift('pricing', [read, market, { ...read, schemaVersion: '2' }])).toEqual([
    { built: 1, call: `${read.workloadKey} ${read.audience} ${read.declarationKey} 2`, reviewed: 0 },
  ]);
  expect(registeredWorkloadCallDrift('tax', [read])).toEqual([
    { built: 1, call: `${read.workloadKey} ${read.audience} ${read.declarationKey} 1`, reviewed: 0 },
  ]);
});

it('refuses at generation a call to a deployment the topology does not have', () => {
  expect(registeredWorkloadCallTopologyIssue([{ audience: 'privacy' }], ['privacy', 'party-registry'])).toBeUndefined();
  expect(registeredWorkloadCallTopologyIssue([{ audience: 'privacy-next' }], ['privacy'])).toMatch(
    /privacy-next, which is not a topology deployment/u,
  );
});

it.live(
  'records each calling module calls in its built contract, and the workspace check refuses any undeclared call',
  () =>
    Effect.gen(function* builtCalls() {
      const contracts: readonly Contract[] = yield* Effect.forEach(
        [...Object.keys(REVIEWED_REGISTERED_WORKLOAD_CALLS), ...receivers],
        (vertical) => deriveOntosModuleDeploymentContract({ vertical, workspaceRoot }),
        { concurrency: 2 },
      ).pipe(Effect.provide(NodeServices.layer));
      for (const appId of Object.keys(REVIEWED_REGISTERED_WORKLOAD_CALLS)) {
        const calls =
          contracts.find((candidate) => candidate.deployment.appId === appId)?.manifest.registeredWorkloadCalls ?? [];
        expect(registeredWorkloadCallDrift(appId, calls)).toEqual([]);
      }
      for (const appId of receivers) {
        const contract = contracts.find((candidate) => candidate.deployment.appId === appId);
        expect(contract?.manifest.registeredWorkloadCalls).toBeUndefined();
      }
      expect(yield* refusal(contracts)).toBe('accepted');
      expect(yield* callerRefusal(contracts)).toBe('accepted');

      const first = contracts.find(({ deployment }) => deployment.appId === 'pricing')?.manifest
        .registeredWorkloadCalls?.[0];
      expect(first).toBeDefined();
      if (first === undefined) {
        return;
      }
      expect(yield* refusal(replacingPricingCalls(contracts, [{ ...first, audience: 'tagging' }]))).toMatch(
        /receiver is not installed/u,
      );
      expect(
        yield* refusal(replacingPricingCalls(contracts, [{ ...first, workloadKey: 'commerce.catalog.other-read' }])),
      ).toMatch(/does not declare/u);
      expect(
        yield* refusal(
          replacingPricingCalls(contracts, [{ ...first, declarationKey: 'commerce.catalog.selection-evidence.write' }]),
        ),
      ).toMatch(/does not declare/u);
      expect(yield* refusal(replacingPricingCalls(contracts, [{ ...first, schemaVersion: '9' }]))).toMatch(
        /no such operation version/u,
      );
    }),
  { timeout: 600_000 },
);
