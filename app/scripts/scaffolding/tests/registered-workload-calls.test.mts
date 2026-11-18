import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

const {
  registeredWorkloadCallDrift,
  registeredWorkloadCallerIssues,
  registeredWorkloadCallReceiptIssues,
  REVIEWED_REGISTERED_WORKLOAD_CALLERS,
  REVIEWED_REGISTERED_WORKLOAD_CALLS,
} = await import(
  /* webpackIgnore: true */
  '../../registered-workload-callers.mts'
);
const { deriveOntosModuleDeploymentContract, registeredWorkloadCallTopologyIssue } = await import(
  /* webpackIgnore: true */
  '../../generate-ontos-module-contract.mts'
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
const TopologySchema = Schema.fromJsonString(
  Schema.Struct({ verticals: Schema.Array(Schema.Struct({ id: Schema.String, path: Schema.String })) }),
);
type Contract = Parameters<typeof registeredWorkloadCallReceiptIssues>[0][number];
type Call = NonNullable<Contract['manifest']['registeredWorkloadCalls']>[number];

const replacingCalls = (contracts: readonly Contract[], appId: string, calls: readonly Call[]) =>
  contracts.map((contract) =>
    contract.deployment.appId === appId
      ? { ...contract, manifest: { ...contract.manifest, registeredWorkloadCalls: calls } }
      : contract,
  );
const replacingPricingCalls = (contracts: readonly Contract[], calls: readonly Call[]) =>
  replacingCalls(contracts, 'pricing', calls);
const verdict = (issues: readonly string[]) => (issues.length === 0 ? 'accepted' : issues.join('\n'));
const refusal = (contracts: readonly Contract[]) => verdict(registeredWorkloadCallReceiptIssues(contracts));
const callerRefusal = (contracts: Parameters<typeof registeredWorkloadCallerIssues>[0]) =>
  verdict(registeredWorkloadCallerIssues(contracts));
const declaring = (appId: string, ...workloadKeys: readonly string[]) => ({
  deployment: { appId },
  manifest: { registeredWorkloadCalls: workloadKeys.map((workloadKey) => ({ workloadKey })) },
});
const sourceWrite = 'commerce.customer-context.source-write';
const sourceProcessingCheck = 'privacy.core.source-processing-check';
const symmyIntegration = 'symmy-integration';

it('admits each registered workload only from its reviewed callers', () => {
  expect(REVIEWED_REGISTERED_WORKLOAD_CALLERS.get(sourceWrite)).toEqual([symmyIntegration]);
  expect(
    callerRefusal([
      declaring(symmyIntegration, sourceWrite, sourceProcessingCheck),
      declaring('party-registry', sourceProcessingCheck),
      declaring('catalog'),
    ]),
  ).toBe('accepted');
  // A second declarer of a one-caller workload.
  expect(callerRefusal([declaring(symmyIntegration, sourceWrite), declaring('pricing', sourceWrite)])).toMatch(
    /pricing declares a call as registered workload commerce\.customer-context\.source-write, whose reviewed callers are symmy-integration/u,
  );
  // A sole declarer the table does not name.
  expect(callerRefusal([declaring('privacy', sourceWrite)])).toMatch(/privacy declares .* whose reviewed callers are/u);
  expect(callerRefusal([declaring('payment', sourceProcessingCheck)])).toMatch(
    /payment declares .* whose reviewed callers are commerce-customer-context, party-registry, symmy-integration/u,
  );
  // A workload without a reviewed entry.
  expect(callerRefusal([declaring(symmyIntegration, 'commerce.customer-context.source-delete')])).toMatch(
    /source-delete, which has no reviewed caller/u,
  );
});

it.effect('reviews the calls of every topology vertical whose manifest declares registered-workload calls', () =>
  Effect.gen(function* everyDeclaringCaller() {
    const fileSystem = yield* FileSystem.FileSystem;
    const topology = yield* Schema.decodeUnknownEffect(TopologySchema)(
      yield* fileSystem.readFileString(path.join(workspaceRoot, 'topology/reference-topology.json')),
    );
    const manifests = yield* Effect.all(
      topology.verticals.map(({ id, path: verticalPath }) =>
        fileSystem
          .readFileString(path.join(workspaceRoot, verticalPath, 'vertical.manifest.ts'))
          .pipe(Effect.map((manifest) => ({ id, manifest }))),
      ),
    );
    const callers = manifests
      .filter(({ manifest }) => /^\s*registeredWorkloadCalls\b/mu.test(manifest))
      .map(({ id }) => id);
    expect(callers.toSorted()).toEqual(Object.keys(REVIEWED_REGISTERED_WORKLOAD_CALLS).toSorted());
  }).pipe(Effect.provide(NodeServices.layer)),
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
      expect(refusal(contracts)).toBe('accepted');
      expect(callerRefusal(contracts)).toBe('accepted');

      const first = contracts.find(({ deployment }) => deployment.appId === 'pricing')?.manifest
        .registeredWorkloadCalls?.[0];
      expect(first).toBeDefined();
      if (first === undefined) {
        return;
      }
      expect(refusal(replacingPricingCalls(contracts, [{ ...first, audience: 'unknown-receiver' }]))).toMatch(
        /receiver is not installed/u,
      );
      expect(
        refusal(replacingPricingCalls(contracts, [{ ...first, workloadKey: 'commerce.catalog.other-read' }])),
      ).toMatch(/does not declare/u);
      expect(
        refusal(
          replacingPricingCalls(contracts, [{ ...first, declarationKey: 'commerce.catalog.selection-evidence.write' }]),
        ),
      ).toMatch(/does not declare/u);
      expect(refusal(replacingPricingCalls(contracts, [{ ...first, schemaVersion: '9' }]))).toMatch(
        /no such operation version/u,
      );

      const symmyCalls =
        contracts.find(({ deployment }) => deployment.appId === symmyIntegration)?.manifest.registeredWorkloadCalls ??
        [];
      const createParty = symmyCalls.find(({ declarationKey }) => declarationKey === 'party.registry.party.create');
      expect(createParty?.legalEntityScope).toBe('optional');
      if (createParty === undefined) {
        return;
      }
      expect(
        refusal(
          replacingCalls(contracts, symmyIntegration, [
            ...symmyCalls.filter((call) => call !== createParty),
            { ...createParty, legalEntityScope: 'required' },
          ]),
        ),
      ).toMatch(/symmy-integration .*party\.registry\.party\.create with scope optional, not required/u);
    }),
  { timeout: 600_000 },
);
