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
import type {
  SymmyEnrollmentRouteKey,
  SymmyRouteAdmissionRead,
  SymmyRouteInventoryOperation,
} from '../../src/ops/symmy-route-enrollment.ts';

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
 * The binding plan of a route of this kind, of a company unless named otherwise, that enrolls the operations `enrolls`
 * picks besides the ones every enrollment of it enrolls; with none picked, any enrollment of the route reaches its calls
 * and reads.
 */
const requiredOnlyPlan = (
  routeKey: SymmyEnrollmentRouteKey,
  contracts: readonly SymmyRouteContract[],
  companyScoped = true,
  enrolls: (operation: SymmyRouteInventoryOperation) => boolean = () => false,
) => {
  const found = symmyRouteInventoryOf(routeKey);
  if (Option.isNone(found)) {
    throw new Error(`expected the ${routeKey} inventory`);
  }
  const inventory = found.value;
  return deriveSymmyRouteBindings({
    companyScoped,
    contracts,
    enrolled: inventory.operations.filter((operation) => operation.required || enrolls(operation)),
    inventory,
  });
};
/** The refusals of that route: any such enrollment of it is refused for each of them. */
const requiredOnly = (
  routeKey: SymmyEnrollmentRouteKey,
  contracts: readonly SymmyRouteContract[],
  enrolls?: (operation: SymmyRouteInventoryOperation) => boolean,
) => requiredOnlyPlan(routeKey, contracts, true, enrolls).refusals.map(({ code, detail }) => `${code}: ${detail}`);
/** The customers route operations of one entrypoint each. */
const enrolling =
  (...entrypointKeys: readonly string[]) =>
  ({ entrypointKey }: SymmyRouteInventoryOperation) =>
    entrypointKeys.includes(entrypointKey);
/** The organization plan: Party create, Counterparty onboarding and the purchasing profile. */
const organizationPlan = [
  'party.registry.counterparty-customer-onboard',
  'commerce.customer-context.create-counterparty-purchasing-profile',
];

it.effect(
  "enrolls the customers route with its organization plan, company ICO and contacts and the membership route on main's contracts, refuses an address whose Party read Customer Context registers no call to, and enrolls the customer groups route with its definition read and the stock route without a company",
  () =>
    Effect.gen(function* enrolledOnMain() {
      const contracts = yield* mainContracts;
      expect(requiredOnly('customersBatch', contracts)).toEqual([]);
      // Every owner of the organization plan registers each call its requirements name, live and on recovery.
      expect(requiredOnly('customersBatch', contracts, enrolling(...organizationPlan))).toEqual([]);
      expect(
        requiredOnly(
          'customersBatch',
          contracts,
          enrolling(
            ...organizationPlan,
            'commerce.customer-context.change-organization-customer-profile-ico',
            'party.registry.add-contact-point',
          ),
        ),
      ).toEqual([]);
      // Party publishes its contact point read for the buyer Customer Context relays, under no workload a
      // registered call could name, so an address step stays refused.
      expect(
        requiredOnly(
          'customersBatch',
          contracts,
          enrolling(...organizationPlan, 'commerce.customer-context.add-saved-address'),
        ),
      ).toEqual([
        'call_not_declared: The installed commerce.customer-context requires party.registry party.registry.api.party-contact-point-detail@1 for commerce.customer-context.add-saved-address@1 (requirement commerce.customer-context.requirement.add-saved-address-party) and registers no call to it under commerce.customer-context.source-write',
      ]);
      expect(requiredOnly('customerGroupCustomersBatch', contracts)).toEqual([]);
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
      // The stock route admits through Symmy's synchronous admission, imports through Inventory and recovers through
      // its receipt read, all without a company; Inventory publishes the import for none, so no binding of either
      // identity needs a company registration.
      const stock = requiredOnlyPlan('inventoryStockBatch', contracts, false);
      expect(stock.refusals).toEqual([]);
      expect(stock.moduleKeys).toEqual(['commerce.inventory', 'integration.symmy']);
      expect(stock.bindings).toEqual([
        {
          companyScoped: false,
          identity: 'integration',
          purpose: 'route context',
          workloads: ['integration.symmy-admit', 'integration.symmy-poll'],
        },
        {
          companyScoped: false,
          identity: 'integration',
          purpose: 'synchronous admission',
          workloads: ['integration.symmy-admit'],
        },
        {
          companyScoped: false,
          identity: 'integration',
          purpose: 'synchronous receipt',
          workloads: ['integration.symmy-admit'],
        },
        {
          companyScoped: false,
          identity: 'integration',
          purpose: 'commerce.inventory.import-source-assertion@1',
          workloads: ['commerce.inventory.source-write'],
        },
        {
          companyScoped: false,
          identity: 'executor',
          purpose: 'commerce.inventory.import-source-assertion@1',
          workloads: ['commerce.inventory.source-write'],
        },
        {
          companyScoped: false,
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
