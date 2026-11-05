import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { Cause, Context, Crypto, DateTime, Effect, Exit, Layer, Option, Ref, Result, Schema } from 'effect';
import type { Scope } from 'effect';
import { expect, it } from 'effect-rstest';

import type { AccessCatalogModule } from '../../src/authorization/access-declaration.ts';
import { AccessDecisionLive } from '../../src/access/enforcement/service.ts';
import { AccessDecisionGate } from '../../src/access/enforcement/contract.ts';
import type { GateInput } from '../../src/access/enforcement/contract.ts';
import type { AccessDecision } from '../../src/access/decision/contract.ts';
import { OwnerAuthorizationOverlay } from '../../src/access/enforcement/owner-overlay.ts';
import type { OwnerAccessFacts } from '../../src/access/enforcement/owner-overlay.ts';
import { TenantAccessBootstrap, TenantAccessBootstrapLive } from '../../src/access/bootstrap/index.ts';
import { AccessChangesStore } from '../../src/access/changes/persistence/store.ts';
import type { AccessChangesStoreService } from '../../src/access/changes/persistence/store.ts';
import { AccessChangesStoreLive } from '../../src/access/changes/persistence/drizzle-store.ts';
import { AccessCatalogSnapshotWriterLive } from '../../src/access/intent/catalog-snapshot-writer.ts';
import { AccessMembershipStoreLive } from '../../src/access/intent/memberships.ts';
import { AccessProjectionCompiler } from '../../src/access/intent/projection-compiler.ts';
import { AccessProjectionWriter, AccessProjectionWriterLive } from '../../src/access/intent/projection-writer.ts';
import type { AccessProjectionWriterService } from '../../src/access/intent/projection-writer.ts';
import { TenantIntentLoaderLive } from '../../src/access/intent/tenant-intent-loader.ts';
import { AccessWriteJournalStoreLive } from '../../src/access/lifecycle/persistence/journal-store.ts';
import { DecisionCheck } from '../../src/access/decision/engine.ts';
import { accessDecisionUnavailable } from '../../src/access/decision/errors.ts';
import {
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '../../src/access/compiler/spice-db-compiler.ts';
import { recordObjectId, scopeObjectId } from '../../src/access/compiler/object-id.ts';
import {
  AccessChangeItemIdSchema,
  AccessScopeIdSchema,
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
  CommandDigestSchema,
  GrantIncarnationIdSchema,
  LegalEntityIdSchema,
  ModuleKeySchema,
  PrincipalIdSchema,
  ProposalIdSchema,
  RecordKeySchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import type { TenantId } from '../../src/access/ids.ts';
import { ActionInvocationRefSchema, authorityWitnessSlot, execute } from '../../src/access/approvals/execution.ts';
import type { WitnessAuthorityMap, WitnessAuthorityState } from '../../src/access/approvals/execution.ts';
import { buildAccessCatalogRelease } from '../../src/access/catalog/release.ts';
import { blueprintChangeItems, changeItemIdentityKey, planChangeItems } from '../../src/access/changes/items.ts';
import { diffCatalogSnapshots } from '../../src/access/changes/catalog-diff.ts';
import { planAdoption } from '../../src/access/changes/adoption.ts';
import { previewAdoption } from '../../src/access/changes/preview.ts';
import { capabilityEffectLabel } from '../../src/access/changes/targets.ts';
import type { Proposal } from '../../src/access/model.ts';
import {
  AccessDecisionLogLive,
  AccessEnforcementPortsLive,
  AccessIntentLive,
  AccessPrincipalKindSourceLive,
  LegalEntityCandidatesLive,
} from '../../src/actions/runtime-wiring.ts';
import { ActionPermissionDenied, ActionPermissionCheckError } from '../../src/actions/errors.ts';
import { makeActionRepository } from '../../src/actions/repository.ts';
import { makeActionRuntime } from '../../src/actions/runtime.ts';
import type { ActionRuntimeService } from '../../src/actions/runtime.ts';
import { ReadPermissionDenied, ReadPermissionUnavailable } from '../../src/reads/errors.ts';
import { makeReadRuntime } from '../../src/reads/runtime.ts';
import type { ReadRuntimeService } from '../../src/reads/runtime.ts';
import type { VerticalRuntimeRegistration } from '../../src/modules/runtime-registration.ts';
import { bindLiveAccessGate } from '../../src/operations/access-gate.ts';
import type { BoundAccessGate } from '../../src/operations/access-gate.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { coreRelations } from '../../src/db/schema.ts';
import type { CoreDatabaseExecutor } from '../../src/db/types.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';
import { newSpiceDbGrpcClient } from '../../src/permissions/spicedb-grpc-rpc.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { makeTestOperationOwner } from '../support/action-runtime-options.ts';
import { openModuleEntrypointGateway } from '../support/open-module-entrypoint-gateway.ts';
import { openModuleStateGate } from '../support/open-module-state-gate.ts';
import { testOperationalScopeResolver } from '../fixtures/operational-scope.ts';
import {
  ScenarioTemplate,
  cloneDatabase,
  createTemplateDatabase,
  dropDatabase,
  replacedDatabase,
} from '../support/access-scenarios/database.ts';
import {
  insertAssignment,
  insertMembership,
  insertRoleWithCells,
  legalEntityScopeIdOf,
  scenarioOf,
  scopeOf,
  tenantScopeIdOf,
} from '../support/access-scenarios/scenario.ts';
import type { AccessScenario, RecordProjection } from '../support/access-scenarios/scenario.ts';
import {
  AMOUNT_ACTION,
  FIELD_ACTION,
  FIELD_READ,
  FIELD_READ_GROUP,
  FIELD_RECORD_READ_GROUP,
  FIELD_WRITE_GROUP,
  LEDGER_EXPORT,
  LEDGER_READ,
  OWNER_FACTS_ACTION,
  RECORD_FIELD_READ,
  ROUTINE_READ,
  SCENARIO_MODULE,
  amountActionRegistration,
  dualActionRegistration,
  dualReadRegistration,
  fieldActionRegistration,
  fieldReadRegistration,
  ledgerExportCarrier,
  ledgerModulesWithExport,
  ledgerModulesWithoutExport,
  ownerFactsActionRegistration,
  recordDetailRegistration,
  recordFieldReadCarrier,
  recordFieldReadRegistration,
  recordListRegistration,
  reductionActionRegistration,
  routineActionRegistration,
  routineReadCarrier,
  routineReadRegistration,
  scenarioModules,
  SCENARIO_WORKLOAD,
  workloadActionRegistration,
  workloadReadRegistration,
} from '../support/access-scenarios/declarations.ts';

/*
 * Authorization v2 cutover scenarios (CUTOVER-PLAN L20, S1–S9 and the runner-relevant D-rules).
 * Every scenario runs against the real Action/Read runtime, the real access gate (AccessDecisionLive
 * over AccessEnforcementPortsLive and TenantIntentLoaderLive), a database of each case's own beside the
 * integration environment's, and the environment's SpiceDB. Each claim carries its negative control.
 */

const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

const principalId = (value: string) => PrincipalIdSchema.make(value);
const scopeId = (value: string) => AccessScopeIdSchema.make(value);
const moduleKey = (value: string) => ModuleKeySchema.make(value);
const capabilityKey = (value: string) => CapabilityKeySchema.make(value);

/** The `cells_json` / `delegation_envelope_json` text one row stores, built by the model's codec. */
const jsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const owner = uid(2);
const colleague = uid(3);
const companyA = uid(5);
const companyB = uid(6);
const workloadPrincipal = uid(7);
const agentPrincipal = uid(8);
const approver = uid(9);

const ownerFactsActionKey = OWNER_FACTS_ACTION;

const transport = (key: string) => ({
  correlationId: `c20-${key}`,
  idempotencyKey: `c20-${key}`,
  targetModuleKey: SCENARIO_MODULE,
  targetResourceId: key,
  targetResourceType: 'scenario',
});

/** The tagged failure an Effect ended with, or none when it succeeded. */
const failureOf = <Value, Failure>(effect: Effect.Effect<Value, Failure>): Effect.Effect<Option.Option<Failure>> =>
  Effect.exit(effect).pipe(
    Effect.map((exit) => (Exit.isSuccess(exit) ? Option.none<Failure>() : Cause.findErrorOption(exit.cause))),
  );

const actionFailure = <Value, Failure>(effect: Effect.Effect<Value, Failure>) =>
  failureOf(effect).pipe(
    Effect.map(
      Option.filter(
        (failure) => Schema.is(ActionPermissionDenied)(failure) || Schema.is(ActionPermissionCheckError)(failure),
      ),
    ),
    Effect.map(Option.getOrUndefined),
  );

const readFailure = <Value, Failure>(effect: Effect.Effect<Value, Failure>) =>
  failureOf(effect).pipe(
    Effect.map(
      Option.filter(
        (failure) => Schema.is(ReadPermissionDenied)(failure) || Schema.is(ReadPermissionUnavailable)(failure),
      ),
    ),
    Effect.map(Option.getOrUndefined),
  );

/** A change-plan refusal logged for the operator, so a failing scenario names the code it hit. */
const logged = <Value, Failure extends { readonly code: string; readonly reason: string }>(
  effect: Effect.Effect<Value, Failure>,
): Effect.Effect<Value, Failure> =>
  effect.pipe(
    Effect.tapError((failure) => Effect.logWarning(`c20 changes refusal: ${failure.code} ${failure.reason}`)),
  );

/**
 * The instant a seeded membership starts at: before every instant this suite can read at, so a seed is a
 * live membership whether the row is stamped by the database clock or by Core's (bootstrap stamps its own
 * memberships at the instant it runs, and a reconcile reads membership liveness from Core's clock).
 */
const BOOTSTRAP_INSTANT = "'1970-01-01T00:00:00Z'::timestamptz";

const reconcile = (scenario: AccessScenario, principal: string, legalEntityId?: string) =>
  scenario.scopeFor(principal, legalEntityId).pipe(
    Effect.flatMap((scope) => scenario.writer.reconcileTenant({ scope })),
    Effect.tapError((failure) => Effect.logWarning(`c20 reconcile refused: ${failure.code} ${failure.reason}`)),
    Effect.orDie,
  );

/** The engine port a deployment gets when the engine cannot answer: UNAVAILABLE, never ALLOWED (O48). */
const unavailableCheckLayer = Layer.succeed(DecisionCheck, {
  checkBulk: () => Effect.fail(accessDecisionUnavailable('The authorization engine is unavailable')),
});

interface ComposedRuntime {
  readonly bootstrap: (typeof TenantAccessBootstrap)['Service'];
  readonly boundGate: BoundAccessGate;
  readonly changes: AccessChangesStoreService;
  readonly gate: (typeof AccessDecisionGate)['Service'];
  readonly runAction: ActionRuntimeService['runAction'];
  readonly runRead: ReadRuntimeService['runRead'];
  readonly writer: AccessProjectionWriterService;
}

/**
 * The real graph a vertical's app root composes (CUTOVER-PLAN §3.1 step 8): the seam over
 * `AccessEnforcementPortsLive` and `TenantIntentLoaderLive`, and the Action and Read runtimes wired
 * to the bound gate. `unavailable` swaps only the engine port, so the same composition answers 503.
 */
const buildRuntime = (input: {
  readonly executor: CoreDatabaseExecutor;
  readonly ownerOverlayFacts: Ref.Ref<readonly (OwnerAccessFacts | undefined)[]>;
  readonly unavailable: boolean;
}): Effect.Effect<ComposedRuntime, never, Crypto.Crypto | Scope.Scope> =>
  Effect.gen(function* buildRuntimeEffect() {
    const crypto = yield* Crypto.Crypto;
    const configuration = yield* loadSpiceDbConfig().pipe(Effect.orDie);
    const compiler = makeAccessProjectionCompiler(makeAccessProjectionTransport(configuration));
    const overlay: (typeof OwnerAuthorizationOverlay)['Service'] = {
      authorize: (_transaction, authorizationInput) =>
        Ref.update(input.ownerOverlayFacts, (facts) => [...facts, authorizationInput.ownerFacts]).pipe(
          Effect.as('allowed' as const),
        ),
    };
    const core = Layer.succeed(CoreDatabase, { executor: input.executor });
    const engine = Layer.succeed(AccessProjectionCompiler, compiler);
    const overlayLayer = Layer.succeed(OwnerAuthorizationOverlay, overlay);
    const platforms = Layer.mergeAll(core, engine, overlayLayer, NodeServices.layer);
    const intent = TenantIntentLoaderLive.pipe(Layer.provide(platforms));
    const journal = AccessWriteJournalStoreLive.pipe(Layer.provide(platforms));
    const changes = AccessChangesStoreLive.pipe(Layer.provide(platforms));
    const memberships = AccessMembershipStoreLive.pipe(Layer.provide(platforms));
    const stores = Layer.mergeAll(platforms, intent, journal, changes, memberships);
    const catalog = AccessCatalogSnapshotWriterLive.pipe(Layer.provide(stores));
    const writer = AccessProjectionWriterLive.pipe(Layer.provide(stores));
    const bootstrap = TenantAccessBootstrapLive.pipe(Layer.provide(Layer.mergeAll(stores, catalog, writer)));
    const base = Layer.mergeAll(stores, catalog, writer, bootstrap);
    const ports = input.unavailable
      ? Layer.mergeAll(
          AccessIntentLive,
          AccessDecisionLogLive,
          AccessPrincipalKindSourceLive,
          LegalEntityCandidatesLive,
          unavailableCheckLayer,
        )
      : AccessEnforcementPortsLive;
    const enforcement = AccessDecisionLive.pipe(Layer.provideMerge(ports), Layer.provide(base));
    const context = yield* Layer.build(Layer.mergeAll(base, enforcement));
    const boundGate = yield* bindLiveAccessGate.pipe(Effect.provideContext(context));
    // Every scenario entrypoint is a late-created TEST definition, so each run binds exactly its own owner.
    const actionRuntimeOf = (ownerRegistration: VerticalRuntimeRegistration) =>
      makeActionRuntime(
        { executor: input.executor },
        makeActionRepository(crypto),
        { checkActionPermission: () => Effect.succeed('allowed' as const) },
        testOperationalScopeResolver,
        {
          accessDecision: boundGate,
          lockCompositionAuthority: () => Effect.succeed([]),
          moduleEntrypointGateway: openModuleEntrypointGateway,
          moduleStateGate: openModuleStateGate,
          ownerAuthorizationOverlay: overlay,
          ownerRegistration,
          resolveCompositionRevision: () => Effect.succeed('a'.repeat(64)),
        },
      );
    const readRuntimeOf = (ownerRegistration: VerticalRuntimeRegistration) =>
      makeReadRuntime(
        { executor: input.executor },
        openModuleEntrypointGateway,
        testOperationalScopeResolver,
        {
          legalEntities: () => Effect.succeed([]),
          modules: () => Effect.succeed([]),
          resources: () => Effect.succeed([]),
          tenants: () => Effect.succeed([]),
        },
        { accessDecision: boundGate, ownerAuthorizationOverlay: overlay, ownerRegistration },
      );
    const runAction: ActionRuntimeService['runAction'] = (actionInput) =>
      actionRuntimeOf(
        makeTestOperationOwner({
          actions: [actionInput.registration],
          moduleId: actionInput.registration.descriptor.owningModuleKey,
        }).ownerRegistration,
      ).runAction(actionInput);
    const runRead: ReadRuntimeService['runRead'] = (readInput) =>
      readRuntimeOf(
        makeTestOperationOwner({
          moduleId: readInput.registration.descriptor.owningModuleKey,
          reads: [readInput.registration],
        }).ownerRegistration,
      ).runRead(readInput);
    return {
      bootstrap: Context.get(context, TenantAccessBootstrap),
      boundGate,
      changes: Context.get(context, AccessChangesStore),
      gate: Context.get(context, AccessDecisionGate),
      runAction,
      runRead,
      writer: Context.get(context, AccessProjectionWriter),
    };
  });

/** One SpiceDB relationship update of the record projection: a relation to one subject. */
const recordTouch = (record: v1.ObjectReference, relation: string, subject: v1.ObjectReference) =>
  v1.RelationshipUpdate.create({
    operation: v1.RelationshipUpdate_Operation.TOUCH,
    relationship: v1.Relationship.create({
      relation,
      resource: record,
      subject: v1.SubjectReference.create({ object: subject }),
    }),
  });

/**
 * The record projection a scenario writes directly: the owner's `assigned`/`scope` edges (O10, D32).
 * The engine names the record exactly as the compiler's projection does, so a target check can only
 * ever prove the record inside the scope the decision was resolved in (guarantee 3).
 */
const projectRecord = (client: v1.ZedClientInterface, tenantId: string, projection: RecordProjection) =>
  Effect.tryPromise(() => {
    const record = v1.ObjectReference.create({
      objectId: recordObjectId(tenantId, projection.scopeId, projection.moduleKey, projection.recordKey),
      objectType: 'access_record',
    });
    const human = v1.ObjectReference.create({
      objectId: projection.principalId,
      objectType: 'access_human',
    });
    const scope = v1.ObjectReference.create({
      objectId: scopeObjectId(tenantId, projection.scopeId),
      objectType: 'access_scope',
    });
    return client.promises.writeRelationships(
      v1.WriteRelationshipsRequest.create({
        updates: [recordTouch(record, 'assigned', human), recordTouch(record, 'scope', scope)],
      }),
    );
  }).pipe(Effect.orDie);

/**
 * The real bootstrap of one scenario tenant (O67-Q6): the suite resolves the graph, then hands the
 * tenant's own identity rows to `bootstrapTenantAccess` through the one Core writer.
 */
const bootstrapScenarioTenant = (
  runtime: ComposedRuntime,
  tenantId: TenantId,
  input: {
    readonly legalEntityIds: readonly string[];
    readonly modules: readonly AccessCatalogModule[];
    readonly principalId: string;
  },
) =>
  scopeOf({ principalId: input.principalId, tenantId }).pipe(
    Effect.flatMap((scope) =>
      runtime.bootstrap.bootstrapTenantAccess({
        legalEntityIds: input.legalEntityIds.map((value) => LegalEntityIdSchema.make(value)),
        modules: input.modules,
        scope,
      }),
    ),
    Effect.orDie,
  );

/**
 * The suite-scoped template beside the integration database: built once for the whole file, cloned by
 * every case and dropped when the suite ends.
 */
const buildScenarioTemplate = Effect.gen(function* buildScenarioTemplateEffect() {
  const connections = yield* loadDatabaseConnectionPair();
  const crypto = yield* Crypto.Crypto;
  const database = `c20_scenario_template_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
  const admin = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
  yield* admin.unsafe(`create database "${database}"`);
  yield* Effect.addFinalizer(() => dropDatabase(admin, database));
  yield* Effect.scoped(
    Effect.gen(function* migrateScenarioTemplate() {
      const template = yield* makeTestPgClient(replacedDatabase(connections.admin.connectionString, database), {
        maxConnections: 1,
      });
      yield* createTemplateDatabase(template);
    }),
  );
  return { database };
}).pipe(Effect.orDie);

const scenarioSuiteLayer = Layer.mergeAll(
  NodeServices.layer,
  Layer.effect(ScenarioTemplate, buildScenarioTemplate).pipe(Layer.provide(NodeServices.layer)),
);

/**
 * One case's own database, cloned from the suite template and dropped when the case's scope closes.
 * A driver failure is a defect: a suite that cannot reach its database server must fail loudly.
 */
const acquireScenarioDatabase = Effect.gen(function* acquireScenarioDatabaseEffect() {
  const { database: template } = yield* ScenarioTemplate;
  const connections = yield* loadDatabaseConnectionPair();
  const crypto = yield* Crypto.Crypto;
  const database = `c20_scenario_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
  const admin = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
  yield* cloneDatabase(admin, template, database);
  yield* Effect.addFinalizer(() => dropDatabase(admin, database));
  const adminClient = yield* makeTestPgClient(replacedDatabase(connections.admin.connectionString, database), {
    maxConnections: 2,
  });
  const runtimeClient = yield* makeTestPgClient(replacedDatabase(connections.runtime.connectionString, database), {
    maxConnections: 2,
  });
  return { admin: adminClient, runtime: runtimeClient } as const;
}).pipe(Effect.orDie);

const withAccessScenario = <Value, Failure>(run: (scenario: AccessScenario) => Effect.Effect<Value, Failure>) =>
  Effect.scoped(
    Effect.gen(function* accessScenario() {
      const configuration = yield* loadSpiceDbConfig().pipe(Effect.orDie);
      const { admin, runtime: runtimeClient } = yield* acquireScenarioDatabase;
      const executor = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      // The suite owns the engine's schema, so it starts from exactly the v2 definitions Core serves.
      yield* Effect.acquireUseRelease(
        Effect.sync(() => newSpiceDbGrpcClient(configuration)),
        (client) =>
          Effect.tryPromise(() =>
            client.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })),
          ).pipe(Effect.orDie),
        (client) => Effect.sync(() => client.close()),
      );
      const ownerOverlayFacts = yield* Ref.make<readonly (OwnerAccessFacts | undefined)[]>([]);
      const live = yield* buildRuntime({ executor, ownerOverlayFacts, unavailable: false });
      const dead = yield* buildRuntime({
        executor,
        ownerOverlayFacts: yield* Ref.make<readonly (OwnerAccessFacts | undefined)[]>([]),
        unavailable: true,
      });
      const client = yield* Effect.acquireRelease(
        Effect.sync(() => newSpiceDbGrpcClient(configuration)),
        (opened) => Effect.sync(() => opened.close()),
      );
      const crypto = yield* Crypto.Crypto;
      const tenantId = TenantIdSchema.make(yield* crypto.randomUUIDv4());
      return yield* run(
        scenarioOf({
          admin,
          bootstrap: (input) => bootstrapScenarioTenant(live, tenantId, input),
          changes: live.changes,
          gate: (input: GateInput): Effect.Effect<AccessDecision> => live.gate.decide(input),
          ownerOverlayFacts,
          runAction: live.runAction,
          runActionUnavailable: dead.runAction,
          runRead: live.runRead,
          runReadUnavailable: dead.runRead,
          tenantId,
          unavailableGate: dead.boundGate,
          writer: live.writer,
          writeRecordProjection: (projection) => projectRecord(client, tenantId, projection),
        }),
      );
    }),
  );

it.layer(scenarioSuiteLayer, { excludeTestServices: true })('access cutover scenarios', (suite) => {
  suite.effect('a bootstrapped owner is allowed and a member without a role is denied', () =>
    withAccessScenario((scenario) =>
      Effect.gen(function* ownerVersusMember() {
        yield* scenario.seedTenant({
          legalEntityIds: [companyA],
          moduleKeys: [SCENARIO_MODULE],
          principals: [
            { kind: 'human', principalId: owner },
            { kind: 'human', principalId: colleague },
          ],
        });
        yield* scenario.bootstrap({ legalEntityIds: [companyA], modules: scenarioModules(), principalId: owner });
        // The colleague is a member of the tenant, so the denial below is the missing assignment and never a
        // missing membership: membership is gated in intent, not left to the graph (R5a-1).
        yield* insertMembership(scenario.admin, scenario.tenantId, {
          kind: 'member',
          principalId: colleague,
          recordedBy: owner,
          scopeId: yield* tenantScopeIdOf(scenario.admin, scenario.tenantId),
          validFrom: BOOTSTRAP_INSTANT,
        });
        yield* reconcile(scenario, owner);

        const ownerPrincipal = yield* scenario.scopeFor(owner);
        yield* scenario.runAction({
          payload: { value: 'allowed' },
          principal: ownerPrincipal,
          registration: routineActionRegistration,
          transport: transport('owner-routine'),
        });

        // The negative control: a member of the tenant with no assignment holds nothing.
        const colleaguePrincipal = yield* scenario.scopeFor(colleague);
        const denied = yield* actionFailure(
          scenario.runAction({
            payload: { value: 'denied' },
            principal: colleaguePrincipal,
            registration: routineActionRegistration,
            transport: transport('colleague-routine'),
          }),
        );
        expect(Schema.is(ActionPermissionDenied)(denied)).toBe(true);
        expect(Schema.is(ActionPermissionDenied)(denied) ? denied.reasons : []).toContain('deny.insufficient_grant');

        const ownerDecision = yield* scenario.decide({
          carrier: routineReadCarrier,
          legalEntityScope: 'forbidden',
          principalId: owner,
        });
        expect(ownerDecision.outcome).toBe('ALLOWED');
        const colleagueDecision = yield* scenario.decide({
          carrier: routineReadCarrier,
          legalEntityScope: 'forbidden',
          principalId: colleague,
        });
        expect(colleagueDecision.outcome).toBe('DENIED');
      }),
    ),
  );

  suite.effect('per-company roles allow in the company they were granted in and deny in another', () =>
    withAccessScenario((scenario) =>
      Effect.gen(function* perCompanyRoles() {
        yield* scenario.seedTenant({
          legalEntityIds: [companyA, companyB],
          moduleKeys: [SCENARIO_MODULE],
          principals: [
            { kind: 'human', principalId: owner },
            { kind: 'human', principalId: colleague },
          ],
        });
        const bootstrapped = yield* scenario.bootstrap({
          legalEntityIds: [companyA, companyB],
          modules: scenarioModules(),
          principalId: owner,
        });
        const companyAScope = `00000000-0000-4000-8000-${'a'.repeat(12)}`;
        void companyAScope;
        const scopeA = yield* legalEntityScopeIdOf(scenario.admin, scenario.tenantId, companyA);
        const tenantScope = yield* tenantScopeIdOf(scenario.admin, scenario.tenantId);
        expect(scopeA.length).toBeGreaterThan(0);
        // A company decision rests on two memberships: the tenant's and the company's (O28, D6).
        yield* insertMembership(scenario.admin, scenario.tenantId, {
          kind: 'member',
          principalId: colleague,
          recordedBy: owner,
          scopeId: tenantScope,
        });
        yield* insertMembership(scenario.admin, scenario.tenantId, {
          kind: 'member',
          principalId: colleague,
          recordedBy: owner,
          scopeId: scopeA,
        });
        yield* insertAssignment(scenario.admin, scenario.tenantId, {
          assignedBy: owner,
          incarnationId: uid(40),
          principalId: colleague,
          roleId: bootstrapped.roleId,
          roleRevisionId: bootstrapped.roleRevisionId,
          scopeId: scopeA,
        });
        yield* reconcile(scenario, owner);

        // The owner administers both companies; the colleague only the one they were assigned in.
        expect(
          (yield* scenario.decide({
            carrier: routineReadCarrier,
            legalEntityId: companyA,
            legalEntityScope: 'required',
            principalId: owner,
          })).outcome,
        ).toBe('ALLOWED');
        expect(
          (yield* scenario.decide({
            carrier: routineReadCarrier,
            legalEntityId: companyB,
            legalEntityScope: 'required',
            principalId: owner,
          })).outcome,
        ).toBe('ALLOWED');
        expect(
          (yield* scenario.decide({
            carrier: routineReadCarrier,
            legalEntityId: companyA,
            legalEntityScope: 'required',
            principalId: colleague,
          })).outcome,
        ).toBe('ALLOWED');
        // The negative control: the same person in the other company holds nothing.
        expect(
          (yield* scenario.decide({
            carrier: routineReadCarrier,
            legalEntityId: companyB,
            legalEntityScope: 'required',
            principalId: colleague,
          })).outcome,
        ).toBe('DENIED');
      }),
    ),
  );

  suite.effect('an agent is refused in this wave, even when its human holds the capability', () =>
    withAccessScenario((scenario) =>
      Effect.gen(function* agentRefused() {
        yield* scenario.seedTenant({
          legalEntityIds: [companyA],
          moduleKeys: [SCENARIO_MODULE],
          principals: [
            { kind: 'human', principalId: owner },
            { kind: 'agent', principalId: agentPrincipal },
          ],
        });
        const bootstrapped = yield* scenario.bootstrap({
          legalEntityIds: [companyA],
          modules: scenarioModules(),
          principalId: owner,
        });
        const tenantScope = yield* tenantScopeIdOf(scenario.admin, scenario.tenantId);
        // The agent holds a routine capability of its own, so the refusal cannot be a missing grant:
        // it is the actor kind alone that no v2 decision admits in this wave (O46, O67-Q5).
        yield* insertRoleWithCells(scenario.admin, scenario.tenantId, {
          capabilityKeys: [ROUTINE_READ],
          catalogSnapshotId: bootstrapped.catalogSnapshotId,
          createdBy: owner,
          roleId: uid(43),
          roleRevisionId: uid(44),
          scopeId: tenantScope,
        });
        yield* insertMembership(scenario.admin, scenario.tenantId, {
          agentId: agentPrincipal,
          kind: 'member',
          recordedBy: owner,
          scopeId: tenantScope,
        });
        yield* insertAssignment(scenario.admin, scenario.tenantId, {
          agentId: agentPrincipal,
          assignedBy: owner,
          incarnationId: uid(41),
          roleId: uid(43),
          roleRevisionId: uid(44),
          scopeId: tenantScope,
        });
        yield* reconcile(scenario, owner);

        const decision = yield* scenario.decide({
          carrier: routineReadCarrier,
          legalEntityScope: 'forbidden',
          principalId: agentPrincipal,
        });
        expect(decision.outcome).toBe('DENIED');
        expect(decision.reasons.map(({ code }) => code)).toContain('deny.agent_forbidden');

        // The negative control: the human the agent would act for is still allowed.
        expect(
          (yield* scenario.decide({
            carrier: routineReadCarrier,
            legalEntityScope: 'forbidden',
            principalId: owner,
          })).outcome,
        ).toBe('ALLOWED');
      }),
    ),
  );

  suite.effect(
    'the workload gate routes by actor kind: workloads on declarations and humans on workloads are refused',
    () =>
      withAccessScenario((scenario) =>
        Effect.gen(function* workloadGate() {
          yield* scenario.seedTenant({
            legalEntityIds: [companyA],
            moduleKeys: [SCENARIO_MODULE],
            principals: [
              { kind: 'human', principalId: owner },
              { kind: 'service', principalId: workloadPrincipal },
            ],
          });
          yield* scenario.bootstrap({ legalEntityIds: [companyA], modules: scenarioModules(), principalId: owner });
          // The operator registers the workload key this principal may run (O73).
          yield* scenario.bindWorkload({ principalId: workloadPrincipal, workloadKey: SCENARIO_WORKLOAD });
          const workloadScope = yield* scenario.scopeFor(workloadPrincipal);
          const ownerScope = yield* scenario.scopeFor(owner);

          // A workload on a declaration-only Action is refused (O67-Q4, O71).
          const workloadOnDeclaration = yield* actionFailure(
            scenario.runAction({
              payload: { value: 'workload' },
              principal: workloadScope,
              registration: routineActionRegistration,
              transport: transport('workload-on-declaration'),
            }),
          );
          expect(Schema.is(ActionPermissionDenied)(workloadOnDeclaration)).toBe(true);
          expect(
            Schema.is(ActionPermissionDenied)(workloadOnDeclaration) ? workloadOnDeclaration.reasons : [],
          ).toContain('deny.workload_forbidden');

          // A workload on a workload-only Action runs through the owner's classification.
          yield* scenario.runAction({
            payload: { value: 'workload' },
            principal: workloadScope,
            registration: workloadActionRegistration,
            transport: transport('workload-only'),
          });
          // A human on the same workload-only Action is refused.
          const humanOnWorkload = yield* actionFailure(
            scenario.runAction({
              payload: { value: 'human' },
              principal: ownerScope,
              registration: workloadActionRegistration,
              transport: transport('human-on-workload'),
            }),
          );
          expect(Schema.is(ActionPermissionDenied)(humanOnWorkload)).toBe(true);
          expect(Schema.is(ActionPermissionDenied)(humanOnWorkload) ? humanOnWorkload.reasons : []).toContain(
            'deny.workload_only',
          );

          // The dual Action admits both: the workload through its path, the human through the declaration.
          yield* scenario.runAction({
            payload: { value: 'workload' },
            principal: workloadScope,
            registration: dualActionRegistration,
            transport: transport('dual-workload'),
          });
          yield* scenario.runAction({
            payload: { value: 'human' },
            principal: ownerScope,
            registration: dualActionRegistration,
            transport: transport('dual-human'),
          });

          // The same rule holds for governed reads (O72).
          yield* scenario.runRead({
            input: {},
            principal: workloadScope,
            registration: workloadReadRegistration,
            transport: transport('workload-read'),
          });
          const humanOnWorkloadRead = yield* readFailure(
            scenario.runRead({
              input: {},
              principal: ownerScope,
              registration: workloadReadRegistration,
              transport: transport('human-workload-read'),
            }),
          );
          expect(Schema.is(ReadPermissionDenied)(humanOnWorkloadRead)).toBe(true);
          yield* scenario.runRead({
            input: {},
            principal: workloadScope,
            registration: dualReadRegistration,
            transport: transport('dual-read-workload'),
          });
          yield* scenario.runRead({
            input: {},
            principal: ownerScope,
            registration: dualReadRegistration,
            transport: transport('dual-read-human'),
          });
        }),
      ),
  );

  suite.effect(
    'a workload is admitted by registered identity: an unbound key is refused and a revoked binding ends it (O73)',
    () =>
      withAccessScenario((scenario) =>
        Effect.gen(function* workloadBinding() {
          yield* scenario.seedTenant({
            legalEntityIds: [companyA],
            moduleKeys: [SCENARIO_MODULE],
            principals: [
              { kind: 'human', principalId: owner },
              { kind: 'service', principalId: workloadPrincipal },
            ],
          });
          yield* scenario.bootstrap({ legalEntityIds: [companyA], modules: scenarioModules(), principalId: owner });
          const workloadScope = yield* scenario.scopeFor(workloadPrincipal);

          // The negative control: a managed key with no binding is refused on the carrier that names
          // the workload, exactly as a person is (O73). The kind alone grants nothing.
          const unbound = yield* actionFailure(
            scenario.runAction({
              payload: { value: 'workload' },
              principal: workloadScope,
              registration: workloadActionRegistration,
              transport: transport('workload-unbound'),
            }),
          );
          expect(Schema.is(ActionPermissionDenied)(unbound)).toBe(true);
          expect(Schema.is(ActionPermissionDenied)(unbound) ? unbound.reasons : []).toContain('deny.workload_unbound');

          // A binding for another workload key still does not admit this carrier.
          yield* scenario.bindWorkload({ principalId: workloadPrincipal, workloadKey: 'test.scenarios.other' });
          const foreign = yield* actionFailure(
            scenario.runAction({
              payload: { value: 'workload' },
              principal: workloadScope,
              registration: workloadActionRegistration,
              transport: transport('workload-foreign-binding'),
            }),
          );
          expect(Schema.is(ActionPermissionDenied)(foreign) ? foreign.reasons : []).toContain('deny.workload_unbound');

          // The binding for the carrier's own key admits it, on the workload-only and the dual carrier.
          yield* scenario.bindWorkload({ principalId: workloadPrincipal, workloadKey: SCENARIO_WORKLOAD });
          yield* scenario.runAction({
            payload: { value: 'workload' },
            principal: workloadScope,
            registration: workloadActionRegistration,
            transport: transport('workload-bound'),
          });
          yield* scenario.runAction({
            payload: { value: 'workload' },
            principal: workloadScope,
            registration: dualActionRegistration,
            transport: transport('dual-workload-bound'),
          });

          // Revoking the binding ends the admission: the same request is refused again.
          yield* scenario.revokeWorkload({ principalId: workloadPrincipal, workloadKey: SCENARIO_WORKLOAD });
          const revoked = yield* actionFailure(
            scenario.runAction({
              payload: { value: 'workload' },
              principal: workloadScope,
              registration: workloadActionRegistration,
              transport: transport('workload-revoked'),
            }),
          );
          expect(Schema.is(ActionPermissionDenied)(revoked) ? revoked.reasons : []).toContain('deny.workload_unbound');
        }),
      ),
  );

  suite.effect(
    "reducing the actor's own authority runs without a grant, while the same Action without the reduction is refused",
    () =>
      withAccessScenario((scenario) =>
        Effect.gen(function* reducesAuthority() {
          yield* scenario.seedTenant({
            legalEntityIds: [companyA],
            moduleKeys: [SCENARIO_MODULE],
            principals: [
              { kind: 'human', principalId: owner },
              { kind: 'human', principalId: colleague },
            ],
          });
          yield* scenario.bootstrap({ legalEntityIds: [companyA], modules: scenarioModules(), principalId: owner });
          // The reducing actor is a member of the tenant without a grant, which is what O35 exempts (R5a-1).
          yield* insertMembership(scenario.admin, scenario.tenantId, {
            kind: 'member',
            principalId: colleague,
            recordedBy: owner,
            scopeId: yield* tenantScopeIdOf(scenario.admin, scenario.tenantId),
            validFrom: BOOTSTRAP_INSTANT,
          });
          yield* reconcile(scenario, owner);
          const colleagueScope = yield* scenario.scopeFor(colleague);
          const ownerScope = yield* scenario.scopeFor(owner);

          // O35/O71: stopping without any grant still runs; the payload only takes authority away.
          yield* scenario.runAction({
            payload: { reduce: true },
            principal: colleagueScope,
            registration: reductionActionRegistration,
            transport: transport('reduce-stop'),
          });
          // The negative control: the same Action without the reduction needs its grant.
          const denied = yield* actionFailure(
            scenario.runAction({
              payload: { reduce: false },
              principal: colleagueScope,
              registration: reductionActionRegistration,
              transport: transport('reduce-start'),
            }),
          );
          expect(Schema.is(ActionPermissionDenied)(denied)).toBe(true);
          expect(Schema.is(ActionPermissionDenied)(denied) ? denied.reasons : []).toContain('deny.insufficient_grant');
          // The granted owner runs the non-reducing payload.
          yield* scenario.runAction({
            payload: { reduce: false },
            principal: ownerScope,
            registration: reductionActionRegistration,
            transport: transport('reduce-owner'),
          });
        }),
      ),
  );

  suite.effect('owner facts reach the owner overlay unchanged (O70)', () =>
    withAccessScenario((scenario) =>
      Effect.gen(function* ownerFactsReachOverlay() {
        yield* scenario.seedTenant({
          legalEntityIds: [companyA],
          moduleKeys: [SCENARIO_MODULE],
          principals: [{ kind: 'human', principalId: owner }],
        });
        yield* scenario.bootstrap({ legalEntityIds: [companyA], modules: scenarioModules(), principalId: owner });
        const ownerScope = yield* scenario.scopeFor(owner);
        yield* scenario.runAction({
          payload: { counterpartyId: 'counterparty-42' },
          principal: ownerScope,
          registration: ownerFactsActionRegistration,
          transport: transport(ownerFactsActionKey),
        });
        const facts = yield* Ref.get(scenario.ownerOverlayFacts);
        expect(facts.at(-1)).toEqual({ counterpartyId: 'counterparty-42' });

        // The negative control: an entrypoint without a resolver hands the overlay no facts at all.
        yield* scenario.runAction({
          payload: { value: 'no-facts' },
          principal: ownerScope,
          registration: routineActionRegistration,
          transport: transport('no-owner-facts'),
        });
        const after = yield* Ref.get(scenario.ownerOverlayFacts);
        expect(after.at(-1)).toBeUndefined();
      }),
    ),
  );

  suite.effect('an amount ceiling denies a server-derived amount above it and allows one within it', () =>
    withAccessScenario((scenario) =>
      Effect.gen(function* amountCeiling() {
        yield* scenario.seedTenant({
          legalEntityIds: [companyA],
          moduleKeys: [SCENARIO_MODULE],
          principals: [{ kind: 'human', principalId: owner }],
        });
        const bootstrapped = yield* scenario.bootstrap({
          legalEntityIds: [companyA],
          modules: scenarioModules(),
          principalId: owner,
        });
        const tenantScopeRow = yield* scenario.admin
          .unsafe<{ readonly scope_id: string }>(
            `select scope_id from core.access_scopes
             where tenant_id = '${scenario.tenantId}' and tenant_context_id is not null`,
          )
          .pipe(Effect.orDie);
        const tenantScope = tenantScopeRow[0]?.scope_id ?? '';
        const state = yield* scenario.changes.loadTenantChanges(yield* scenario.scopeFor(owner)).pipe(Effect.orDie);
        const current = state.roles.find(({ role }) => role.id === bootstrapped.roleId)?.revision;
        expect(current).toBeDefined();
        const cells = (current?.cells ?? []).map((cell) =>
          cell.capabilityKey === AMOUNT_ACTION && cell.mode === 'run'
            ? { ...cell, amountCeiling: { currency: 'CZK', limitMinor: 100_000 } }
            : cell,
        );
        const revisionId = uid(50);
        yield* scenario.admin
          .unsafe(
            `insert into core.access_role_revisions
               (role_revision_id, tenant_id, role_id, revision, catalog_snapshot_id, cells_json, created_by,
                provenance, template_key)
             values ('${revisionId}', '${scenario.tenantId}', '${bootstrapped.roleId}', 2,
                     '${bootstrapped.catalogSnapshotId}', '${jsonText(cells)}'::jsonb, '${owner}',
                     'customer_changed', 'full_access')`,
          )
          .pipe(Effect.orDie);
        yield* scenario.admin
          .unsafe(
            `update core.access_assignments set role_revision_id = '${revisionId}'
             where tenant_id = '${scenario.tenantId}' and scope_id = '${tenantScope}'`,
          )
          .pipe(Effect.orDie);
        yield* reconcile(scenario, owner);

        const ownerScope = yield* scenario.scopeFor(owner);
        // Within the ceiling: allowed.
        yield* scenario.runAction({
          payload: { totalMinor: 50_000 },
          principal: ownerScope,
          registration: amountActionRegistration,
          transport: transport('amount-within'),
        });
        // Above it: denied with the amount reason.
        const denied = yield* actionFailure(
          scenario.runAction({
            payload: { totalMinor: 120_000 },
            principal: ownerScope,
            registration: amountActionRegistration,
            transport: transport('amount-above'),
          }),
        );
        expect(Schema.is(ActionPermissionDenied)(denied)).toBe(true);
        expect(Schema.is(ActionPermissionDenied)(denied) ? denied.reasons : []).toContain(
          'deny.amount_exceeds_ceiling',
        );
      }),
    ),
  );

  suite.effect('a delegated assignment is bounded by its envelope ceiling (D10b)', () =>
    withAccessScenario((scenario) =>
      Effect.gen(function* delegatedBounds() {
        yield* scenario.seedTenant({
          legalEntityIds: [companyA],
          moduleKeys: [SCENARIO_MODULE],
          principals: [
            { kind: 'human', principalId: owner },
            { kind: 'human', principalId: colleague },
            { kind: 'human', principalId: approver },
          ],
        });
        const bootstrapped = yield* scenario.bootstrap({
          legalEntityIds: [companyA],
          modules: scenarioModules(),
          principalId: owner,
        });
        const tenantScope = yield* tenantScopeIdOf(scenario.admin, scenario.tenantId);
        const delegationId = uid(60);
        const until = '2035-01-01T00:00:00.000Z';
        // The delegated role names only the capability the envelope names, capped at the envelope's
        // ceiling: a delegated cell may never be wider than the envelope it was granted under (D10b).
        yield* insertRoleWithCells(scenario.admin, scenario.tenantId, {
          amountCeiling: { currency: 'CZK', limitMinor: 100_000 },
          capabilityKeys: [AMOUNT_ACTION],
          catalogSnapshotId: bootstrapped.catalogSnapshotId,
          createdBy: owner,
          roleId: uid(62),
          roleRevisionId: uid(63),
          scopeId: tenantScope,
        });
        yield* scenario.admin
          .unsafe(
            `insert into core.access_delegations
               (delegation_id, tenant_id, scope_id, manager_id, granted_by, people, capability_keys, role_ids,
                amount_ceiling_json, status, valid_from, until, can_redelegate)
             values ('${delegationId}', '${scenario.tenantId}', '${tenantScope}', '${owner}', '${approver}',
                     array['${colleague}']::uuid[], array['${AMOUNT_ACTION}']::text[], array['${uid(62)}']::uuid[],
                     '{"currency":"CZK","limitMinor":100000}'::jsonb, 'active', now() - interval '1 day', '${until}', false)`,
          )
          .pipe(Effect.orDie);
        yield* insertMembership(scenario.admin, scenario.tenantId, {
          kind: 'member',
          principalId: colleague,
          recordedBy: owner,
          scopeId: tenantScope,
        });
        yield* insertAssignment(scenario.admin, scenario.tenantId, {
          assignedBy: owner,
          delegatedBy: delegationId,
          delegationEnvelopeJson: jsonText({
            amountCeiling: { currency: 'CZK', limitMinor: 100_000 },
            capabilityKeys: [AMOUNT_ACTION],
            delegationId,
            until,
          }),
          incarnationId: uid(61),
          principalId: colleague,
          roleId: uid(62),
          roleRevisionId: uid(63),
          scopeId: tenantScope,
          validUntil: `'${until}'`,
        });
        yield* reconcile(scenario, owner);

        const colleagueScope = yield* scenario.scopeFor(colleague);
        // Inside the envelope: allowed.
        yield* scenario.runAction({
          payload: { totalMinor: 80_000 },
          principal: colleagueScope,
          registration: amountActionRegistration,
          transport: transport('delegate-within'),
        });
        // Beyond it: denied by the envelope the delegation froze, even though the granted cell alone
        // would allow it (D10b, guarantee 9).
        const denied = yield* actionFailure(
          scenario.runAction({
            payload: { totalMinor: 150_000 },
            principal: colleagueScope,
            registration: amountActionRegistration,
            transport: transport('delegate-above'),
          }),
        );
        expect(Schema.is(ActionPermissionDenied)(denied)).toBe(true);
        expect(Schema.is(ActionPermissionDenied)(denied) ? denied.reasons : []).toContain(
          'deny.amount_exceeds_ceiling',
        );
        // The negative control: the owner holds the same capability through an uncapped cell, so the
        // bound the colleague met is the delegation's, not a global cap on the capability.
        const ownerScope = yield* scenario.scopeFor(owner);
        yield* scenario.runAction({
          payload: { totalMinor: 150_000 },
          principal: ownerScope,
          registration: amountActionRegistration,
          transport: transport('delegate-owner-uncapped'),
        });
      }),
    ),
  );

  suite.effect('a membership deadline that has passed stops every decision (D6)', () =>
    withAccessScenario((scenario) =>
      Effect.gen(function* membershipDeadline() {
        yield* scenario.seedTenant({
          legalEntityIds: [companyA],
          moduleKeys: [SCENARIO_MODULE],
          principals: [
            { kind: 'human', principalId: owner },
            { kind: 'human', principalId: colleague },
          ],
        });
        const bootstrapped = yield* scenario.bootstrap({
          legalEntityIds: [companyA],
          modules: scenarioModules(),
          principalId: owner,
        });
        const tenantScope = yield* tenantScopeIdOf(scenario.admin, scenario.tenantId);
        // The colleague's authority is live, but their membership ends before the instant the gate
        // decides at: nothing works past the earliest relevant end date, however healthy the
        // assignment is. Core enforces the deadline independently of engine caching (D6, guarantee 6).
        yield* insertMembership(scenario.admin, scenario.tenantId, {
          kind: 'member',
          principalId: colleague,
          recordedBy: owner,
          scopeId: tenantScope,
          validUntil: `'2029-01-01T00:00:00.000Z'`,
        });
        yield* insertAssignment(scenario.admin, scenario.tenantId, {
          assignedBy: owner,
          incarnationId: uid(42),
          principalId: colleague,
          roleId: bootstrapped.roleId,
          roleRevisionId: bootstrapped.roleRevisionId,
          scopeId: tenantScope,
        });
        yield* reconcile(scenario, owner);
        const denied = yield* scenario.decide({
          carrier: routineReadCarrier,
          legalEntityScope: 'forbidden',
          principalId: colleague,
        });
        expect(denied.outcome).toBe('DENIED');
        expect(denied.reasons.map(({ code }) => code)).toContain('deny.deadline_passed');
        // The negative control: the owner's own membership has no end date and still decides.
        expect(
          (yield* scenario.decide({
            carrier: routineReadCarrier,
            legalEntityScope: 'forbidden',
            principalId: owner,
          })).outcome,
        ).toBe('ALLOWED');
      }),
    ),
  );

  suite.effect('an unavailable engine is a retryable 503 and never an allow (O48)', () =>
    withAccessScenario((scenario) =>
      Effect.gen(function* engineUnavailable() {
        yield* scenario.seedTenant({
          legalEntityIds: [companyA],
          moduleKeys: [SCENARIO_MODULE],
          principals: [{ kind: 'human', principalId: owner }],
        });
        yield* scenario.bootstrap({ legalEntityIds: [companyA], modules: scenarioModules(), principalId: owner });

        const decision = yield* scenario.unavailableGate.decide({
          carrier: routineReadCarrier,
          legalEntityScope: 'forbidden',
          now: DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-01T00:00:00Z')),
          scope: yield* scenario.scopeFor(owner),
        });
        expect(decision.outcome).toBe('UNAVAILABLE');

        const ownerScope = yield* scenario.scopeFor(owner);
        const actionFailureResult = yield* actionFailure(
          scenario.runActionUnavailable({
            payload: { value: 'unavailable' },
            principal: ownerScope,
            registration: routineActionRegistration,
            transport: transport('unavailable-action'),
          }),
        );
        expect(Schema.is(ActionPermissionCheckError)(actionFailureResult)).toBe(true);

        const readFailureResult = yield* readFailure(
          scenario.runReadUnavailable({
            input: {},
            principal: ownerScope,
            registration: routineReadRegistration,
            transport: transport('unavailable-read'),
          }),
        );
        expect(Schema.is(ReadPermissionUnavailable)(readFailureResult)).toBe(true);

        // The negative control: the same composition over the real engine allows the owner.
        expect(
          (yield* scenario.decide({
            carrier: routineReadCarrier,
            legalEntityScope: 'forbidden',
            principalId: owner,
          })).outcome,
        ).toBe('ALLOWED');
      }),
    ),
  );

  suite.effect('uninstalling a module stops its decisions and a reinstall restores them (S7)', () =>
    withAccessScenario((scenario) =>
      Effect.gen(function* uninstallStops() {
        yield* scenario.seedTenant({
          legalEntityIds: [companyA],
          moduleKeys: [SCENARIO_MODULE],
          principals: [{ kind: 'human', principalId: owner }],
        });
        yield* scenario.bootstrap({ legalEntityIds: [companyA], modules: scenarioModules(), principalId: owner });
        const ask = () =>
          scenario.decide({ carrier: routineReadCarrier, legalEntityScope: 'forbidden', principalId: owner });
        expect((yield* ask()).outcome).toBe('ALLOWED');

        yield* scenario.admin
          .unsafe(
            `update core.tenant_module_states set state = 'suspended', updated_at = now()
             where tenant_id = '${scenario.tenantId}' and module_key = '${SCENARIO_MODULE}'`,
          )
          .pipe(Effect.orDie);
        const removed = yield* reconcile(scenario, owner);
        expect(removed.deletions).toBeGreaterThan(0);
        expect((yield* ask()).outcome).toBe('DENIED');

        yield* scenario.admin
          .unsafe(
            `update core.tenant_module_states set state = 'active', updated_at = now()
             where tenant_id = '${scenario.tenantId}' and module_key = '${SCENARIO_MODULE}'`,
          )
          .pipe(Effect.orDie);
        yield* reconcile(scenario, owner);
        expect((yield* ask()).outcome).toBe('ALLOWED');
      }),
    ),
  );

  suite.effect('retiring a tenant stops every decision of every member', () =>
    withAccessScenario((scenario) =>
      Effect.gen(function* retireStops() {
        yield* scenario.seedTenant({
          legalEntityIds: [companyA],
          moduleKeys: [SCENARIO_MODULE],
          principals: [{ kind: 'human', principalId: owner }],
        });
        yield* scenario.bootstrap({ legalEntityIds: [companyA], modules: scenarioModules(), principalId: owner });
        expect(
          (yield* scenario.decide({
            carrier: routineReadCarrier,
            legalEntityScope: 'forbidden',
            principalId: owner,
          })).outcome,
        ).toBe('ALLOWED');

        // The operator retires the tenant: every membership and assignment ends, then one reconcile.
        yield* scenario.admin
          .unsafe(`update core.access_assignments set status = 'revoked' where tenant_id = '${scenario.tenantId}'`)
          .pipe(Effect.orDie);
        yield* scenario.admin
          .unsafe(`update core.access_memberships set status = 'revoked' where tenant_id = '${scenario.tenantId}'`)
          .pipe(Effect.orDie);
        yield* reconcile(scenario, owner);
        const ownerScope = yield* scenario.scopeFor(owner);
        const denied = yield* actionFailure(
          scenario.runAction({
            payload: { value: 'retired' },
            principal: ownerScope,
            registration: routineActionRegistration,
            transport: transport('retired-tenant'),
          }),
        );
        expect(Schema.is(ActionPermissionDenied)(denied)).toBe(true);
      }),
    ),
  );

  suite.effect('a record-scoped list hides unassigned rows and a record-scoped detail is refused', () =>
    withAccessScenario((scenario) =>
      Effect.gen(function* listPerRow() {
        yield* scenario.seedTenant({
          legalEntityIds: [companyA],
          moduleKeys: [SCENARIO_MODULE],
          principals: [
            { kind: 'human', principalId: owner },
            { kind: 'human', principalId: colleague },
          ],
        });
        yield* scenario.bootstrap({ legalEntityIds: [companyA], modules: scenarioModules(), principalId: owner });
        const ownerScope = yield* scenario.scopeFor(owner);
        const rows = [
          { assignedPrincipalId: owner, recordKey: 'record-owner' },
          { assignedPrincipalId: colleague, recordKey: 'record-colleague' },
          { recordKey: 'record-unassigned' },
        ];
        const visible = yield* scenario.runRead({
          input: { rows },
          principal: ownerScope,
          registration: recordListRegistration,
          transport: transport('record-list'),
        });
        // The owner's own row is visible; the colleague's and the unassigned one are not (O25).
        expect(visible).toEqual(['record-owner']);

        const scopeRow = yield* scenario.admin
          .unsafe<{ readonly scope_id: string }>(
            `select scope_id from core.access_scopes
             where tenant_id = '${scenario.tenantId}' and tenant_context_id is not null`,
          )
          .pipe(Effect.orDie);
        const tenantScope = scopeRow[0]?.scope_id ?? '';
        // The record projection is the owner's own data; without it no record-scoped detail reaches.
        const refused = yield* readFailure(
          scenario.runRead({
            input: { recordKey: 'record-owner' },
            principal: ownerScope,
            registration: recordDetailRegistration,
            transport: transport('record-detail-before'),
          }),
        );
        expect(Schema.is(ReadPermissionDenied)(refused)).toBe(true);
        yield* scenario.writeRecordProjection({
          moduleKey: moduleKey(SCENARIO_MODULE),
          principalId: principalId(owner),
          recordKey: RecordKeySchema.make('record-owner'),
          scopeId: scopeId(tenantScope),
        });
        // The negative control: the record the owner is assigned to now reaches; another does not.
        const detail = yield* scenario.runRead({
          input: { recordKey: 'record-owner' },
          principal: ownerScope,
          registration: recordDetailRegistration,
          transport: transport('record-detail-after'),
        });
        expect(detail).toEqual({ recordKey: 'record-owner' });
        const otherRefused = yield* readFailure(
          scenario.runRead({
            input: { recordKey: 'record-colleague' },
            principal: ownerScope,
            registration: recordDetailRegistration,
            transport: transport('record-detail-other'),
          }),
        );
        expect(Schema.is(ReadPermissionDenied)(otherRefused)).toBe(true);
      }),
    ),
  );

  suite.effect('a new release is unusable until it is adopted into a role (S1)', () =>
    withAccessScenario((scenario) =>
      Effect.gen(function* releaseAdoption() {
        yield* scenario.seedTenant({
          legalEntityIds: [companyA],
          moduleKeys: [SCENARIO_MODULE, 'test.ledger'],
          principals: [{ kind: 'human', principalId: owner }],
        });
        const bootstrapped = yield* scenario.bootstrap({
          legalEntityIds: [companyA],
          modules: [...scenarioModules(), ...ledgerModulesWithoutExport],
          principalId: owner,
        });
        const scope = yield* scenario.scopeFor(owner);
        const published = yield* scenario.changes.loadPublishedCatalog().pipe(Effect.orDie);
        expect(Option.isSome(published)).toBe(true);
        const releaseOne = Option.getOrThrow(published);
        expect(releaseOne.entries.map(({ key }) => key)).toContain(LEDGER_READ);
        expect(releaseOne.entries.map(({ key }) => key)).not.toContain(LEDGER_EXPORT);

        const publishedAt = DateTime.toDateUtc(DateTime.makeUnsafe('2031-01-01T00:00:00Z'));
        const releaseTwo = yield* Effect.fromResult(
          buildAccessCatalogRelease({
            installedModuleKeys: [moduleKey('test.ledger'), moduleKey(SCENARIO_MODULE)],
            modules: [...scenarioModules(), ...ledgerModulesWithExport],
            publishedAt,
          }),
        ).pipe(
          Effect.tapError((failure) => Effect.logWarning(`c20 release refusal: ${failure.code} ${failure.reason}`)),
        );
        yield* scenario.changes.publishCatalog({ snapshot: releaseTwo }).pipe(Effect.orDie);
        // The release the export was added in: the one entry this scenario adopts, or a defect.
        const releaseTwoEntry = yield* Option.match(
          Option.fromNullishOr(releaseTwo.entries.find(({ key }) => key === LEDGER_EXPORT)),
          {
            onNone: () => Effect.die(new Error('the second release must publish the added export capability')),
            onSome: Effect.succeed,
          },
        );

        // Before adoption the capability is published but nothing grants it (guarantee 2).
        const beforeAdoption = yield* scenario.decide({
          carrier: ledgerExportCarrier,
          legalEntityScope: 'forbidden',
          principalId: owner,
        });
        expect(beforeAdoption.outcome).toBe('DENIED');

        const itemIds = new Map([[changeItemIdentityKey('new', LEDGER_EXPORT), uid(70)]]);
        const blueprints = yield* Effect.fromResult(
          blueprintChangeItems({
            drafts: yield* Effect.fromResult(diffCatalogSnapshots(releaseOne, releaseTwo)),
            entries: releaseTwo.entries,
            roles: [],
          }),
        ).pipe(logged);
        const itemPlan = yield* Effect.fromResult(
          planChangeItems({
            assignments: [],
            blueprints,
            catalogSnapshotId: releaseTwo.id,
            createdAt: publishedAt,
            itemIds,
            tenantId: scenario.tenantId,
          }),
        ).pipe(logged);
        yield* scenario.changes.recordChangeItems({ plan: itemPlan, scope }).pipe(Effect.orDie);

        const state = yield* scenario.changes.loadTenantChanges(scope).pipe(Effect.orDie);
        const itemId = AccessChangeItemIdSchema.make(uid(70));
        const newRevisionId = uid(71);
        const preview = previewAdoption({
          assignments: [],
          at: publishedAt,
          items: [{ itemId, roleIds: [bootstrapped.roleId] }],
        });
        const adoptionPlan = yield* Effect.fromResult(
          planAdoption({
            actor: { _tag: 'Principal', principalId: principalId(owner) },
            assignments: [],
            authority: { _tag: 'Owner' },
            batchId: uid(72),
            decidedAt: publishedAt,
            decisionIds: new Map([[itemId, uid(73)]]),
            entries: releaseTwo.entries,
            items: state.items,
            namedEffects: new Map([[itemId, capabilityEffectLabel(releaseTwoEntry)]]),
            newRevisionIds: new Map([[bootstrapped.roleId, newRevisionId]]),
            preview,
            roles: state.roles,
            selections: [{ itemId, targets: [{ modes: ['run'], roleId: bootstrapped.roleId, selector: 'all' }] }],
            tenantId: scenario.tenantId,
          }),
        ).pipe(logged);
        yield* scenario.changes
          .recordAdoption({ catalogSnapshotId: releaseTwo.id, plan: adoptionPlan, scope })
          .pipe(Effect.orDie);
        yield* scenario.writer.reconcileTenant({ scope }).pipe(Effect.orDie);

        // After adoption the capability is held and usable (guarantee 2).
        const afterAdoption = yield* scenario.decide({
          carrier: ledgerExportCarrier,
          legalEntityScope: 'forbidden',
          principalId: owner,
        });
        expect(afterAdoption.outcome).toBe('ALLOWED');
      }),
    ),
  );

  suite.effect('an approval mandate executes exactly once and never revives (guarantee 5, O63)', () =>
    Effect.sync(() => {
      const proposalScope = scopeId(uid(80));
      const requesterWitness = {
        assignmentIncarnationId: AssignmentIncarnationIdSchema.make(uid(81)),
        capabilityKey: capabilityKey(AMOUNT_ACTION),
        grantIncarnationId: GrantIncarnationIdSchema.make(uid(82)),
        holderId: { _tag: 'Principal' as const, principalId: principalId(colleague) },
        mode: 'propose' as const,
        purpose: 'requester' as const,
        scopeId: proposalScope,
      };
      const approvalWitness = {
        assignmentIncarnationId: AssignmentIncarnationIdSchema.make(uid(83)),
        capabilityKey: capabilityKey(AMOUNT_ACTION),
        grantIncarnationId: GrantIncarnationIdSchema.make(uid(84)),
        holderId: { _tag: 'Principal' as const, principalId: principalId(owner) },
        mode: 'approve' as const,
        purpose: 'approval' as const,
        scopeId: proposalScope,
      };
      const executionWitness = {
        assignmentIncarnationId: AssignmentIncarnationIdSchema.make(uid(83)),
        capabilityKey: capabilityKey(AMOUNT_ACTION),
        grantIncarnationId: GrantIncarnationIdSchema.make(uid(84)),
        holderId: { _tag: 'Principal' as const, principalId: principalId(owner) },
        mode: 'run' as const,
        purpose: 'execution' as const,
        scopeId: proposalScope,
      };
      const commandDigest = CommandDigestSchema.make('a'.repeat(64));
      const proposal: Proposal = {
        approval: {
          approvalAssignmentIncarnationId: AssignmentIncarnationIdSchema.make(uid(83)),
          approvedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-01T00:00:00Z')),
          approverId: principalId(owner),
          executionAssignmentIncarnationId: AssignmentIncarnationIdSchema.make(uid(83)),
          expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-02T00:00:00Z')),
        },
        capabilityKey: capabilityKey(AMOUNT_ACTION),
        commandDigest,
        createdAt: DateTime.toDateUtc(DateTime.makeUnsafe('2029-12-31T00:00:00Z')),
        expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-03T00:00:00Z')),
        id: ProposalIdSchema.make(uid(85)),
        requester: { _tag: 'Principal', principalId: principalId(colleague) },
        scopeId: proposalScope,
        status: 'approved',
        tenantId: TenantIdSchema.make(uid(1)),
        witnesses: [requesterWitness, approvalWitness, executionWitness],
      };
      const witnessAuthority: WitnessAuthorityMap = new Map(
        [requesterWitness, approvalWitness, executionWitness].map((witness) => [authorityWitnessSlot(witness), 'live']),
      );
      const first = execute({
        actionInvocationId: ActionInvocationRefSchema.make(uid(86)),
        actor: { _tag: 'Principal', principalId: principalId(owner) },
        commandDigest,
        now: DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-01T12:00:00Z')),
        proposal,
        witnessAuthority,
      });
      expect(Result.isSuccess(first)).toBe(true);
      const executed = Result.isSuccess(first) ? first.success : proposal;
      expect(executed.status).toBe('executed');
      expect(executed.execution?.actionInvocationId).toBe(uid(86));

      // The negative control: the same mandate never executes a second time.
      const second = execute({
        actionInvocationId: ActionInvocationRefSchema.make(uid(87)),
        actor: { _tag: 'Principal', principalId: principalId(owner) },
        commandDigest,
        now: DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-01T13:00:00Z')),
        proposal: executed,
        witnessAuthority,
      });
      expect(Result.isFailure(second)).toBe(true);
      expect(Result.isFailure(second) ? second.failure.code : '').toBe('proposal_already_executed');

      // A mandate the approver no longer holds is refused, never executed under stale authority (P5).
      // Every witness of this proposal is live except the execution witness, which is lost.
      const lostWitnessAuthority = new Map<string, WitnessAuthorityState>(
        [requesterWitness, approvalWitness, executionWitness].map(
          (witness) => [authorityWitnessSlot(witness), witness === executionWitness ? 'lost' : 'live'] as const,
        ),
      );
      const lost = execute({
        actionInvocationId: ActionInvocationRefSchema.make(uid(88)),
        actor: { _tag: 'Principal', principalId: principalId(owner) },
        commandDigest,
        now: DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-01T12:00:00Z')),
        proposal,
        witnessAuthority: lostWitnessAuthority,
      });
      expect(Result.isFailure(lost)).toBe(true);
      expect(Result.isFailure(lost) ? lost.failure.code : '').toBe('authority_lost');
    }),
  );

  suite.effect(
    'a field group on a scope-wide entrypoint is decided with its own read, and a record-scoped one keeps its record (O74)',
    () =>
      withAccessScenario((scenario) =>
        Effect.gen(function* fieldGroupsOnScopeWideEntrypoints() {
          // Five holders of the same tenant: the read, the read plus its salary field, the Action, the
          // Action plus its purchase-price field, and a member with no assignment at all (the control).
          const readOnly = uid(60);
          const fieldReader = uid(61);
          const actionOnly = uid(62);
          const fieldWriter = uid(63);
          const stranger = uid(64);
          yield* scenario.seedTenant({
            legalEntityIds: [companyA],
            moduleKeys: [SCENARIO_MODULE],
            principals: [owner, readOnly, fieldReader, actionOnly, fieldWriter, stranger].map((principal) => ({
              kind: 'human' as const,
              principalId: principal,
            })),
          });
          const bootstrapped = yield* scenario.bootstrap({
            legalEntityIds: [companyA],
            modules: scenarioModules(),
            principalId: owner,
          });
          const tenantScope = yield* tenantScopeIdOf(scenario.admin, scenario.tenantId);
          const memberOf = (principal: string) =>
            insertMembership(scenario.admin, scenario.tenantId, {
              kind: 'member',
              principalId: principal,
              recordedBy: owner,
              scopeId: tenantScope,
            });
          for (const principal of [readOnly, fieldReader, actionOnly, fieldWriter, stranger]) {
            yield* memberOf(principal);
          }
          // One role per authority shape: a cell per capability, the way the bootstrap writes them (O51).
          const grant = (input: {
            readonly capabilityKeys: readonly string[];
            readonly incarnationId: string;
            readonly principalId: string;
            readonly roleId: string;
            readonly roleRevisionId: string;
          }) =>
            insertRoleWithCells(scenario.admin, scenario.tenantId, {
              capabilityKeys: input.capabilityKeys,
              catalogSnapshotId: bootstrapped.catalogSnapshotId,
              createdBy: owner,
              roleId: input.roleId,
              roleRevisionId: input.roleRevisionId,
              scopeId: tenantScope,
            }).pipe(
              Effect.andThen(
                insertAssignment(scenario.admin, scenario.tenantId, {
                  assignedBy: owner,
                  incarnationId: input.incarnationId,
                  principalId: input.principalId,
                  roleId: input.roleId,
                  roleRevisionId: input.roleRevisionId,
                  scopeId: tenantScope,
                }),
              ),
            );
          yield* grant({
            capabilityKeys: [FIELD_READ, RECORD_FIELD_READ],
            incarnationId: uid(70),
            principalId: readOnly,
            roleId: uid(65),
            roleRevisionId: uid(66),
          });
          yield* grant({
            capabilityKeys: [FIELD_READ, FIELD_READ_GROUP, FIELD_RECORD_READ_GROUP, RECORD_FIELD_READ],
            incarnationId: uid(71),
            principalId: fieldReader,
            roleId: uid(67),
            roleRevisionId: uid(68),
          });
          yield* grant({
            capabilityKeys: [FIELD_ACTION],
            incarnationId: uid(72),
            principalId: actionOnly,
            roleId: uid(73),
            roleRevisionId: uid(74),
          });
          yield* grant({
            capabilityKeys: [FIELD_ACTION, FIELD_WRITE_GROUP],
            incarnationId: uid(75),
            principalId: fieldWriter,
            roleId: uid(76),
            roleRevisionId: uid(77),
          });
          yield* reconcile(scenario, owner);

          const readOnlyScope = yield* scenario.scopeFor(readOnly);
          const fieldReaderScope = yield* scenario.scopeFor(fieldReader);
          const actionOnlyScope = yield* scenario.scopeFor(actionOnly);
          const fieldWriterScope = yield* scenario.scopeFor(fieldWriter);
          const strangerScope = yield* scenario.scopeFor(stranger);
          const actionPayload = {
            derived: { purchasePrice: { currency: 'CZK', minor: 1200 } },
            value: 'field-write',
          };

          // A caller with the read but not the salary field receives the result without the field.
          const withoutField = yield* scenario.runRead({
            input: {},
            principal: readOnlyScope,
            registration: fieldReadRegistration,
            transport: transport('field-read-without'),
          });
          expect(withoutField).toEqual({ status: 'field' });
          // The caller holding both receives it whole.
          const withField = yield* scenario.runRead({
            input: {},
            principal: fieldReaderScope,
            registration: fieldReadRegistration,
            transport: transport('field-read-with'),
          });
          expect(withField).toEqual({ salaries: { amount: 5000, currencyCode: 'CZK' }, status: 'field' });
          // Negative control: a member with no assignment at all is refused the read outright (403).
          const strangerRead = yield* readFailure(
            scenario.runRead({
              input: {},
              principal: strangerScope,
              registration: fieldReadRegistration,
              transport: transport('field-read-stranger'),
            }),
          );
          expect(Schema.is(ReadPermissionDenied)(strangerRead)).toBe(true);

          // A scope-wide Action: the governed field is refused without its own grant (403), while every
          // other field of the same Action stays writable for that caller.
          const governedWrite = yield* actionFailure(
            scenario.runAction({
              payload: actionPayload,
              principal: actionOnlyScope,
              registration: fieldActionRegistration,
              transport: transport('field-write-without'),
            }),
          );
          expect(Schema.is(ActionPermissionDenied)(governedWrite)).toBe(true);
          expect(Schema.is(ActionPermissionDenied)(governedWrite) ? governedWrite.reason : '').toContain(
            'derived.purchasePrice',
          );
          yield* scenario.runAction({
            payload: { value: 'plain' },
            principal: actionOnlyScope,
            registration: fieldActionRegistration,
            transport: transport('field-write-other'),
          });
          // The caller holding the field group writes it.
          yield* scenario.runAction({
            payload: actionPayload,
            principal: fieldWriterScope,
            registration: fieldActionRegistration,
            transport: transport('field-write-granted'),
          });

          // The record-scoped control: the same shape on a record-scoped read keeps the record it is
          // decided with, so the one gate still refuses it without one (D14 stays exactly as it was).
          const recordWithoutRecord = yield* scenario.decide({
            carrier: recordFieldReadCarrier,
            legalEntityScope: 'forbidden',
            principalId: fieldReader,
          });
          expect(recordWithoutRecord.outcome).toBe('DENIED');
          expect(recordWithoutRecord.reasons.map(({ code }) => code)).toContain('deny.target_required');
          yield* scenario.writeRecordProjection({
            moduleKey: moduleKey(SCENARIO_MODULE),
            principalId: principalId(fieldReader),
            recordKey: RecordKeySchema.make('record-field'),
            scopeId: scopeId(tenantScope),
          });
          yield* scenario.writeRecordProjection({
            moduleKey: moduleKey(SCENARIO_MODULE),
            principalId: principalId(readOnly),
            recordKey: RecordKeySchema.make('record-field-plain'),
            scopeId: scopeId(tenantScope),
          });
          const recordReached = yield* scenario.runRead({
            input: { recordKey: 'record-field' },
            principal: fieldReaderScope,
            registration: recordFieldReadRegistration,
            transport: transport('record-field-projected'),
          });
          expect(recordReached).toEqual({
            recordKey: 'record-field',
            salaries: { amount: 5000, currencyCode: 'CZK' },
          });
          // The same record-scoped read without the field group still reaches, minus the governed field.
          const recordPlain = yield* scenario.runRead({
            input: { recordKey: 'record-field-plain' },
            principal: readOnlyScope,
            registration: recordFieldReadRegistration,
            transport: transport('record-field-plain'),
          });
          expect(recordPlain).toEqual({ recordKey: 'record-field-plain' });
          // Engine down: both paths answer a retryable 503, never a projection and never an allow (O48b).
          const deadRead = yield* readFailure(
            scenario.runReadUnavailable({
              input: {},
              principal: fieldReaderScope,
              registration: fieldReadRegistration,
              transport: transport('field-read-dead'),
            }),
          );
          expect(Schema.is(ReadPermissionUnavailable)(deadRead)).toBe(true);
          const deadWrite = yield* actionFailure(
            scenario.runActionUnavailable({
              payload: { value: 'dead' },
              principal: actionOnlyScope,
              registration: fieldActionRegistration,
              transport: transport('field-write-dead'),
            }),
          );
          expect(Schema.is(ActionPermissionCheckError)(deadWrite)).toBe(true);
        }),
      ),
  );
});
