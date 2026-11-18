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
const partyRegistry = 'party-registry';
const customerContext = 'commerce-customer-context';
const partySourceEffectReceipt = 'party.registry.party-source-effect-receipt.read';
const symmyJob = 'integration.symmy.execute-symmy-job';

/**
 * The Symmy worker recovers a lost write response by one receipt read. The Shell issues that read only for exactly one
 * call naming the read and the write it recovers, so each write has one such call, also for a finished delivery; the
 * receiver publishes the write as an action and the read as none.
 */
const expectOneRecoveryPerLostWrite = (
  built: readonly Effect.Success<ReturnType<typeof deriveOntosModuleDeploymentContract>>[],
) => {
  const symmyCalls =
    built.find(({ deployment }) => deployment.appId === symmyIntegration)?.manifest.registeredWorkloadCalls ?? [];
  for (const [audience, declarationKey, write] of [
    ['catalog', 'commerce.catalog.update-product-recovery.read', 'commerce.catalog.update-product'],
    [partyRegistry, partySourceEffectReceipt, 'party.registry.create-party'],
    [partyRegistry, partySourceEffectReceipt, 'party.registry.update-party'],
    [partyRegistry, partySourceEffectReceipt, 'party.registry.counterparty-customer-onboard'],
    [
      customerContext,
      'commerce.customer-context.customer-profile-source.read',
      'commerce.customer-context.create-counterparty-purchasing-profile',
    ],
    [
      customerContext,
      'commerce.customer-context.organization-customer-profile-ico.read',
      'commerce.customer-context.change-organization-customer-profile-ico',
    ],
  ] as const) {
    const recoveries = symmyCalls.filter(
      (call) =>
        call.audience === audience &&
        call.declarationKey === declarationKey &&
        call.recoveryOf?.actionKey === write &&
        call.workerKey === symmyJob,
    );
    expect(recoveries, write).toHaveLength(1);
    expect(recoveries[0]?.allowHistoricalDeliveryRecovery, write).toBe(true);
    expect(recoveries[0]?.recoveryOf?.jobKey, write).toBe(symmyJob);
    const actions = (
      built.find(({ deployment }) => deployment.appId === audience)?.manifest.publicSurface.actions ?? []
    ).map(({ entrypoint }) => entrypoint.entrypointKey);
    expect(actions, write).toContain(write);
    expect(actions, write).not.toContain(recoveries[0]?.entrypointKey);
  }
};

it('admits each registered workload only from its reviewed callers', () => {
  expect(REVIEWED_REGISTERED_WORKLOAD_CALLERS.get(sourceWrite)).toEqual([symmyIntegration]);
  expect(
    callerRefusal([
      declaring(symmyIntegration, sourceWrite, sourceProcessingCheck),
      declaring(partyRegistry, sourceProcessingCheck),
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
      const built = yield* Effect.forEach(
        [...Object.keys(REVIEWED_REGISTERED_WORKLOAD_CALLS), ...receivers],
        (vertical) => deriveOntosModuleDeploymentContract({ vertical, workspaceRoot }),
        { concurrency: 2 },
      ).pipe(Effect.provide(NodeServices.layer));
      const contracts: readonly Contract[] = built;
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

      expectOneRecoveryPerLostWrite(built);
    }),
  { timeout: 600_000 },
);
