import { LEGAL_ENTITY_SCOPES, OntosModuleDeploymentContractSchema, OntosModuleIdSchema } from '@app/core-runtime';
import { NodeServices } from '@effect/platform-node';
import { Effect, Option, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';

import type { deriveOntosModuleReadScopes } from '../../../../scripts/generate-ontos-module-contract.mts';
import { SymmyRouteContextRequestSchema } from '../../shared/apis/symmy-route-context.ts';
import { deriveSymmyRouteBindings } from '../../src/ops/symmy-route-bindings.ts';
import type { SymmyRouteContract } from '../../src/ops/symmy-route-bindings.ts';
import { symmyOperationName, symmyRouteInventoryOf } from '../../src/ops/symmy-route-enrollment.ts';
import type { SymmyEnrollmentRouteKey, SymmyRouteAdmissionRead } from '../../src/ops/symmy-route-enrollment.ts';

const appRoot = new URL('../../../../', import.meta.url).pathname;
const decodeContracts = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(OntosModuleDeploymentContractSchema)),
);
/** What `deriveOntosModuleReadScopes` prints for one vertical, as the child process writes it. */
type PublishedReadScope = Effect.Success<ReturnType<typeof deriveOntosModuleReadScopes>>[number];
const decodeReadScopes = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Array(
        Schema.Struct({
          entrypointKey: OntosModuleIdSchema,
          legalEntityScope: Schema.Literals(LEGAL_ENTITY_SCOPES),
          moduleId: OntosModuleIdSchema,
          schemaVersion: Schema.String,
        }),
      ),
    ),
  ),
);

/**
 * Runs `derivation` over every vertical of main's reference topology in its own owner-loading process, as the module
 * contract check loads the owners, and returns what `encode` makes of the results: no foreign private manifest is
 * imported here.
 */
const overMainTopology = (imports: string, derivation: string, encode: string) =>
  Effect.gen(function* ownerProcess() {
    const program = `import { Effect, FileSystem, ManagedRuntime, Schema } from 'effect';
    import { NodeServices } from '@effect/platform-node';
    ${imports}
    const runtime = ManagedRuntime.make(NodeServices.layer);
    try { const text = await runtime.runPromise(Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const topology = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
        verticals: Schema.Array(Schema.Struct({ id: Schema.String }))
      })))(yield* fs.readFileString('./topology/reference-topology.json'));
      const derived = yield* Effect.forEach(topology.verticals, ({ id }) => ${derivation}({ vertical: id }), { concurrency: 1 });
      return ${encode};
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
    return [...output].join('');
  });

/** The contract of every vertical of main's reference topology, derived by the module contract generator. */
const mainContracts = overMainTopology(
  `import { OntosModuleDeploymentContractSchema } from '@app/core-runtime';
    import { deriveOntosModuleDeploymentContract } from './scripts/generate-ontos-module-contract.mts';`,
  'deriveOntosModuleDeploymentContract',
  'yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(OntosModuleDeploymentContractSchema)))(derived)',
).pipe(Effect.flatMap(decodeContracts));

/**
 * The scope every public Read of main's reference topology is published under: the `legalEntityScope` of the read
 * registration each owner manifest binds as a public operation contract (`deriveOntosModuleReadScopes`), as the
 * owner's read descriptor states it. The deployment contracts carry no scope of a read.
 */
const mainReadScopes = overMainTopology(
  "import { deriveOntosModuleReadScopes } from './scripts/generate-ontos-module-contract.mts';",
  'deriveOntosModuleReadScopes',
  'JSON.stringify(derived)',
).pipe(
  Effect.flatMap(decodeReadScopes),
  Effect.map((scopes): readonly PublishedReadScope[] => scopes.flat()),
);

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
      // Commerce publishes it `required`: the Shell signs it into the route's company, which the binding must be
      // registered for.
      expect(groups.bindings).toContainEqual({
        companyScoped: true,
        identity: 'integration',
        purpose: 'commerce.customer-context.api.customer-group-definition-source@1',
        workloads: ['commerce.customer-context.source-read'],
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  60_000,
);

/** One read the integration principal makes, where the inventory states it, with the scope it states. */
interface StatedRead {
  readonly kind: 'admission' | 'executor' | 'shell';
  readonly read: SymmyRouteAdmissionRead;
  readonly routeKey: SymmyEnrollmentRouteKey;
}
/**
 * Every read the integration principal makes for any route kind, as its inventory states it: the Shell reads of the
 * route's dispatch, the admission reads, and the reads the Shell makes before it admits an executor operation.
 */
const statedReads = (): readonly StatedRead[] =>
  SymmyRouteContextRequestSchema.fields.routeKey.literals.flatMap((routeKey) => {
    const found = symmyRouteInventoryOf(routeKey);
    if (!Option.isOption(found) || Option.isNone(found)) {
      return [];
    }
    const { admissionReads = [], operations } = found.value;
    return [
      ...operations.flatMap((operation) =>
        operation.caller === 'integration' ? [{ kind: 'shell' as const, read: operation, routeKey }] : [],
      ),
      ...admissionReads.map((read) => ({ kind: 'admission' as const, read, routeKey })),
      ...operations.flatMap((operation) =>
        operation.caller === 'executor'
          ? (operation.integrationReads ?? []).map((read) => ({ kind: 'executor' as const, read, routeKey }))
          : [],
      ),
    ];
  });
/** Each stated read whose owner publishes it under another scope, or not at all, named with its route. */
const scopeDrift = (reads: readonly StatedRead[], published: readonly PublishedReadScope[]) =>
  reads.flatMap(({ kind, read, routeKey }) => {
    const owned = published.find(
      (candidate) =>
        candidate.moduleId === read.moduleId &&
        candidate.entrypointKey === read.entrypointKey &&
        candidate.schemaVersion === read.schemaVersion,
    );
    const name = `${routeKey} ${kind} read ${read.moduleId} ${symmyOperationName(read)}`;
    if (owned === undefined) {
      return [`${name} is published by no Read of ${read.moduleId}`];
    }
    return owned.legalEntityScope === read.legalEntityScope
      ? []
      : [`${name} states ${read.legalEntityScope}, and its owner publishes it ${owned.legalEntityScope}`];
  });

it.effect(
  "states every read the integration principal makes with the scope its owner's read descriptor publishes on main",
  () =>
    Effect.gen(function* scopesOnMain() {
      const published = yield* mainReadScopes;
      const reads = statedReads();
      // Every kind of read is compared, so a read kind the walk stops reaching fails here.
      expect(new Set(reads.map(({ kind }) => kind))).toEqual(new Set(['admission', 'executor', 'shell']));
      expect(scopeDrift(reads, published)).toEqual([]);
      // The comparison names a read whose stated scope its owner does not publish, and one no owner Read publishes.
      const [first] = reads;
      if (first === undefined) {
        throw new Error('expected a stated read');
      }
      const restated = first.read.legalEntityScope === 'forbidden' ? 'required' : 'forbidden';
      const owner = published.find(
        ({ entrypointKey, moduleId }) => moduleId === first.read.moduleId && entrypointKey === first.read.entrypointKey,
      );
      const name = `${first.routeKey} ${first.kind} read ${first.read.moduleId} ${symmyOperationName(first.read)}`;
      expect(scopeDrift([{ ...first, read: { ...first.read, legalEntityScope: restated } }], published)).toEqual([
        `${name} states ${restated}, and its owner publishes it ${owner?.legalEntityScope ?? 'nothing'}`,
      ]);
      expect(scopeDrift([{ ...first, read: { ...first.read, schemaVersion: '0' } }], published)).toEqual([
        `${first.routeKey} ${first.kind} read ${first.read.moduleId} ${first.read.entrypointKey}@0 is published by no Read of ${first.read.moduleId}`,
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  60_000,
);
