import { OntosModuleDeploymentContractSchema } from '@app/core-runtime';
import { RequirementCallerSchema } from '@app/core-runtime/sdk';
import type { RequirementCaller } from '@app/core-runtime/sdk';
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
 * The binding plan of a company route of this kind that enrolls only the operations every enrollment of it enrolls:
 * any enrollment of the route reaches these calls and reads.
 */
const requiredOnlyPlan = (routeKey: SymmyEnrollmentRouteKey, contracts: readonly SymmyRouteContract[]) => {
  const found = symmyRouteInventoryOf(routeKey);
  if (!Option.isOption(found) || Option.isNone(found)) {
    throw new Error(`expected the ${routeKey} inventory`);
  }
  const inventory = found.value;
  return deriveSymmyRouteBindings({
    companyScoped: true,
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
const partyReceiptRecovery =
  'call_not_declared: The installed party.registry requires privacy.core privacy.core.api.organization-business-applicability@1 for party.registry.api.party-source-effect-receipt@1 (requirement party.registry.requirement.api.party-source-effect-receipt-organization-business-privacy) and registers no recovery call to it under party.registry.source-read';
const intakeProfileRecovery =
  'call_not_declared: The installed privacy.core requires commerce.customer-context commerce.customer-context.api.customer-profile-organization-ico-facts@1 for privacy.core.api.source-processing-eligibility@1 (requirement privacy.core.requirement.customer-intake-organization-profile) and registers no recovery call to it under privacy.core.source-processing-check';

it.effect(
  "refuses the customers and membership routes on main's contracts by each requirement whose owner registers no call, and enrolls the customer groups route with its definition read",
  () =>
    Effect.gen(function* refusedOnMain() {
      const contracts = yield* mainContracts;
      expect(requiredOnly('customersBatch', contracts)).toEqual([
        intakeParty,
        intakeProfile,
        partyReceiptRecovery,
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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  60_000,
);

/** Main's contracts with these callers declared on the named requirements, and nothing else changed. */
const declaringCallers = (
  contracts: readonly SymmyRouteContract[],
  callers: Readonly<Record<string, readonly RequirementCaller[]>>,
): SymmyRouteContract[] =>
  contracts.map((contract) => {
    const { requirements } = contract.manifest;
    return requirements === undefined
      ? contract
      : {
          ...contract,
          manifest: {
            ...contract.manifest,
            requirements: {
              ...requirements,
              operations: requirements.operations.map((requirement) => {
                const declared = callers[requirement.key];
                return declared === undefined ? requirement : { ...requirement, callers: declared };
              }),
            },
          },
        };
  });

it.effect(
  "stops asking main's routes for a registered call to a requirement that declares only a person, and asks for a live-only one live",
  () =>
    Effect.gen(function* declaredOnMain() {
      const callersOf = Schema.decodeUnknownSync(Schema.Array(RequirementCallerSchema));
      const person = callersOf([{ kind: 'person', legalEntityScope: 'subject' }]);
      const liveOnly = callersOf([
        {
          declarationKey: 'integration.symmy.symmy-source-organization-facts.read',
          kind: 'registered',
          legalEntityScope: 'subject',
          liveOnly: true,
          pinPrincipal: false,
        },
      ]);
      const contracts = declaringCallers(yield* mainContracts, {
        'privacy.core.requirement.customer-intake-organization-party': person,
        'privacy.core.requirement.customer-intake-organization-profile': person,
        'privacy.core.requirement.organization-business-source-facts': liveOnly,
      });
      // Party's receipt recovery is a registration Party has yet to make, not a caller declaration.
      expect(requiredOnly('customersBatch', contracts)).toEqual([partyReceiptRecovery]);
      const membership = requiredOnlyPlan('customerGroupCustomersBatch', contracts);
      expect(membership.refusals).toEqual([]);
      // The live call Privacy registers is still asked for and followed.
      expect(membership.bindings).toContainEqual({
        identity: 'executor',
        purpose: 'integration.symmy.api.symmy-source-organization-facts@1',
        workloads: ['integration.symmy.source-organization-facts.read'],
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  60_000,
);
