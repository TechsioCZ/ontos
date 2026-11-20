import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Context, Crypto, DateTime, Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { AccessDecisionGate } from '../../src/access/enforcement/contract.ts';
import { AccessDecisionLive } from '../../src/access/enforcement/service.ts';
import { AccessProjectionCompiler } from '../../src/access/intent/projection-compiler.ts';
import {
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '../../src/access/compiler/spice-db-compiler.ts';
import { AccessChangesStoreLive } from '../../src/access/changes/persistence/drizzle-store.ts';
import { AccessCatalogSnapshotWriterLive } from '../../src/access/intent/catalog-snapshot-writer.ts';
import { AccessMembershipStoreLive } from '../../src/access/intent/memberships.ts';
import { AccessPeopleStoreLive } from '../../src/access/intent/people-store.ts';
import { AccessProjectionWriter, AccessProjectionWriterLive } from '../../src/access/intent/projection-writer.ts';
import { projectionWriteRefusal } from '../../src/access/intent/projection-write-error.ts';
import { AccessTeamStoreLive } from '../../src/access/intent/teams.ts';
import { TenantIntentLoaderLive } from '../../src/access/intent/tenant-intent-loader.ts';
import { AccessWriteJournalStoreLive } from '../../src/access/lifecycle/persistence/journal-store.ts';
import { TenantAccessBootstrapLive } from '../../src/access/bootstrap/bootstrap-tenant-access.ts';
import { legalEntityScopeId, tenantContextScopeId } from '../../src/access/bootstrap/persistence.ts';
import {
  AccessDecisionLogLive,
  AccessIntentLive,
  AccessPrincipalKindSourceLive,
  LegalEntityCandidatesLive,
} from '../../src/actions/runtime-wiring.ts';
import { DecisionCheck } from '../../src/access/decision/engine.ts';
import { makeSpiceDbDecisionCheckPort } from '../../src/access/decision/spicedb-check-port.ts';
import { spiceDbTransport } from '#spicedb-transport';
import { LegalEntityIdSchema, PrincipalIdSchema, TenantIdSchema } from '../../src/access/ids.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { decodeAccessDeclarationOrThrow } from '../../src/authorization/access-declaration.ts';
import type { AccessCatalogModule, AccessDeclarationInput } from '../../src/authorization/access-declaration.ts';
import type { AccessDecision } from '../../src/access/decision/contract.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../src/db/database-identities.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { coreRelations } from '../../src/db/schema.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';
import { newSpiceDbGrpcClient } from '../../src/permissions/spicedb-grpc-rpc.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';
import { reconcileStageContextBootstraps } from '../../src/install/stage-context-bootstrap.ts';
import type { StageAccountIdentity, StageTenantBootstrap } from '../../src/install/stage-context-bootstrap.ts';
import { createTemplateDatabase, replacedDatabase } from '../support/access-scenarios/database.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

/*
 * The stage bootstrap, end to end (CUTOVER-PLAN §3.5, ADR-0028, O67-Q6). An operator accounts file
 * creates a tenant the way a product tenant is created — identity rows, then `bootstrapTenantAccess`,
 * then one reconcile through the single Core writer — and the real gate answers the capabilities of the
 * release. Every claim carries its negative control: a named account without a role holds nothing, and a
 * retired tenant stops deciding.
 *
 * Each case gets its own database beside the integration environment's, and its own random tenant in the
 * environment's SpiceDB.
 */

const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

const MODULE = 'party.registry';
const READ = 'party.registry.party.read';
const ACTION = 'party.registry.party.change';
const CORE_READ = 'core.shell.composition.read';

const readEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'party.registry.api.party-list',
  moduleKey: MODULE,
  role: 'api',
});
const actionEntrypoint = defineTenantModuleEntrypoint({
  access: 'write',
  authorization: { kind: 'protected' },
  entrypointKey: 'party.registry.action.change-party',
  moduleKey: MODULE,
  role: 'action',
});
const coreReadEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'core.shell.api.composition',
  moduleKey: 'core.shell',
  role: 'api',
});

const read: AccessDeclarationInput = {
  key: READ,
  kind: 'read',
  modes: ['run'],
  placement: { group: 'parties', level: 'basic' },
  risk: 'routine',
  selectors: [],
};
const action: AccessDeclarationInput = {
  key: ACTION,
  kind: 'action',
  // A sensitive Action must support proposing it, so "Plný přístup" holds both modes (O10, O67-Q6).
  modes: ['run', 'propose'],
  placement: { group: 'parties', level: 'manage' },
  risk: 'sensitive',
  selectors: [],
};
const coreRead: AccessDeclarationInput = {
  key: CORE_READ,
  kind: 'read',
  modes: ['run'],
  placement: { group: 'shell', level: 'basic' },
  risk: 'routine',
  selectors: [],
};

/** The composition the stage run is handed: the tenant's module and Core's own (O69). */
const modules: readonly AccessCatalogModule[] = [
  {
    descriptors: [
      { accessDeclaration: read, entrypoint: readEntrypoint },
      { accessDeclaration: action, entrypoint: actionEntrypoint },
    ],
    moduleId: MODULE,
  },
  { descriptors: [{ accessDeclaration: coreRead, entrypoint: coreReadEntrypoint }], moduleId: 'core.shell' },
];

const readCarrier = { accessDeclaration: decodeAccessDeclarationOrThrow(read, readEntrypoint) };
const actionCarrier = { accessDeclaration: decodeAccessDeclarationOrThrow(action, actionEntrypoint) };
const coreReadCarrier = { accessDeclaration: decodeAccessDeclarationOrThrow(coreRead, coreReadEntrypoint) };

const owner = uid(2);
const colleague = uid(3);
const unassigned = uid(4);
const company = uid(5);

/** One operator accounts file entry: an owner, a colleague who holds "Plný přístup", and a plain account. */
const tenantBootstrap = (tenantId: string, further: readonly StageAccountIdentity[] = []): StageTenantBootstrap => ({
  accounts: [
    {
      authBindingId: uid(11),
      displayName: 'Owner',
      owner: true,
      principalId: owner,
      providerUserId: `auth-owner-${tenantId}`,
      roles: [],
    },
    {
      authBindingId: uid(12),
      displayName: 'Colleague',
      owner: false,
      principalId: colleague,
      providerUserId: `auth-colleague-${tenantId}`,
      roles: ['full_access'],
    },
    // A named account the operator gave no role: it is a person of the tenant file and holds nothing.
    {
      authBindingId: uid(13),
      displayName: 'Unassigned',
      owner: false,
      principalId: unassigned,
      providerUserId: `auth-unassigned-${tenantId}`,
      roles: [],
    },
    ...further,
  ],
  tenant: {
    defaultLocale: 'cs',
    displayName: 'Stage tenant',
    legalEntity: {
      legalEntityId: company,
      legalName: 'Stage tenant s.r.o.',
      registrationCountry: 'CZ',
      registrationNumber: 'STAGE-0001',
    },
    moduleKey: MODULE,
    moduleStateId: uid(21),
    slug: `stage-tenant-${tenantId.slice(-4)}`,
    tenantId,
  },
});

/** One trusted request scope: the acting person in the tenant context (O66). */
const scopeFor = (tenantId: string, principalId: string) =>
  Schema.decodeEffect(TrustedPrincipalContextSchema)({
    authBindingId: uid(300),
    authContextRef: `session:stage-context-bootstrap:${principalId}`,
    authMethod: 'session' as const,
    principalId,
    tenantId,
  }).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'stage-context-bootstrap' }) satisfies OperationalScope),
    Effect.orDie,
  );

const decisionAt = DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-01T00:00:00Z'));

const INSTALLATION_OPTIONS = { authenticationNamespaceId: 'staff', modules } as const;

/** A stage run that reconciles nothing; each case names only what its operator file adds. */
const emptyRun = { attachedLogins: [], retiredPrincipals: [], retiredTenants: [], tenants: [] } as const;

/** A failure travels as text: a bootstrap or a reconcile reports a phase plus the reason it recorded. */
class StageFailure extends Schema.TaggedError<StageFailure>()('StageFailure', { reason: Schema.String }) {}

const asStageFailure = (cause: { readonly code: string; readonly reason: string }): StageFailure =>
  new StageFailure({ reason: `${cause.code}: ${cause.reason}` });

/** A refused stage run fails the case with the phase and reason the bootstrap recorded. */
const failClosed = <A>(effect: Effect.Effect<A, StageFailure>): Effect.Effect<A> =>
  effect.pipe(
    Effect.catchTag('StageFailure', (refused) => Effect.die(new Error(`stage bootstrap refused: ${refused.reason}`))),
  );

interface Stage {
  readonly admin: PgClient.PgClient;
  /** One protected capability of the release, asked the way an entrypoint asks it. */
  readonly decide: (input: {
    readonly carrier: { readonly accessDeclaration: ReturnType<typeof decodeAccessDeclarationOrThrow> };
    readonly principalId: string;
    readonly tenantId: string;
  }) => Effect.Effect<AccessDecision>;
  /** One reconcile of the tenant through the single Core writer, as the bootstrap calls it. */
  readonly project: (
    scope: OperationalScope,
  ) => Effect.Effect<
    { readonly deletions: number; readonly touches: number; readonly verified: boolean },
    StageFailure
  >;
  /** The stage bootstrap of one operator accounts file, over this suite's tenant runtime. */
  readonly reconcile: (
    input: Parameters<typeof reconcileStageContextBootstraps>[0],
  ) => Effect.Effect<readonly { readonly owner: boolean; readonly principalId: string }[], StageFailure>;
  /** The same run, stopped after its intent committed: the single writer never gets to project it. */
  readonly reconcileInterrupted: (
    input: Parameters<typeof reconcileStageContextBootstraps>[0],
  ) => Effect.Effect<readonly { readonly owner: boolean; readonly principalId: string }[], StageFailure>;
  /** The case's own tenant: random, so no case reads another case's tuples in the shared engine. */
  readonly tenantId: string;
}

const withStage = <Value, Failure>(run: (stage: Stage) => Effect.Effect<Value, Failure>) =>
  Effect.gen(function* stageScenario() {
    const crypto = yield* Crypto.Crypto;
    const [connections, spiceDb] = yield* Effect.all(
      [loadDatabaseConnectionPair({ envPath: '/dev/null' }), loadSpiceDbConfig({ envPath: '/dev/null' })],
      {
        concurrency: 2,
      },
    ).pipe(Effect.orDie);
    const bootstrapConnection = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
    const database = `stage_bootstrap_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
    yield* bootstrapConnection.unsafe(`create database "${database}"`).pipe(Effect.orDie);
    yield* Effect.addFinalizer(() =>
      bootstrapConnection.unsafe(`drop database if exists "${database}" with (force)`).pipe(Effect.orDie),
    );
    const admin = yield* makeTestPgClient(replacedDatabase(connections.admin.connectionString, database), {
      maxConnections: 2,
    });
    // The whole committed schema; the stage bootstrap creates the tenant's identity rows itself, so the suite
    // seeds nothing.
    yield* createTemplateDatabase(admin);
    const runtime = yield* makeTestPgClient(replacedDatabase(connections.runtime.connectionString, database), {
      maxConnections: 2,
    });
    const executor = yield* makeTestDatabaseFromClient(runtime, coreRelations);
    // The suite owns the engine's schema, so it starts from exactly the v2 definitions Core serves.
    yield* Effect.acquireUseRelease(
      Effect.sync(() => newSpiceDbGrpcClient(spiceDb)),
      (client) =>
        Effect.tryPromise(() =>
          client.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })),
        ).pipe(Effect.orDie),
      (client) => Effect.sync(() => client.close()),
    );
    // The engine port over the integration SpiceDB: the runtime's transport reads the deployment's
    // environment, which a suite never owns, so the suite hands the gate its own transport instead.
    const rpc = spiceDbTransport.open(spiceDb, 10_000);
    yield* Effect.addFinalizer(() => Effect.sync(() => rpc.close()));
    const check = Layer.succeed(DecisionCheck, makeSpiceDbDecisionCheckPort(rpc));
    const engine = Layer.effect(
      AccessProjectionCompiler,
      Effect.sync(() => makeAccessProjectionCompiler(makeAccessProjectionTransport(spiceDb))),
    );
    const core = Layer.mergeAll(
      Layer.succeed(CoreDatabase, { executor }),
      Layer.succeed(DatabaseIdentityEnrollmentContext, FIXTURE_DATABASE_IDENTITY_ENROLLMENT),
    );
    const platforms = Layer.mergeAll(core, engine, NodeServices.layer);
    const intent = TenantIntentLoaderLive.pipe(Layer.provide(platforms));
    const journal = AccessWriteJournalStoreLive.pipe(Layer.provide(platforms));
    const changes = AccessChangesStoreLive.pipe(Layer.provide(platforms));
    const memberships = AccessMembershipStoreLive.pipe(Layer.provide(platforms));
    const people = AccessPeopleStoreLive.pipe(Layer.provide(platforms));
    const teams = AccessTeamStoreLive.pipe(Layer.provide(platforms));
    const stores = Layer.mergeAll(platforms, intent, journal, changes, memberships, people, teams);
    const catalog = AccessCatalogSnapshotWriterLive.pipe(Layer.provide(stores));
    const writer = AccessProjectionWriterLive.pipe(Layer.provide(stores));
    const bootstrap = TenantAccessBootstrapLive.pipe(Layer.provide(Layer.mergeAll(stores, catalog, writer)));
    const base = Layer.mergeAll(stores, catalog, writer, bootstrap);
    const ports = Layer.mergeAll(
      AccessIntentLive,
      AccessDecisionLogLive,
      AccessPrincipalKindSourceLive,
      LegalEntityCandidatesLive,
      check,
    );
    const context = yield* Layer.build(
      Layer.mergeAll(base, AccessDecisionLive.pipe(Layer.provide(ports), Layer.provide(base))),
    );
    const gate = Context.get(context, AccessDecisionGate);
    const projectionWriter = Context.get(context, AccessProjectionWriter);
    return yield* run({
      admin,
      decide: ({ carrier, principalId, tenantId }) =>
        Effect.flatMap(scopeFor(tenantId, principalId), (scope) =>
          gate.decide({ carrier, legalEntityScope: 'forbidden', now: decisionAt, scope }),
        ).pipe(Effect.provide(context)),
      project: (scope) =>
        projectionWriter.reconcileTenant({ scope }).pipe(Effect.mapError(asStageFailure), Effect.provide(context)),
      reconcile: (input) =>
        reconcileStageContextBootstraps(input, INSTALLATION_OPTIONS).pipe(
          Effect.mapError(asStageFailure),
          Effect.provide(context),
        ),
      reconcileInterrupted: (input) =>
        reconcileStageContextBootstraps(input, INSTALLATION_OPTIONS).pipe(
          Effect.mapError(asStageFailure),
          Effect.provide(
            Context.add(context, AccessProjectionWriter, {
              reconcileTenant: () =>
                Effect.fail(
                  projectionWriteRefusal('access_projection_write_unavailable', 'interrupted after the commit'),
                ),
            }),
          ),
        ),
      tenantId: yield* crypto.randomUUIDv4(),
    });
  }).pipe(Effect.scoped);

const bystander = uid(7);

/** A further person of the tenant who holds "Plný přístup" and takes no part in any departure. */
const bystanderAccount = (tenantId: string): StageAccountIdentity => ({
  authBindingId: uid(17),
  displayName: 'Bystander',
  owner: false,
  principalId: bystander,
  providerUserId: `auth-bystander-${tenantId}`,
  roles: ['full_access'],
});

/** One retired Principal as the operator file names it: the person and the login its email resolves to. */
const leaving = (tenantId: string, principalId: string, login: string) => ({
  principalId,
  providerUserId: `auth-${login}-${tenantId}`,
  tenantId,
});

const seed = (stage: Stage, ...statements: readonly string[]) =>
  Effect.forEach(statements, (statement) => stage.admin.unsafe(statement).pipe(Effect.orDie), {
    concurrency: 1,
    discard: true,
  });

/**
 * Every row a departure can move for these people, as one text: the same text before and after a run means
 * the run wrote nothing of theirs.
 */
const peopleRowsOf = (stage: Stage, principalIds: readonly string[]) => {
  const people = principalIds.map((principalId) => `'${principalId}'`).join(', ');
  const of = `tenant_id = '${stage.tenantId}' and principal_id in (${people})`;
  return Effect.forEach(
    [
      `select principal_id::text as person, principal_auth_binding_id::text as id, subject_type, status, revoked_at,
         binding_revision from core.principal_auth_bindings where ${of} order by 2`,
      `select principal_id::text as person, status from core.principals where ${of} order by 1`,
      `select principal_id::text as person, membership_id::text as id, kind, status, ended_at
         from core.access_memberships where ${of} order by 2`,
      `select principal_id::text as person, incarnation_id::text as id, delegated_by::text as delegation, status
         from core.access_assignments where ${of} order by 2`,
      `select principal_id::text as person, legal_entity_id::text as id, status, revision
         from core.principal_company_memberships where ${of} order by 1, 2`,
    ],
    (statement) => stage.admin.unsafe(statement).pipe(Effect.orDie),
    { concurrency: 1 },
  ).pipe(Effect.map((tables) => JSON.stringify(tables)));
};

/** The company directory membership `core.identity.set-company-membership` records for a person. */
const directoryRow = (tenantId: string, principalId: string) =>
  `insert into core.principal_company_memberships (tenant_id, legal_entity_id, principal_id, affiliation, status)
     values ('${tenantId}', '${company}', '${principalId}', 'employee', 'active')`;

/** The tenant's "Plný přístup" role and revision, as the owner's bootstrap assigned it. */
const fullAccessRoleOf = (stage: Stage) =>
  stage.admin
    .unsafe<{ readonly revision: string; readonly role: string }>(
      `select role_id::text as role, role_revision_id::text as revision from core.access_assignments
        where tenant_id = '${stage.tenantId}' and principal_id = '${owner}' and delegated_by is null limit 1`,
    )
    .pipe(
      Effect.orDie,
      Effect.flatMap(([role]) =>
        role === undefined ? Effect.die(new Error('the owner holds no "Plný přístup"')) : Effect.succeed(role),
      ),
    );

/** A live delegation of the tenant's company, granted and managed as named, over "Plný přístup" reads. */
const delegationRow = (
  stage: Stage,
  input: {
    readonly grantedBy: string;
    readonly id: string;
    readonly manager: string;
    readonly people: string;
    readonly role: string;
  },
) =>
  `insert into core.access_delegations
     (delegation_id, tenant_id, scope_id, granted_by, manager_id, people, role_ids, capability_keys,
      amount_ceiling_json, status, valid_from, until)
   values ('${input.id}', '${stage.tenantId}', '${legalEntityScopeId(TenantIdSchema.make(stage.tenantId), LegalEntityIdSchema.make(company))}',
           '${input.grantedBy}', '${input.manager}', array['${input.people}'::uuid], array['${input.role}'::uuid],
           array['${READ}', '${ACTION}', '${CORE_READ}'], null, 'active', now() - interval '1 day', '2099-01-01T00:00:00Z')`;

/** What the gate answers one person for every capability of the release. */
const outcomesOf = (stage: Stage, principalId: string) =>
  Effect.forEach(
    [readCarrier, actionCarrier, coreReadCarrier],
    (carrier) =>
      stage.decide({ carrier, principalId, tenantId: stage.tenantId }).pipe(Effect.map(({ outcome }) => outcome)),
    { concurrency: 1 },
  );

interface StatusRow {
  readonly person: string;
  readonly status: string;
  readonly table: string;
}

/** The distinct statuses of one person's rows in one table. */
const statusesOf = (rows: readonly StatusRow[], person: string, table: string) => [
  ...new Set(rows.filter((row) => row.person === person && row.table === table).map(({ status }) => status)),
];

/** The reason a run is refused, after proving it wrote nothing for the watched people. */
const refusalOf = (
  stage: Stage,
  input: Partial<Parameters<typeof reconcileStageContextBootstraps>[0]>,
  watched: readonly string[],
) =>
  Effect.gen(function* refusalOfEffect() {
    const before = yield* peopleRowsOf(stage, watched);
    const refused = yield* stage.reconcile({ ...emptyRun, ...input }).pipe(Effect.flip);
    expect(yield* peopleRowsOf(stage, watched)).toBe(before);
    return refused.reason;
  });

it.layer(NodeServices.layer)('stage context bootstrap', (suite) => {
  suite.effect('creates the tenant for its owner, its full-access colleague and nobody else', () =>
    withStage((stage) =>
      Effect.gen(function* createsStageTenant() {
        const { tenantId } = stage;
        const results = yield* stage.reconcile({ ...emptyRun, tenants: [tenantBootstrap(tenantId)] }).pipe(failClosed);
        expect(results.map(({ owner: isOwner, principalId }) => ({ owner: isOwner, principalId }))).toEqual([
          { owner: true, principalId: owner },
          { owner: false, principalId: colleague },
          { owner: false, principalId: unassigned },
        ]);
        // The owner holds the release: both the module's capabilities and Core's own.
        for (const carrier of [readCarrier, actionCarrier, coreReadCarrier]) {
          const decision = yield* stage.decide({ carrier, principalId: owner, tenantId });
          expect(decision.outcome).toBe('ALLOWED');
        }
        // The colleague the file names with `full_access` holds it too — a second assignment of the same
        // role in the same scope, which is what the stage bootstrap adds beside the owner's.
        expect((yield* stage.decide({ carrier: readCarrier, principalId: colleague, tenantId })).outcome).toBe(
          'ALLOWED',
        );
        // The negative control: a named account without a role holds nothing, and no member default exists.
        // The stage bootstrap gives it identity rows but no membership, so the gate refuses it at the scope
        // before any grant is read (R5a-1).
        const denied = yield* stage.decide({ carrier: readCarrier, principalId: unassigned, tenantId });
        expect(denied.outcome).toBe('DENIED');
        expect(denied.reasons.map(({ code }) => code)).toContain('deny.scope_mismatch');
        // The tenant is a real scope of the v2 model, not a legacy tuple set.
        const scopes = yield* stage.admin
          .unsafe<{ scope_id: string }>(`select scope_id from core.access_scopes where tenant_id = '${tenantId}'`)
          .pipe(Effect.orDie);
        expect(scopes.map(({ scope_id: scopeId }) => scopeId)).toContain(
          tenantContextScopeId(TenantIdSchema.make(tenantId)),
        );
      }),
    ),
  );

  suite.effect('reconciles an unchanged stage tenant to nothing, so a re-run is a no-op', () =>
    withStage((stage) =>
      Effect.gen(function* reconcilesIdempotently() {
        const { tenantId } = stage;
        yield* stage.reconcile({ ...emptyRun, tenants: [tenantBootstrap(tenantId)] }).pipe(failClosed);
        const scope = yield* scopeFor(tenantId, owner);
        const repeated = yield* stage.project(scope).pipe(failClosed);
        // The intent did not move, so the plan and the graph are equal: nothing is written and the writer
        // records the intent it verified.
        expect(repeated.touches).toBe(0);
        expect(repeated.deletions).toBe(0);
        expect(repeated.verified).toBe(true);
        // Running the whole stage bootstrap again resumes what it wrote instead of adding to it.
        yield* stage.reconcile({ ...emptyRun, tenants: [tenantBootstrap(tenantId)] }).pipe(failClosed);
        const after = yield* stage.project(scope).pipe(failClosed);
        expect(after.touches).toBe(0);
        expect((yield* stage.decide({ carrier: readCarrier, principalId: owner, tenantId })).outcome).toBe('ALLOWED');
      }),
    ),
  );

  suite.effect('a retired stage tenant stops deciding', () =>
    withStage((stage) =>
      Effect.gen(function* retiresTenant() {
        const { tenantId } = stage;
        yield* stage.reconcile({ ...emptyRun, tenants: [tenantBootstrap(tenantId)] }).pipe(failClosed);
        expect((yield* stage.decide({ carrier: readCarrier, principalId: owner, tenantId })).outcome).toBe('ALLOWED');
        // The operator removes the tenant from the file and names it as retired: its memberships and
        // assignments are revoked in intent and the reconcile takes the tuples with them.
        const retired = yield* stage
          .reconcile({
            ...emptyRun,
            retiredTenants: [
              {
                legalEntityId: LegalEntityIdSchema.make(company),
                principalIds: [PrincipalIdSchema.make(owner)],
                tenantId: TenantIdSchema.make(tenantId),
              },
            ],
          })
          .pipe(failClosed);
        expect(retired).toEqual([]);
        // The negative control: nothing of the retired tenant answers any more.
        for (const principalId of [owner, colleague]) {
          const decision = yield* stage.decide({ carrier: readCarrier, principalId, tenantId });
          expect(decision.outcome).toBe('DENIED');
        }
        const counts = yield* stage.admin
          .unsafe<{ count: string }>(
            `select count(*)::text as count from core.access_assignments
             where tenant_id = '${tenantId}' and status = 'active'`,
          )
          .pipe(Effect.orDie);
        expect(counts.map(({ count }) => count)).toEqual(['0']);
      }),
    ),
  );

  suite.effect(
    'an attached login joins holding nothing, and a retired login stops deciding in a tenant that stays',
    () =>
      withStage((stage) =>
        Effect.gen(function* attachesAndRetiresLogins() {
          const { tenantId } = stage;
          yield* stage.reconcile({ ...emptyRun, tenants: [tenantBootstrap(tenantId)] }).pipe(failClosed);
          const attached = uid(6);
          // The operator attaches an existing login to the live tenant: a Principal and a binding, no access.
          yield* stage
            .reconcile({
              ...emptyRun,
              attachedLogins: [
                {
                  authBindingId: uid(14),
                  displayName: 'Attached',
                  principalId: attached,
                  providerUserId: `auth-attached-${tenantId}`,
                  tenantId,
                },
              ],
            })
            .pipe(failClosed);
          const attachedBindings = yield* stage.admin
            .unsafe<{ status: string }>(
              `select status from core.principal_auth_bindings where tenant_id = '${tenantId}' and principal_id = '${attached}'`,
            )
            .pipe(Effect.orDie);
          expect(attachedBindings.map(({ status }) => status)).toEqual(['active']);
          expect((yield* stage.decide({ carrier: readCarrier, principalId: attached, tenantId })).outcome).toBe(
            'DENIED',
          );
          // The colleague's login is retired: its binding, membership and "Plný přístup" end, the tenant stays.
          const retiredColleague = {
            principalId: PrincipalIdSchema.make(colleague),
            providerUserId: `auth-colleague-${tenantId}`,
            tenantId: TenantIdSchema.make(tenantId),
          };
          expect((yield* stage.decide({ carrier: readCarrier, principalId: colleague, tenantId })).outcome).toBe(
            'ALLOWED',
          );
          yield* stage.reconcile({ ...emptyRun, retiredPrincipals: [retiredColleague] }).pipe(failClosed);
          expect((yield* stage.decide({ carrier: readCarrier, principalId: colleague, tenantId })).outcome).toBe(
            'DENIED',
          );
          expect((yield* stage.decide({ carrier: readCarrier, principalId: owner, tenantId })).outcome).toBe('ALLOWED');
          const colleagueRows = yield* stage.admin
            .unsafe<{ binding: string; principal: string }>(
              `select b.status as binding, p.status as principal from core.principal_auth_bindings b
             join core.principals p on p.tenant_id = b.tenant_id and p.principal_id = b.principal_id
             where b.tenant_id = '${tenantId}' and b.principal_id = '${colleague}'`,
            )
            .pipe(Effect.orDie);
          expect(colleagueRows).toEqual([{ binding: 'revoked', principal: 'archived' }]);
          // Re-running the same file changes nothing; retiring the owner is refused and leaves it deciding.
          yield* stage.reconcile({ ...emptyRun, retiredPrincipals: [retiredColleague] }).pipe(failClosed);
          const refused = yield* stage
            .reconcile({
              ...emptyRun,
              retiredPrincipals: [
                {
                  principalId: PrincipalIdSchema.make(owner),
                  providerUserId: `auth-owner-${tenantId}`,
                  tenantId: TenantIdSchema.make(tenantId),
                },
              ],
            })
            .pipe(Effect.flip);
          expect(refused.reason).toMatch(/ownership_transfer_required/u);
          expect((yield* stage.decide({ carrier: readCarrier, principalId: owner, tenantId })).outcome).toBe('ALLOWED');
        }),
      ),
  );

  suite.effect(
    'moves two logins in one transaction, finishes an interrupted run on replay and leaves a bystander as it was',
    () =>
      withStage((stage) =>
        Effect.gen(function* movesLoginsAtomically() {
          const { tenantId } = stage;
          yield* stage
            .reconcile({ ...emptyRun, tenants: [tenantBootstrap(tenantId, [bystanderAccount(tenantId)])] })
            .pipe(failClosed);
          const role = yield* fullAccessRoleOf(stage);
          const delegation = uid(70);
          const delegatedAssignment = uid(71);
          const companyScope = legalEntityScopeId(TenantIdSchema.make(tenantId), LegalEntityIdSchema.make(company));
          // The colleague also holds "Plný přístup" in the company through the bystander's delegation, and every
          // person has a company directory membership.
          yield* seed(
            stage,
            directoryRow(tenantId, colleague),
            directoryRow(tenantId, unassigned),
            directoryRow(tenantId, bystander),
            delegationRow(stage, {
              grantedBy: owner,
              id: delegation,
              manager: bystander,
              people: colleague,
              role: role.role,
            }),
            `insert into core.access_assignments
               (incarnation_id, tenant_id, scope_id, role_id, role_revision_id, principal_id, assigned_by, delegated_by,
                delegation_envelope_json, status, valid_from, valid_until)
             values ('${delegatedAssignment}', '${tenantId}', '${companyScope}', '${role.role}', '${role.revision}',
                     '${colleague}', '${bystander}', '${delegation}',
                     jsonb_build_object('capabilityKeys', jsonb_build_array('${READ}', '${ACTION}', '${CORE_READ}'),
                                        'delegationId', '${delegation}',
                                        'until', '2099-01-01T00:00:00Z'::timestamptz),
                     'active', now() - interval '1 hour', '2099-01-01T00:00:00Z')`,
          );
          const untouched = yield* peopleRowsOf(stage, [owner, bystander]);
          const decidedBefore = yield* outcomesOf(stage, bystander);
          expect(decidedBefore[0]).toBe('ALLOWED');
          const moved = (principalId: string, authBindingId: string, login: string) => ({
            authBindingId,
            displayName: `Moved ${login}`,
            principalId,
            providerUserId: `auth-${login}-${tenantId}`,
            tenantId,
          });
          const run = {
            ...emptyRun,
            attachedLogins: [moved(uid(40), uid(41), 'moved-a'), moved(uid(42), uid(43), 'moved-b')],
            retiredPrincipals: [leaving(tenantId, colleague, 'colleague'), leaving(tenantId, unassigned, 'unassigned')],
          };
          // The run stops after its one transaction committed and before the tenant was projected.
          const interrupted = yield* stage.reconcileInterrupted(run).pipe(Effect.flip);
          expect(interrupted.reason).toMatch(/interrupted after the commit/u);
          const leavers = yield* stage.admin
            .unsafe<StatusRow>(
              `select principal_id::text as person, 'binding' as table, status from core.principal_auth_bindings
                 where tenant_id = '${tenantId}' and principal_id in ('${colleague}', '${unassigned}', '${uid(40)}', '${uid(42)}')
               union all select principal_id::text, 'principal', status from core.principals
                 where tenant_id = '${tenantId}' and principal_id in ('${colleague}', '${unassigned}', '${uid(40)}', '${uid(42)}')
               union all select principal_id::text, 'membership', status from core.access_memberships
                 where tenant_id = '${tenantId}' and principal_id = '${colleague}'
               union all select principal_id::text, 'assignment', status from core.access_assignments
                 where tenant_id = '${tenantId}' and principal_id = '${colleague}'
               union all select principal_id::text, 'directory', status from core.principal_company_memberships
                 where tenant_id = '${tenantId}' and principal_id in ('${colleague}', '${unassigned}')`,
            )
            .pipe(Effect.orDie);
          expect(statusesOf(leavers, colleague, 'binding')).toEqual(['revoked']);
          expect(statusesOf(leavers, colleague, 'principal')).toEqual(['archived']);
          expect(statusesOf(leavers, colleague, 'membership')).toEqual(['revoked']);
          // The delegated assignment ended with the rest; the delegation itself is the bystander's and stays.
          expect(statusesOf(leavers, colleague, 'assignment')).toEqual(['revoked']);
          expect(statusesOf(leavers, colleague, 'directory')).toEqual(['departed']);
          expect(statusesOf(leavers, unassigned, 'binding')).toEqual(['revoked']);
          expect(statusesOf(leavers, unassigned, 'principal')).toEqual(['archived']);
          expect(statusesOf(leavers, unassigned, 'directory')).toEqual(['departed']);
          expect([statusesOf(leavers, uid(40), 'binding'), statusesOf(leavers, uid(42), 'principal')]).toEqual([
            ['active'],
            ['active'],
          ]);
          const delegations = yield* stage.admin
            .unsafe<{ readonly status: string }>(
              `select status from core.access_delegations where tenant_id = '${tenantId}' and delegation_id = '${delegation}'`,
            )
            .pipe(Effect.orDie);
          expect(delegations).toEqual([{ status: 'active' }]);
          const committed = yield* peopleRowsOf(stage, [colleague, unassigned, uid(40), uid(42)]);
          // The same file again finds every move made, writes nothing and projects the tenant.
          yield* stage.reconcile(run).pipe(failClosed);
          expect(yield* peopleRowsOf(stage, [colleague, unassigned, uid(40), uid(42)])).toBe(committed);
          const converged = yield* stage.project(yield* scopeFor(tenantId, owner)).pipe(failClosed);
          expect([converged.touches, converged.deletions, converged.verified]).toEqual([0, 0, true]);
          expect((yield* stage.decide({ carrier: readCarrier, principalId: colleague, tenantId })).outcome).toBe(
            'DENIED',
          );
          // The bystander and the owner keep every row and every decision they had.
          expect(yield* peopleRowsOf(stage, [owner, bystander])).toBe(untouched);
          expect(yield* outcomesOf(stage, bystander)).toEqual(decidedBefore);
          expect((yield* stage.decide({ carrier: readCarrier, principalId: owner, tenantId })).outcome).toBe('ALLOWED');
        }),
      ),
  );

  suite.effect('refuses every departure or attachment it cannot make cleanly and writes nothing for any of them', () =>
    withStage((stage) =>
      Effect.gen(function* refusesUncleanMoves() {
        const { tenantId } = stage;
        yield* stage
          .reconcile({ ...emptyRun, tenants: [tenantBootstrap(tenantId, [bystanderAccount(tenantId)])] })
          .pipe(failClosed);
        const role = yield* fullAccessRoleOf(stage);
        const tenantScope = tenantContextScopeId(TenantIdSchema.make(tenantId));
        const everyone = [owner, colleague, unassigned, bystander, uid(82)];
        const retiringColleague = { retiredPrincipals: [leaving(tenantId, colleague, 'colleague')] };
        // The email names another login than the one bound to the Principal.
        expect(
          yield* refusalOf(stage, { retiredPrincipals: [leaving(tenantId, colleague, 'unassigned')] }, everyone),
        ).toMatch(/login its email names/u);
        // Another credential is bound to the Principal beside the named login.
        yield* seed(
          stage,
          `insert into core.principal_auth_bindings
             (principal_auth_binding_id, tenant_id, principal_id, authentication_namespace_id, provider, subject_type,
              provider_subject_id, status)
           values ('${uid(76)}', '${tenantId}', '${colleague}', 'staff', 'better_auth', 'api_key', 'key-${tenantId}', 'active')`,
        );
        expect(yield* refusalOf(stage, retiringColleague, everyone)).toMatch(/another login or credential/u);
        yield* seed(
          stage,
          `update core.principal_auth_bindings set status = 'revoked', revoked_at = now()
             where principal_auth_binding_id = '${uid(76)}'`,
        );
        // A live delegation the person granted, then one the person manages.
        yield* seed(
          stage,
          delegationRow(stage, {
            grantedBy: colleague,
            id: uid(79),
            manager: bystander,
            people: unassigned,
            role: role.role,
          }),
        );
        expect(yield* refusalOf(stage, retiringColleague, everyone)).toMatch(/live delegation/u);
        yield* seed(stage, `update core.access_delegations set status = 'revoked' where delegation_id = '${uid(79)}'`);
        yield* seed(
          stage,
          delegationRow(stage, {
            grantedBy: owner,
            id: uid(80),
            manager: colleague,
            people: bystander,
            role: role.role,
          }),
        );
        expect(yield* refusalOf(stage, retiringColleague, everyone)).toMatch(/live delegation/u);
        yield* seed(stage, `update core.access_delegations set status = 'revoked' where delegation_id = '${uid(80)}'`);
        // A team place.
        yield* seed(
          stage,
          `insert into core.access_teams (team_id, tenant_id, scope_id, name, created_by)
             values ('${uid(72)}', '${tenantId}', '${tenantScope}', 'Sklad', '${owner}')`,
          `insert into core.access_team_members (team_member_id, tenant_id, team_id, principal_id, added_by, added_at)
             values ('${uid(73)}', '${tenantId}', '${uid(72)}', '${colleague}', '${owner}', now())`,
        );
        expect(yield* refusalOf(stage, retiringColleague, everyone)).toMatch(/team place/u);
        yield* seed(stage, `delete from core.access_team_members where team_member_id = '${uid(73)}'`);
        // An agent connection the person operates.
        yield* seed(
          stage,
          `insert into core.principals (tenant_id, principal_id, kind, display_name, status)
             values ('${tenantId}', '${uid(74)}', 'agent', 'Agent', 'active')`,
          `insert into core.access_agent_connections
             (connection_id, tenant_id, scope_id, agent_id, principal_id, revision, ceiling_json, status, valid_from,
              valid_until)
           values ('${uid(75)}', '${tenantId}', '${tenantScope}', '${uid(74)}', '${colleague}', 1, '{"cells": []}'::jsonb,
                   'active', now() - interval '1 day', now() + interval '1 day')`,
        );
        expect(yield* refusalOf(stage, retiringColleague, everyone)).toMatch(/agent connection/u);
        yield* seed(
          stage,
          `update core.access_agent_connections set status = 'revoked' where connection_id = '${uid(75)}'`,
        );
        // An attachment that would add a login to an existing Principal, or reuse an existing binding.
        const attached = {
          authBindingId: uid(81),
          displayName: 'Unassigned',
          principalId: unassigned,
          providerUserId: `auth-intruder-${tenantId}`,
          tenantId,
        };
        expect(yield* refusalOf(stage, { attachedLogins: [attached] }, everyone)).toMatch(/fresh Principal/u);
        expect(
          yield* refusalOf(
            stage,
            { attachedLogins: [{ ...attached, authBindingId: uid(12), principalId: uid(82) }] },
            everyone,
          ),
        ).toMatch(/fresh Principal/u);
        // One refused entry stops the whole file: the valid attachment and departure beside it are not written.
        expect(
          yield* refusalOf(
            stage,
            {
              attachedLogins: [{ ...attached, principalId: uid(82) }],
              retiredPrincipals: [
                leaving(tenantId, unassigned, 'unassigned'),
                leaving(tenantId, colleague, 'bystander'),
              ],
            },
            everyone,
          ),
        ).toMatch(/login its email names/u);
        // With the obstacles gone the same departure is accepted.
        yield* stage.reconcile({ ...emptyRun, ...retiringColleague }).pipe(failClosed);
        expect((yield* stage.decide({ carrier: readCarrier, principalId: colleague, tenantId })).outcome).toBe(
          'DENIED',
        );
      }),
    ),
  );

  suite.effect('retires a company administrator only while another administrator of the company stays', () =>
    withStage((stage) =>
      Effect.gen(function* retiresCompanyAdministrators() {
        const { tenantId } = stage;
        yield* stage
          .reconcile({ ...emptyRun, tenants: [tenantBootstrap(tenantId, [bystanderAccount(tenantId)])] })
          .pipe(failClosed);
        const companyScope = legalEntityScopeId(TenantIdSchema.make(tenantId), LegalEntityIdSchema.make(company));
        const tenantScope = tenantContextScopeId(TenantIdSchema.make(tenantId));
        // The colleague and the bystander administer the company; the owner is suspended, so neither of them
        // has the owner as a successor.
        yield* seed(
          stage,
          `insert into core.access_memberships
             (membership_id, tenant_id, scope_id, principal_id, kind, status, valid_from, recorded_by)
           values ('${uid(77)}', '${tenantId}', '${companyScope}', '${colleague}', 'access_admin', 'active',
                   now() - interval '1 day', '${owner}'),
                  ('${uid(78)}', '${tenantId}', '${companyScope}', '${bystander}', 'access_admin', 'active',
                   now() - interval '1 day', '${owner}')`,
          `update core.access_memberships set status = 'suspended'
             where tenant_id = '${tenantId}' and principal_id = '${owner}' and scope_id = '${tenantScope}' and kind = 'member'`,
        );
        // The bystander stays to administer the company, so the colleague may leave, administration included.
        yield* stage
          .reconcile({ ...emptyRun, retiredPrincipals: [leaving(tenantId, colleague, 'colleague')] })
          .pipe(failClosed);
        const administration = yield* stage.admin
          .unsafe<{ readonly status: string }>(
            `select status from core.access_memberships where membership_id = '${uid(77)}'`,
          )
          .pipe(Effect.orDie);
        expect(administration).toEqual([{ status: 'revoked' }]);
        // Now the bystander is the company's last administrator and has no successor.
        const before = yield* peopleRowsOf(stage, [bystander]);
        const refused = yield* stage
          .reconcile({ ...emptyRun, retiredPrincipals: [leaving(tenantId, bystander, 'bystander')] })
          .pipe(Effect.flip);
        expect(refused.reason).toMatch(/ownership_transfer_required/u);
        expect(yield* peopleRowsOf(stage, [bystander])).toBe(before);
      }),
    ),
  );
});
