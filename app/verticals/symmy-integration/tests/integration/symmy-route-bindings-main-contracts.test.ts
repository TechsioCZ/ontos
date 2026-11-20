import { OntosModuleDeploymentContractSchema } from '@app/core-runtime';
import { NodeServices } from '@effect/platform-node';
import { Effect, Option, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';

import { deriveSymmyRouteBindings } from '../../src/ops/symmy-route-bindings.ts';
import type { SymmyRouteContract } from '../../src/ops/symmy-route-bindings.ts';
import { symmyRouteInventoryOf } from '../../src/ops/symmy-route-enrollment.ts';
import type { SymmyEnrollmentRouteKey } from '../../src/ops/symmy-route-enrollment.ts';

const appRoot = new URL('../../../../', import.meta.url).pathname;
const decodeContracts = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(OntosModuleDeploymentContractSchema)),
);

/**
 * The contract of every vertical of main's reference topology, derived by the module contract generator in its own
 * owner-loading process, as the module contract check derives them: no foreign private manifest is imported here.
 */
const mainContracts = Effect.gen(function* mainContracts() {
  const program = `import { Effect, FileSystem, ManagedRuntime, Schema } from 'effect';
    import { NodeServices } from '@effect/platform-node';
    import { OntosModuleDeploymentContractSchema } from '@app/core-runtime';
    import { deriveOntosModuleDeploymentContract } from './scripts/generate-ontos-module-contract.mts';
    const runtime = ManagedRuntime.make(NodeServices.layer);
    try { const text = await runtime.runPromise(Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const topology = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
        verticals: Schema.Array(Schema.Struct({ id: Schema.String }))
      })))(yield* fs.readFileString('./topology/reference-topology.json'));
      const contracts = yield* Effect.forEach(topology.verticals,
        ({ id }) => deriveOntosModuleDeploymentContract({ vertical: id }), { concurrency: 1 });
      return yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(OntosModuleDeploymentContractSchema)))(contracts);
    })); process.stdout.write(text); } finally { await runtime.dispose(); }`;
  const child = yield* ChildProcess.make(
    'mise',
    ['exec', '--', 'node', '--experimental-strip-types', '--input-type=module', '--eval', program],
    { cwd: appRoot, env: { APP_ENV_PATH: '/dev/null' }, extendEnv: true, stderr: 'pipe', stdout: 'pipe' },
  );
  const [code, output] = yield* Effect.all(
    [child.exitCode, child.stdout.pipe(Stream.decodeText(), Stream.runCollect), Stream.runDrain(child.stderr)],
    { concurrency: 3 },
  );
  expect(Number(code)).toBe(0);
  return yield* decodeContracts([...output].join(''));
});

/**
 * The binding plan of a route of this kind, of a company unless named otherwise, that enrolls only the operations every
 * enrollment of it enrolls: any enrollment of the route reaches these calls and reads.
 */
const requiredOnlyPlan = (
  routeKey: SymmyEnrollmentRouteKey,
  contracts: readonly SymmyRouteContract[],
  companyScoped = true,
) => {
  const found = symmyRouteInventoryOf(routeKey);
  if (Option.isNone(found)) {
    throw new Error(`expected the ${routeKey} inventory`);
  }
  const inventory = found.value;
  return deriveSymmyRouteBindings({
    companyScoped,
    contracts,
    enrolled: inventory.operations.filter(({ required }) => required),
    inventory,
  });
};
/** The refusals of that route: any enrollment of it is refused for each of them. */
const requiredOnly = (routeKey: SymmyEnrollmentRouteKey, contracts: readonly SymmyRouteContract[]) =>
  requiredOnlyPlan(routeKey, contracts).refusals.map(({ code, detail }) => `${code}: ${detail}`);

/** The Privacy intake check reached by both routes, whose two organization requirements Privacy registers no call for. */
const intakeParty =
  'call_not_declared: The installed privacy.core requires party.registry party.registry.api.organization-record-facts@1 for privacy.core.api.source-processing-eligibility@1 (requirement privacy.core.requirement.customer-intake-organization-party) and registers no call to it under privacy.core.source-processing-check';
const intakeProfile =
  'call_not_declared: The installed privacy.core requires commerce.customer-context commerce.customer-context.api.customer-profile-organization-ico-facts@1 for privacy.core.api.source-processing-eligibility@1 (requirement privacy.core.requirement.customer-intake-organization-profile) and registers no call to it under privacy.core.source-processing-check';
const intakePartyRecovery =
  'call_not_declared: The installed privacy.core requires party.registry party.registry.api.organization-record-facts@1 for privacy.core.api.source-processing-eligibility@1 (requirement privacy.core.requirement.customer-intake-organization-party) and registers no recovery call to it under privacy.core.source-processing-check';
const intakeProfileRecovery =
  'call_not_declared: The installed privacy.core requires commerce.customer-context commerce.customer-context.api.customer-profile-organization-ico-facts@1 for privacy.core.api.source-processing-eligibility@1 (requirement privacy.core.requirement.customer-intake-organization-profile) and registers no recovery call to it under privacy.core.source-processing-check';

it.effect(
  "refuses the customers and membership routes on main's contracts by each requirement whose owner registers no call, and enrolls the customer groups route with its definition read and the stock route without a company",
  () =>
    Effect.gen(function* refusedOnMain() {
      const contracts = yield* mainContracts;
      expect(requiredOnly('customersBatch', contracts)).toEqual([
        intakeParty,
        intakeProfile,
        'call_not_declared: The installed party.registry requires privacy.core privacy.core.api.organization-business-applicability@1 for party.registry.api.party-source-effect-receipt@1 (requirement party.registry.requirement.api.party-source-effect-receipt-organization-business-privacy) and registers no recovery call to it under party.registry.source-read',
        intakePartyRecovery,
        intakeProfileRecovery,
      ]);
      expect(requiredOnly('customerGroupCustomersBatch', contracts)).toEqual([
        intakeParty,
        intakeProfile,
        'call_not_declared: The installed privacy.core requires integration.symmy integration.symmy.api.symmy-source-organization-facts@1 for privacy.core.api.organization-business-applicability@1 (requirement privacy.core.requirement.organization-business-source-facts) and registers no recovery call to it under privacy.core.organization-business-check',
        intakePartyRecovery,
        intakeProfileRecovery,
      ]);
      // The Shell reads each group code's current definition with the integration principal before it admits.
      const groups = requiredOnlyPlan('customerGroupsBatch', contracts);
      expect(groups.refusals).toEqual([]);
      expect(groups.bindings).toContainEqual({
        identity: 'integration',
        purpose: 'commerce.customer-context.api.customer-group-definition-source@1',
        workloads: ['commerce.customer-context.source-read'],
      });
      // The stock route admits through Symmy's synchronous admission, imports through Inventory and recovers through
      // its receipt read, all without a company; Inventory publishes the import for none.
      const stock = requiredOnlyPlan('inventoryStockBatch', contracts, false);
      expect(stock.refusals).toEqual([]);
      expect(stock.moduleKeys).toEqual(['commerce.inventory', 'integration.symmy']);
      expect(stock.bindings).toEqual([
        {
          identity: 'integration',
          purpose: 'route context',
          workloads: ['integration.symmy-admit', 'integration.symmy-poll'],
        },
        { identity: 'integration', purpose: 'synchronous admission', workloads: ['integration.symmy-admit'] },
        { identity: 'integration', purpose: 'synchronous receipt', workloads: ['integration.symmy-admit'] },
        {
          identity: 'integration',
          purpose: 'commerce.inventory.import-source-assertion@1',
          workloads: ['commerce.inventory.source-write'],
        },
        {
          identity: 'executor',
          purpose: 'commerce.inventory.import-source-assertion@1',
          workloads: ['commerce.inventory.source-write'],
        },
        {
          identity: 'executor',
          purpose: 'commerce.inventory.api.inventory-source-import-receipt@1',
          workloads: ['commerce.inventory.source-read'],
        },
      ]);
      expect(requiredOnly('inventoryStockBatch', contracts)).toEqual([
        'company_scope_forbidden: commerce.inventory.import-source-assertion@1 is published without a company, which the synchronous admission of this route passes to it',
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  60_000,
);
