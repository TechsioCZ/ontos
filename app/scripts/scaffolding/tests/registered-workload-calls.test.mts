import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, Exit } from 'effect';
import { expect, it } from 'effect-rstest';

const { assertRegisteredWorkloadCallsReceived } = await import(
  /* webpackIgnore: true */
  '../../check-ontos-module-contracts.mts'
);
const { deriveOntosModuleDeploymentContract, registeredWorkloadCallTopologyIssue } = await import(
  /* webpackIgnore: true */
  '../../generate-ontos-module-contract.mts'
);

const workspaceRoot = path.resolve(import.meta.dirname, '../../..');
/** The calling modules (demo divergence exception 8) and the number of calls each declares. */
const callers = {
  assortment: 4,
  'commerce-customer-context': 14,
  'party-registry': 4,
  pricing: 2,
  privacy: 9,
  'symmy-integration': 49,
} as const;
const receivers = ['catalog', 'commerce-market-catalog', 'inventory', 'price-group-catalog', 'storefront-registry'];
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
        [...Object.keys(callers), ...receivers],
        (vertical) => deriveOntosModuleDeploymentContract({ vertical, workspaceRoot }),
        { concurrency: 2 },
      ).pipe(Effect.provide(NodeServices.layer));
      for (const [appId, count] of Object.entries(callers)) {
        const contract = contracts.find((candidate) => candidate.deployment.appId === appId);
        expect(contract?.manifest.registeredWorkloadCalls).toHaveLength(count);
      }
      for (const appId of receivers) {
        const contract = contracts.find((candidate) => candidate.deployment.appId === appId);
        expect(contract?.manifest.registeredWorkloadCalls).toBeUndefined();
      }
      expect(yield* refusal(contracts)).toBe('accepted');

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
