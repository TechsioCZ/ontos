import { OntosModuleDeploymentContractSchema } from '@app/core-runtime';
import { NodeServices } from '@effect/platform-node';
import { Effect, Option, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';

import { deriveSymmyRouteBindings } from '../../src/ops/symmy-route-bindings.ts';
import type { SymmyRouteContract } from '../../src/ops/symmy-route-bindings.ts';
import { symmyRouteInventoryOf } from '../../src/ops/symmy-route-enrollment.ts';
import type { SymmyEnrollmentRouteKey, SymmyRouteInventoryOperation } from '../../src/ops/symmy-route-enrollment.ts';

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
 * The binding plan of a company route of this kind that enrolls the operations `enrolls` picks besides the ones every
 * enrollment of it enrolls; with none picked, any enrollment of the route reaches these calls and reads.
 */
const requiredOnlyPlan = (
  routeKey: SymmyEnrollmentRouteKey,
  contracts: readonly SymmyRouteContract[],
  enrolls: (operation: SymmyRouteInventoryOperation) => boolean = () => false,
) => {
  const found = symmyRouteInventoryOf(routeKey);
  if (!Option.isOption(found) || Option.isNone(found)) {
    throw new Error(`expected the ${routeKey} inventory`);
  }
  const inventory = found.value;
  return deriveSymmyRouteBindings({
    companyScoped: true,
    contracts,
    enrolled: inventory.operations.filter((operation) => operation.required || enrolls(operation)),
    inventory,
  });
};
/** The refusals of that route, live and on recovery: any such enrollment of it is refused for each of them. */
const requiredOnly = (
  routeKey: SymmyEnrollmentRouteKey,
  contracts: readonly SymmyRouteContract[],
  enrolls?: (operation: SymmyRouteInventoryOperation) => boolean,
) => requiredOnlyPlan(routeKey, contracts, enrolls).refusals.map(({ code, detail }) => `${code}: ${detail}`);
/** The customers route operations of these entrypoints. */
const enrolling =
  (...entrypointKeys: readonly string[]) =>
  ({ entrypointKey }: SymmyRouteInventoryOperation) =>
    entrypointKeys.includes(entrypointKey);
/** A PERSON customer: the Party create and the Retail profile. */
const personPlan = ['party.registry.create-party', 'commerce.customer-context.ensure-retail-customer-profile'];
/** An ORGANIZATION customer: the Party create, the Counterparty onboarding and the purchasing profile. */
const organizationPlan = [
  'party.registry.create-party',
  'party.registry.counterparty-customer-onboard',
  'commerce.customer-context.create-counterparty-purchasing-profile',
];
const contact = 'party.registry.add-contact-point';
const address = 'commerce.customer-context.add-saved-address';
const companyIco = 'commerce.customer-context.change-organization-customer-profile-ico';

it.effect(
  "enrolls the customers route for a PERSON and an ORGANIZATION with contacts, addresses and the company ICO, and the membership route, on main's contracts, and the customer groups route with its definition read",
  () =>
    Effect.gen(function* enrolledOnMain() {
      const contracts = yield* mainContracts;
      expect(requiredOnly('customersBatch', contracts)).toEqual([]);
      // Every owner a customer plan reaches registers each call its requirements name, live and on recovery.
      expect(requiredOnly('customersBatch', contracts, enrolling(...personPlan))).toEqual([]);
      expect(requiredOnly('customersBatch', contracts, enrolling(...personPlan, contact, address))).toEqual([]);
      expect(requiredOnly('customersBatch', contracts, enrolling(...organizationPlan))).toEqual([]);
      expect(
        requiredOnly('customersBatch', contracts, enrolling(...organizationPlan, companyIco, contact, address)),
      ).toEqual([]);
      expect(requiredOnly('customerGroupCustomersBatch', contracts)).toEqual([]);
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
