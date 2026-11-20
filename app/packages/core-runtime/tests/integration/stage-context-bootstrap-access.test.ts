import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Clock, Context, Crypto, DateTime, Deferred, Effect, Fiber, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

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
import {
  STAGE_RETIREMENT_REASON,
  completedStageRetirementsOf,
  reconcileStageContextBootstraps,
} from '../../src/install/stage-context-bootstrap.ts';
import type {
  StageAccountIdentity,
  StageContextBootstrapRun,
  StageRetiredConnectedApp,
  StageTenantBootstrap,
} from '../../src/install/stage-context-bootstrap.ts';
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
  /** The connected apps of the file's departures an earlier run completed, as the Shell reads them before the run. */
  readonly completed: (
    retiredPrincipals: Parameters<typeof reconcileStageContextBootstraps>[0]['retiredPrincipals'],
  ) => Effect.Effect<readonly StageRetiredConnectedApp[], StageFailure>;
  /** One protected capability of the release, asked the way an entrypoint asks it. */
  readonly decide: (input: {
    readonly carrier: { readonly accessDeclaration: ReturnType<typeof decodeAccessDeclarationOrThrow> };
    readonly principalId: string;
    readonly tenantId: string;
  }) => Effect.Effect<AccessDecision>;
  /** A second random tenant of the case, for a login that moves between tenants. */
  readonly destinationTenantId: string;
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
  ) => Effect.Effect<StageContextBootstrapRun, StageFailure>;
  /** The same run, stopped after its intent committed: the single writer never gets to project it. */
  readonly reconcileInterrupted: (
    input: Parameters<typeof reconcileStageContextBootstraps>[0],
  ) => Effect.Effect<StageContextBootstrapRun, StageFailure>;
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
    // Room for a case that parks one transaction, lets two writers wait behind a run and still polls the database.
    const admin = yield* makeTestPgClient(replacedDatabase(connections.admin.connectionString, database), {
      maxConnections: 6,
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
      completed: (retiredPrincipals) =>
        completedStageRetirementsOf(retiredPrincipals, INSTALLATION_OPTIONS).pipe(
          Effect.mapError(asStageFailure),
          Effect.provide(context),
        ),
      decide: ({ carrier, principalId, tenantId }) =>
        Effect.flatMap(scopeFor(tenantId, principalId), (scope) =>
          gate.decide({ carrier, legalEntityScope: 'forbidden', now: decisionAt, scope }),
        ).pipe(Effect.provide(context)),
      destinationTenantId: yield* crypto.randomUUIDv4(),
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

/**
 * One connected app of a person as the product leaves it: the OAuth grant that acts as them and its `oauth_grant`
 * binding, naming each other. A connection revoked in the product is a `revoked` grant whose binding the revocation
 * only disabled, by the person with reason `user` unless `revokedBy` names an administrator's revocation; a live one is
 * `active` on both and was last used yesterday. Seeding writes no audit event.
 */
const connectedApp = (
  stage: Stage,
  input: {
    readonly binding: string;
    readonly grant: string;
    readonly live: boolean;
    readonly person: string;
    /** Who revoked a connection that is not live, and why; the person with reason `user` when absent. */
    readonly revokedBy?: { readonly by: string; readonly reason: 'admin' | 'user' };
    /** Another tenant and company than the case's own, for a person of the destination tenant. */
    readonly where?: { readonly legalEntityId: string; readonly tenantId: string };
  },
) => {
  const { legalEntityId, tenantId } = input.where ?? { legalEntityId: company, tenantId: stage.tenantId };
  const client = input.grant.slice(-3);
  const revokedBy = input.revokedBy ?? { by: input.person, reason: 'user' };
  const ended = input.live
    ? { at: 'null', by: 'null', reason: 'null', status: 'active' }
    : { at: "now() - interval '2 days'", by: `'${revokedBy.by}'`, reason: `'${revokedBy.reason}'`, status: 'revoked' };
  return [
    `insert into core.oauth_connection_grants
       (grant_id, tenant_id, legal_entity_id, user_id, user_principal_id, acting_principal_id, acting_kind, client_id,
        client_name, client_host, client_kind, modules_json, write_policy, profile_id, auth_binding_id, status,
        consented_at, last_used_at, revoked_at, revoked_by_principal_id, revoke_reason)
     values ('${input.grant}', '${tenantId}', '${legalEntityId}', 'better-auth-${input.person}', '${input.person}',
             '${input.person}', 'human', 'https://client-${client}.example/metadata', 'Client ${client}',
             'client-${client}.example', 'cimd', '"all"'::jsonb, 'direct', gen_random_uuid(), '${input.binding}',
             '${ended.status}', now() - interval '10 days', now() - interval '1 day', ${ended.at}, ${ended.by},
             ${ended.reason})`,
    `insert into core.principal_auth_bindings
       (principal_auth_binding_id, tenant_id, principal_id, authentication_namespace_id, provider, subject_type,
        provider_subject_id, status)
     values ('${input.binding}', '${tenantId}', '${input.person}', 'staff', 'better_auth', 'oauth_grant',
             '${input.grant}', '${input.live ? 'active' : 'disabled'}')`,
  ];
};

/** Every grant of the person, as one text: who ended it, why and how it stands. */
const grantRowsOf = (stage: Stage, principalId: string) =>
  stage.admin
    .unsafe<{
      readonly id: string;
      readonly reason: string | null;
      readonly revoked_by: string | null;
      readonly status: string;
    }>(
      `select grant_id::text as id, status, revoke_reason as reason, revoked_by_principal_id::text as revoked_by
         from core.oauth_connection_grants where tenant_id = '${stage.tenantId}' and acting_principal_id = '${principalId}'
        order by 1`,
    )
    .pipe(Effect.orDie);

/** Every `oauth.connection.revoked` event of the case's tenant, by grant: every column the product's writer fills. */
const revocationEventsOf = (stage: Stage) =>
  stage.admin
    .unsafe<{
      readonly actor: string | null;
      readonly audit_profile: string;
      readonly auth_binding: string | null;
      readonly auth_context_ref: string | null;
      readonly auth_method: string;
      readonly company: string;
      readonly evidence: unknown;
      readonly grant: string | null;
      readonly invocation: string | null;
      readonly outcome: string;
      readonly outcome_code: string;
      readonly outcome_stage: string;
      readonly target_module_key: string | null;
      readonly target_resource_type: string | null;
    }>(
      `select target_resource_id as grant, principal_id::text as actor, legal_entity_id::text as company,
              auth_method, auth_binding_id::text as auth_binding, auth_context_ref,
              action_invocation_id::text as invocation, outcome, outcome_code, outcome_stage, audit_profile,
              target_module_key, target_resource_type, evidence_json as evidence
         from core.audit_events where tenant_id = '${stage.tenantId}' and event_type = 'oauth.connection.revoked'
        order by 1`,
    )
    .pipe(Effect.orDie);

/**
 * The event the run records for a connected app it moved from `active` to `revoked`: the product's administrator
 * revocation (`finishRevocation`), by the acting owner in the app's company, reason `admin`, with the bootstrap's note.
 */
const revocationEvent = (app: { readonly grant: string; readonly person: string }) => ({
  actor: owner,
  audit_profile: 'sensitive',
  auth_binding: null,
  auth_context_ref: null,
  auth_method: 'session',
  company,
  evidence: {
    clientId: `https://client-${app.grant.slice(-3)}.example/metadata`,
    clientName: `Client ${app.grant.slice(-3)}`,
    grantId: app.grant,
    note: STAGE_RETIREMENT_REASON,
    reason: 'admin',
    revokedByPrincipalId: owner,
    userPrincipalId: app.person,
  },
  grant: app.grant,
  invocation: null,
  outcome: 'succeeded',
  outcome_code: 'admin',
  outcome_stage: 'execution',
  target_module_key: 'core.identity',
  target_resource_type: 'oauth_connection_grant',
});

/** The person's bindings by kind: how many there are of each status and revision. */
const bindingSummaryOf = (stage: Stage, principalId: string) =>
  stage.admin
    .unsafe<{ readonly count: number; readonly revision: number; readonly status: string; readonly subject: string }>(
      `select subject_type as subject, status, binding_revision as revision, count(*)::int as count
         from core.principal_auth_bindings where tenant_id = '${stage.tenantId}' and principal_id = '${principalId}'
        group by 1, 2, 3 order by 1, 2, 3`,
    )
    .pipe(Effect.orDie);

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

/** The full-access account of one further person the operator file names. */
const fullAccessAccount = (
  tenantId: string,
  principalId: string,
  authBindingId: string,
  login: string,
): StageAccountIdentity => ({
  authBindingId,
  displayName: login,
  owner: false,
  principalId,
  providerUserId: `auth-${login}-${tenantId}`,
  roles: ['full_access'],
});

const dispatcher = uid(8);
const other = uid(9);
const pendingPerson = uid(10);

/**
 * The tenant a login moves to, as AKROS is: its own owner, company and ids, so nothing of it collides with the
 * tenant the login leaves (Principals and companies are keyed globally).
 */
const destinationBootstrap = (tenantId: string): StageTenantBootstrap => ({
  accounts: [
    {
      authBindingId: uid(111),
      displayName: 'Destination owner',
      owner: true,
      principalId: uid(102),
      providerUserId: `auth-destination-owner-${tenantId}`,
      roles: [],
    },
  ],
  tenant: {
    defaultLocale: 'cs',
    displayName: 'Destination tenant',
    legalEntity: {
      legalEntityId: uid(105),
      legalName: 'Destination s.r.o.',
      registrationCountry: 'CZ',
      registrationNumber: 'STAGE-0002',
    },
    moduleKey: MODULE,
    moduleStateId: uid(121),
    slug: `destination-${tenantId.slice(-4)}`,
    tenantId,
  },
});

/** The colleague and the bystander administer the company beside the owner, as two e-shop logins do. */
const companyAdministrators = (stage: Stage) =>
  `insert into core.access_memberships
     (membership_id, tenant_id, scope_id, principal_id, kind, status, valid_from, valid_until, recorded_by)
   values ('${uid(77)}', '${stage.tenantId}', '${legalEntityScopeId(TenantIdSchema.make(stage.tenantId), LegalEntityIdSchema.make(company))}',
           '${colleague}', 'access_admin', 'active', now() - interval '1 day', null, '${owner}'),
          ('${uid(78)}', '${stage.tenantId}', '${legalEntityScopeId(TenantIdSchema.make(stage.tenantId), LegalEntityIdSchema.make(company))}',
           '${bystander}', 'access_admin', 'active', now() - interval '1 day', null, '${owner}')`;

/** The company's access scope in the case's tenant. */
const companyScopeOf = (stage: Stage) =>
  legalEntityScopeId(TenantIdSchema.make(stage.tenantId), LegalEntityIdSchema.make(company));

/** One person administers the company: an `access_admin` row that started yesterday and does not end. */
const companyAdministrator = (stage: Stage, principalId: string, membershipId: string) =>
  `insert into core.access_memberships
     (membership_id, tenant_id, scope_id, principal_id, kind, status, valid_from, valid_until, recorded_by)
   values ('${membershipId}', '${stage.tenantId}', '${companyScopeOf(stage)}',
           '${principalId}', 'access_admin', 'active', now() - interval '1 day', null, '${owner}')`;

/**
 * Suspends the owner's own membership of the company. The owner still owns the tenant and still reaches it, and People
 * still counts them among the company's administrators, but the suspension subtracts their administration there.
 */
const suspendOwnerInCompany = (stage: Stage) =>
  stage.admin
    .unsafe<{ readonly id: string }>(
      `update core.access_memberships set status = 'suspended'
         where tenant_id = '${stage.tenantId}' and principal_id = '${owner}' and kind = 'member'
           and status = 'active' and scope_id = '${companyScopeOf(stage)}'
       returning membership_id::text as id`,
    )
    .pipe(
      Effect.orDie,
      Effect.flatMap((rows) =>
        rows.length === 1
          ? Effect.void
          : Effect.die(new Error(`the owner held ${rows.length} active company memberships to suspend`)),
      ),
    );

/** The owner's tenant member path is suspended (or resumed): a suspended owner administers nothing and acts for nobody. */
const ownerPath = (stage: Stage, status: 'active' | 'suspended') =>
  `update core.access_memberships set status = '${status}'
     where tenant_id = '${stage.tenantId}' and principal_id = '${owner}' and kind = 'member' and status <> 'revoked'
       and scope_id = '${tenantContextScopeId(TenantIdSchema.make(stage.tenantId))}'`;

/** The owner's Principal disabled or active again: only an active person acts as the tenant owner. */
const ownerStatus = (stage: Stage, status: 'active' | 'disabled') =>
  `update core.principals set status = '${status}', disabled_at = ${status === 'disabled' ? 'now()' : 'null'}
     where tenant_id = '${stage.tenantId}' and principal_id = '${owner}'`;

const timestampOf = (millis: number) => `to_timestamp(${millis} / 1000.0)`;

/**
 * Replaces the owner's tenant ownership with one row of the given period, as a time-boxed ownership is recorded: the
 * bootstrap's open-ended row is ended first, since a person holds one live row of a kind per scope.
 */
const ownershipFor = (stage: Stage, period: { readonly from: number; readonly until?: number }) => [
  `update core.access_memberships set status = 'revoked', ended_at = now(), ended_by = '${owner}'
     where tenant_id = '${stage.tenantId}' and principal_id = '${owner}' and kind = 'owner' and status <> 'revoked'`,
  `insert into core.access_memberships
     (membership_id, tenant_id, scope_id, principal_id, kind, status, valid_from, valid_until, recorded_by)
   values ('${uid(86)}', '${stage.tenantId}', '${tenantContextScopeId(TenantIdSchema.make(stage.tenantId))}',
           '${owner}', 'owner', 'active', ${timestampOf(period.from)},
           ${period.until === undefined ? 'null' : timestampOf(period.until)}, '${owner}')`,
];

/** The period of the owner's replacing ownership row, in epoch milliseconds, as the database stored it. */
const ownershipPeriodOf = (stage: Stage) =>
  stage.admin
    .unsafe<{ readonly from: string; readonly until: string | null }>(
      `select floor(extract(epoch from valid_from) * 1000)::bigint::text as from,
              floor(extract(epoch from valid_until) * 1000)::bigint::text as until
         from core.access_memberships where membership_id = '${uid(86)}'`,
    )
    .pipe(
      Effect.orDie,
      Effect.flatMap(([row]) =>
        row === undefined
          ? Effect.die(new Error('the owner holds no replacing ownership row'))
          : Effect.succeed({ from: Number(row.from), until: row.until === null ? undefined : Number(row.until) }),
      ),
    );

/**
 * Runs a case on a clock of its own, started at the database's clock: only the case moves it, so a decision time is
 * exactly where the case put it however slowly the run goes. Every case that seeds a row with the database's `now()`
 * and lets a run decide on it runs here: the suite's default test clock stands at the epoch, where such a row has not
 * started yet, so a departure would neither end it nor count it as anybody's administration. The body is the case's
 * effect, or a function of the time its clock started at.
 */
const onDatabaseClock = <Value, Failure>(
  stage: Stage,
  body: Effect.Effect<Value, Failure> | ((startedAt: number) => Effect.Effect<Value, Failure>),
) =>
  Effect.gen(function* onDatabaseClockEffect() {
    const clock = yield* TestClock.make();
    const [row] = yield* stage.admin
      .unsafe<{ readonly ms: string }>(`select floor(extract(epoch from clock_timestamp()) * 1000)::bigint::text as ms`)
      .pipe(Effect.orDie);
    const startedAt = Number(row?.ms);
    yield* clock.setTime(startedAt);
    return yield* (Effect.isEffect(body) ? body : body(startedAt)).pipe(Effect.provideService(Clock.Clock, clock));
  }).pipe(Effect.scoped);

/**
 * How many backends of the case's database wait on a lock another transaction holds. The query pauses on the server
 * first, so polling it paces itself without an Effect timer.
 */
const blockedBackends = (stage: Stage) =>
  stage.admin
    .unsafe<{ readonly blocked: number }>(
      `select count(*)::int as blocked from pg_stat_activity, pg_sleep(0.02)
        where datname = current_database() and cardinality(pg_blocking_pids(pid)) > 0`,
    )
    .pipe(
      Effect.map(([row]) => row?.blocked ?? 0),
      Effect.orDie,
    );

/**
 * Polls, for at most about ten seconds, until a backend running `statement` waits on a lock the backend `holder`
 * holds: the one transaction a case parks, not any wait of the database.
 */
const untilBlockedBy = (stage: Stage, holder: number, statement: string, attempts = 500): Effect.Effect<void> =>
  stage.admin
    .unsafe<{ readonly blocked: number }>(
      `select count(*)::int as blocked from pg_stat_activity, pg_sleep(0.02)
        where datname = current_database() and ${holder} = any(pg_blocking_pids(pid))
          and position('${statement}' in lower(query)) > 0`,
    )
    .pipe(
      Effect.orDie,
      Effect.flatMap(([row]) => {
        if ((row?.blocked ?? 0) > 0) {
          return Effect.void;
        }
        return attempts > 1
          ? untilBlockedBy(stage, holder, statement, attempts - 1)
          : Effect.die(new Error(`no "${statement}" ever waited on backend ${holder}`));
      }),
    );

/**
 * Starts `run` and, once it waits on the share lock behind the backend `holder`, moves the case's clock to `to`: the
 * run takes its decision time only after that lock is released.
 */
const startThenMoveClock =
  <Value, Failure>(stage: Stage, run: Effect.Effect<Value, Failure>, to: number) =>
  (holder: number) =>
    Effect.gen(function* startThenMoveClockEffect() {
      const running = yield* Effect.forkChild(run);
      yield* untilBlockedBy(stage, holder, 'for share');
      yield* TestClock.setTime(to);
      return running;
    });

/** Polls, for at most about ten seconds, until at least `count` backends wait on a lock. */
const untilBlocked = (stage: Stage, count: number, attempts = 500): Effect.Effect<void> =>
  blockedBackends(stage).pipe(
    Effect.flatMap((blocked) => {
      if (blocked >= count) {
        return Effect.void;
      }
      return attempts > 1
        ? untilBlocked(stage, count, attempts - 1)
        : Effect.die(new Error(`${count} backends never waited on a lock`));
    }),
  );

/**
 * Runs `body` while another transaction holds what `lock` takes, then lets that transaction commit. The body sees the
 * lock held from its first statement, is handed the backend that holds it when it asks, and the lock is released
 * however the body ends.
 */
const whileHolding = <Value, Failure>(
  stage: Stage,
  lock: string,
  body: Effect.Effect<Value, Failure> | ((holder: number) => Effect.Effect<Value, Failure>),
) =>
  Effect.gen(function* whileHoldingEffect() {
    const held = yield* Deferred.make<number>();
    const release = yield* Deferred.make<null>();
    const holder = yield* Effect.forkChild(
      stage.admin
        .withTransaction(
          Effect.gen(function* holdLock() {
            const [backend] = yield* stage.admin.unsafe<{ readonly pid: number }>('select pg_backend_pid() as pid');
            yield* stage.admin.unsafe(lock);
            yield* Deferred.succeed(held, backend?.pid ?? 0);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.orDie),
    );
    const backend = yield* Deferred.await(held);
    const value = yield* (Effect.isEffect(body) ? body : body(backend)).pipe(
      Effect.flatMap((result) => Effect.as(Deferred.succeed(release, null), result)),
      Effect.ensuring(Deferred.succeed(release, null)),
    );
    yield* Fiber.join(holder);
    return value;
  });

it.layer(NodeServices.layer)('stage context bootstrap', (suite) => {
  suite.effect('creates the tenant for its owner, its full-access colleague and nobody else', () =>
    withStage((stage) =>
      Effect.gen(function* createsStageTenant() {
        const { tenantId } = stage;
        const results = yield* stage.reconcile({ ...emptyRun, tenants: [tenantBootstrap(tenantId)] }).pipe(failClosed);
        expect(results.accounts.map(({ owner: isOwner, principalId }) => ({ owner: isOwner, principalId }))).toEqual([
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
        expect(retired).toEqual({ accounts: [], connectedApps: [], moves: { attachments: [], departures: [] } });
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
          expect(refused.reason).toMatch(/tenant owner is never retired/u);
          expect((yield* stage.decide({ carrier: readCarrier, principalId: owner, tenantId })).outcome).toBe('ALLOWED');
        }),
      ),
  );

  suite.effect(
    'moves two logins in one transaction, finishes an interrupted run on replay and leaves a bystander as it was',
    () =>
      withStage((stage) =>
        onDatabaseClock(
          stage,
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
              retiredPrincipals: [
                leaving(tenantId, colleague, 'colleague'),
                leaving(tenantId, unassigned, 'unassigned'),
              ],
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
            // Before the rerun, the person of a login the run attached connects an app, so that Principal now holds a
            // binding no run wrote. The rerun still recognises its own attachment by the Principal and binding ids the
            // file names, whatever else that Principal gained.
            yield* seed(
              stage,
              ...connectedApp(stage, { binding: uid(45), grant: uid(44), live: true, person: uid(40) }),
            );
            const committed = yield* peopleRowsOf(stage, [colleague, unassigned, uid(40), uid(42)]);
            expect(committed).toContain(uid(45));
            // The same file again finds every move made, writes nothing and projects the tenant.
            const rerun = yield* stage.reconcile(run).pipe(failClosed);
            expect(rerun.moves.attachments.map(({ created }) => created)).toEqual([false, false]);
            expect(rerun.moves.departures.map(({ archives }) => archives)).toEqual([false, false]);
            expect(yield* peopleRowsOf(stage, [colleague, unassigned, uid(40), uid(42)])).toBe(committed);
            const converged = yield* stage.project(yield* scopeFor(tenantId, owner)).pipe(failClosed);
            expect([converged.touches, converged.deletions, converged.verified]).toEqual([0, 0, true]);
            expect((yield* stage.decide({ carrier: readCarrier, principalId: colleague, tenantId })).outcome).toBe(
              'DENIED',
            );
            // The bystander and the owner keep every row and every decision they had.
            expect(yield* peopleRowsOf(stage, [owner, bystander])).toBe(untouched);
            expect(yield* outcomesOf(stage, bystander)).toEqual(decidedBefore);
            expect((yield* stage.decide({ carrier: readCarrier, principalId: owner, tenantId })).outcome).toBe(
              'ALLOWED',
            );
          }),
        ),
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
        // The login's binding is only historical: revoked while the Principal stays active, so it signs in to nothing.
        yield* seed(
          stage,
          `update core.principal_auth_bindings set status = 'revoked', revoked_at = now()
             where principal_auth_binding_id = '${uid(12)}'`,
        );
        expect(yield* refusalOf(stage, retiringColleague, everyone)).toMatch(/live binding of the login/u);
        yield* seed(
          stage,
          `update core.principal_auth_bindings set status = 'active', revoked_at = null
             where principal_auth_binding_id = '${uid(12)}'`,
        );
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
        // A co-owner is a tenant owner too: ownership moves only through People, never through the operator file.
        yield* seed(
          stage,
          `insert into core.access_memberships
             (membership_id, tenant_id, scope_id, principal_id, kind, status, valid_from, recorded_by)
           values ('${uid(84)}', '${tenantId}', '${tenantScope}', '${colleague}', 'owner', 'active',
                   now() - interval '1 day', '${owner}')`,
        );
        expect(yield* refusalOf(stage, retiringColleague, everyone)).toMatch(/tenant owner is never retired/u);
        yield* seed(stage, `update core.access_memberships set status = 'revoked' where membership_id = '${uid(84)}'`);
        // With the obstacles gone the same departure is accepted.
        yield* stage.reconcile({ ...emptyRun, ...retiringColleague }).pipe(failClosed);
        expect((yield* stage.decide({ carrier: readCarrier, principalId: colleague, tenantId })).outcome).toBe(
          'DENIED',
        );
      }),
    ),
  );

  suite.effect('retires a company administrator only through a tenant owner who still reaches the tenant', () =>
    withStage((stage) =>
      onDatabaseClock(stage, () =>
        Effect.gen(function* retiresThroughALiveOwner() {
          const { tenantId } = stage;
          yield* stage
            .reconcile({ ...emptyRun, tenants: [tenantBootstrap(tenantId, [bystanderAccount(tenantId)])] })
            .pipe(failClosed);
          yield* seed(stage, companyAdministrators(stage));
          const retiringColleague = { retiredPrincipals: [leaving(tenantId, colleague, 'colleague')] };
          const watched = [owner, colleague, bystander];
          // An owner whose tenant path is suspended administers nothing, so no accountable identity would act.
          yield* seed(stage, ownerPath(stage, 'suspended'));
          expect(yield* refusalOf(stage, retiringColleague, watched)).toMatch(/has 0 live owners/u);
          yield* seed(stage, ownerPath(stage, 'active'));
          // A disabled owner is no person who acts, whatever their membership rows say.
          yield* seed(stage, ownerStatus(stage, 'disabled'));
          expect(yield* refusalOf(stage, retiringColleague, watched)).toMatch(/has 0 live owners/u);
          yield* seed(stage, ownerStatus(stage, 'active'));
          // The owner acts and stays, so the colleague may leave, administration included.
          yield* stage.reconcile({ ...emptyRun, ...retiringColleague }).pipe(failClosed);
          const administration = yield* stage.admin
            .unsafe<{ readonly ended_by: string; readonly ended_reason: string; readonly status: string }>(
              `select status, ended_by::text as ended_by, ended_reason from core.access_memberships
                where membership_id = '${uid(77)}'`,
            )
            .pipe(Effect.orDie);
          // The history names the tenant owner acting through the bootstrap, never the person who left.
          expect(administration).toEqual([
            { ended_by: owner, ended_reason: STAGE_RETIREMENT_REASON, status: 'revoked' },
          ]);
          // The acting owner administers every company of the tenant, so the bystander is never its last
          // administrator: they leave too, and the owner keeps the company.
          yield* stage
            .reconcile({ ...emptyRun, retiredPrincipals: [leaving(tenantId, bystander, 'bystander')] })
            .pipe(failClosed);
          const principalRows = yield* stage.admin
            .unsafe<{ readonly person: string; readonly status: string }>(
              `select principal_id::text as person, status from core.principals
                where tenant_id = '${tenantId}' and principal_id in ('${owner}', '${bystander}') order by 1`,
            )
            .pipe(Effect.orDie);
          expect(principalRows).toEqual([
            { person: owner, status: 'active' },
            { person: bystander, status: 'archived' },
          ]);
        }),
      ),
    ),
  );

  suite.effect(
    'refuses, writing nothing, a departure that leaves a company only to a tenant owner suspended in it',
    () =>
      withStage((stage) =>
        onDatabaseClock(
          stage,
          Effect.gen(function* refusesSuspendedOwnerAsSuccessor() {
            const { tenantId } = stage;
            yield* stage
              .reconcile({ ...emptyRun, tenants: [tenantBootstrap(tenantId, [bystanderAccount(tenantId)])] })
              .pipe(failClosed);
            // The colleague is the company's only administrator; the owner still owns and reaches the tenant but is
            // suspended in the company, so nobody who stays administers it.
            yield* seed(stage, companyAdministrator(stage, colleague, uid(77)));
            yield* suspendOwnerInCompany(stage);
            const retiringColleague = { retiredPrincipals: [leaving(tenantId, colleague, 'colleague')] };
            const watched = [owner, colleague, bystander];
            const refused = yield* refusalOf(stage, retiringColleague, watched);
            expect(refused).toMatch(/^stage_last_administrator: /u);
            expect(refused).toContain(companyScopeOf(stage));
            // Another effective administrator of the company who stays lets the same file run.
            yield* seed(stage, companyAdministrator(stage, bystander, uid(78)));
            yield* stage.reconcile({ ...emptyRun, ...retiringColleague }).pipe(failClosed);
            const rows = yield* stage.admin
              .unsafe<{ readonly id: string; readonly status: string }>(
                `select 'membership ' || membership_id::text as id, status from core.access_memberships
                  where membership_id in ('${uid(77)}', '${uid(78)}')
                 union all select 'principal ' || principal_id::text, status from core.principals
                  where tenant_id = '${tenantId}' and principal_id in ('${colleague}', '${bystander}')
                 order by 1`,
              )
              .pipe(Effect.orDie);
            expect(rows).toEqual([
              { id: `membership ${uid(77)}`, status: 'revoked' },
              { id: `membership ${uid(78)}`, status: 'active' },
              { id: `principal ${colleague}`, status: 'archived' },
              { id: `principal ${bystander}`, status: 'active' },
            ]);
          }),
        ),
      ),
  );

  suite.effect(
    'refuses a file whose two leavers are each the only successor the other would leave, and lets either leave alone',
    () =>
      withStage((stage) =>
        onDatabaseClock(
          stage,
          Effect.gen(function* refusesMutualSuccessors() {
            const { tenantId } = stage;
            yield* stage
              .reconcile({ ...emptyRun, tenants: [tenantBootstrap(tenantId, [bystanderAccount(tenantId)])] })
              .pipe(failClosed);
            // Both administer the company and the owner is suspended in it: each leaver alone leaves the other, but the
            // file excludes every leaver, so together they leave nobody.
            yield* seed(stage, companyAdministrators(stage));
            yield* suspendOwnerInCompany(stage);
            const retiringColleague = { retiredPrincipals: [leaving(tenantId, colleague, 'colleague')] };
            const refused = yield* refusalOf(
              stage,
              {
                retiredPrincipals: [...retiringColleague.retiredPrincipals, leaving(tenantId, bystander, 'bystander')],
              },
              [owner, colleague, bystander],
            );
            expect(refused).toMatch(/^stage_last_administrator: /u);
            expect(refused).toContain(companyScopeOf(stage));
            // Each administrator is effective on their own: the colleague leaves alone, and the bystander who stays
            // keeps administering the company.
            yield* stage.reconcile({ ...emptyRun, ...retiringColleague }).pipe(failClosed);
            const rows = yield* stage.admin
              .unsafe<{ readonly id: string; readonly status: string }>(
                `select 'membership ' || membership_id::text as id, status from core.access_memberships
                  where membership_id in ('${uid(77)}', '${uid(78)}')
                 union all select 'principal ' || principal_id::text, status from core.principals
                  where tenant_id = '${tenantId}' and principal_id in ('${colleague}', '${bystander}')
                 order by 1`,
              )
              .pipe(Effect.orDie);
            expect(rows).toEqual([
              { id: `membership ${uid(77)}`, status: 'revoked' },
              { id: `membership ${uid(78)}`, status: 'active' },
              { id: `principal ${colleague}`, status: 'archived' },
              { id: `principal ${bystander}`, status: 'active' },
            ]);
          }),
        ),
      ),
  );

  suite.effect(
    'moves two logins between tenants in one file as the AKROS run does, and the same file again changes nothing',
    () =>
      withStage((stage) =>
        onDatabaseClock(
          stage,
          Effect.gen(function* movesLikeTheAkrosRun() {
            const { destinationTenantId: destination, tenantId } = stage;
            yield* stage
              .reconcile({
                ...emptyRun,
                tenants: [
                  destinationBootstrap(destination),
                  tenantBootstrap(tenantId, [
                    bystanderAccount(tenantId),
                    fullAccessAccount(tenantId, dispatcher, uid(18), 'dispatcher'),
                    fullAccessAccount(tenantId, other, uid(19), 'other'),
                    fullAccessAccount(tenantId, pendingPerson, uid(20), 'pending'),
                  ]),
                ],
              })
              .pipe(failClosed);
            // The e-shop login (colleague) and the one who stays (bystander) administer the company, like
            // eshop@akros.demo and eshop@sroubarna.demo; the dispatcher is the expedice login; other is unrelated.
            yield* seed(
              stage,
              directoryRow(tenantId, colleague),
              directoryRow(tenantId, bystander),
              directoryRow(tenantId, dispatcher),
              directoryRow(tenantId, other),
              companyAdministrators(stage),
              // The e-shop login's one live connection in the tenant it leaves.
              ...connectedApp(stage, { binding: uid(151), grant: uid(150), live: true, person: colleague }),
              // A bystander's access change that a People command committed and never projected.
              `update core.access_assignments set status = 'revoked'
                 where tenant_id = '${tenantId}' and principal_id = '${pendingPerson}' and status = 'active'`,
            );
            const stays = [owner, bystander, other];
            const untouched = yield* peopleRowsOf(stage, stays);
            const decidedBefore = yield* Effect.all([outcomesOf(stage, bystander), outcomesOf(stage, other)], {
              concurrency: 1,
            });
            expect(decidedBefore.map(([readOutcome]) => readOutcome)).toEqual(['ALLOWED', 'ALLOWED']);
            const moved = (principalId: string, authBindingId: string, login: string) => ({
              authBindingId,
              displayName: `Destination ${login}`,
              principalId,
              providerUserId: `auth-${login}-${tenantId}`,
              tenantId: destination,
            });
            const operatorFile = {
              ...emptyRun,
              attachedLogins: [moved(uid(140), uid(141), 'colleague'), moved(uid(142), uid(143), 'dispatcher')],
              retiredPrincipals: [
                leaving(tenantId, colleague, 'colleague'),
                leaving(tenantId, dispatcher, 'dispatcher'),
              ],
            };
            yield* stage.reconcile(operatorFile).pipe(failClosed);
            // Each login signs in to the destination as a fresh Principal of its own, holding nothing yet.
            const destinationRows = () =>
              stage.admin
                .unsafe<{
                  readonly binding: string;
                  readonly person: string;
                  readonly principal: string;
                  readonly subject: string;
                }>(
                  `select p.principal_id::text as person, p.status as principal, b.status as binding,
                          b.provider_subject_id as subject
                     from core.principals p
                     join core.principal_auth_bindings b on b.tenant_id = p.tenant_id and b.principal_id = p.principal_id
                    where p.tenant_id = '${destination}' and p.principal_id in ('${uid(140)}', '${uid(142)}')
                    order by 1, b.principal_auth_binding_id`,
                )
                .pipe(Effect.orDie);
            const attached = yield* destinationRows();
            expect(attached).toEqual([
              { binding: 'active', person: uid(140), principal: 'active', subject: `auth-colleague-${tenantId}` },
              { binding: 'active', person: uid(142), principal: 'active', subject: `auth-dispatcher-${tenantId}` },
            ]);
            // Both leave the old tenant whole, and every row their departures ended names the tenant owner acting
            // through the bootstrap, never the person who left.
            const left = yield* stage.admin
              .unsafe<StatusRow>(
                `select principal_id::text as person, 'binding' as table, status from core.principal_auth_bindings
                   where tenant_id = '${tenantId}' and principal_id in ('${colleague}', '${dispatcher}')
                 union all select principal_id::text, 'principal', status from core.principals
                   where tenant_id = '${tenantId}' and principal_id in ('${colleague}', '${dispatcher}')
                 union all select principal_id::text, 'membership', status from core.access_memberships
                   where tenant_id = '${tenantId}' and principal_id in ('${colleague}', '${dispatcher}')
                 union all select principal_id::text, 'assignment', status from core.access_assignments
                   where tenant_id = '${tenantId}' and principal_id in ('${colleague}', '${dispatcher}')
                 union all select principal_id::text, 'directory', status from core.principal_company_memberships
                   where tenant_id = '${tenantId}' and principal_id in ('${colleague}', '${dispatcher}')`,
              )
              .pipe(Effect.orDie);
            for (const person of [colleague, dispatcher]) {
              expect([
                statusesOf(left, person, 'binding'),
                statusesOf(left, person, 'principal'),
                statusesOf(left, person, 'membership'),
                statusesOf(left, person, 'assignment'),
                statusesOf(left, person, 'directory'),
              ]).toEqual([['revoked'], ['archived'], ['revoked'], ['revoked'], ['departed']]);
              expect((yield* stage.decide({ carrier: readCarrier, principalId: person, tenantId })).outcome).toBe(
                'DENIED',
              );
            }
            const endings = yield* stage.admin
              .unsafe<{ readonly ended_by: string | null; readonly ended_reason: string | null }>(
                `select distinct ended_by::text as ended_by, ended_reason from core.access_memberships
                  where tenant_id = '${tenantId}' and principal_id in ('${colleague}', '${dispatcher}')`,
              )
              .pipe(Effect.orDie);
            expect(endings).toEqual([{ ended_by: owner, ended_reason: STAGE_RETIREMENT_REASON }]);
            // The administrator who stays, the owner and the unrelated person keep every row and every decision.
            expect(yield* peopleRowsOf(stage, stays)).toBe(untouched);
            expect(
              yield* Effect.all([outcomesOf(stage, bystander), outcomesOf(stage, other)], { concurrency: 1 }),
            ).toEqual(decidedBefore);
            // The reconcile is the single writer's and projects the tenant whole: the bystander's change that was
            // committed but never projected is published by this run too. DEPLOYMENT.md tells the operator to check
            // for such changes before the run.
            expect((yield* outcomesOf(stage, pendingPerson))[0]).toBe('DENIED');
            const projected = yield* stage.project(yield* scopeFor(tenantId, owner)).pipe(failClosed);
            expect([projected.touches, projected.deletions, projected.verified]).toEqual([0, 0, true]);
            // The same file again finds both moves made, writes nothing and reconciles to nothing.
            const everyone = [owner, colleague, unassigned, bystander, dispatcher, other, pendingPerson];
            const settled = yield* peopleRowsOf(stage, everyone);
            yield* stage.reconcile(operatorFile).pipe(failClosed);
            expect(yield* peopleRowsOf(stage, everyone)).toBe(settled);
            expect(yield* destinationRows()).toEqual(attached);
            const converged = yield* stage.project(yield* scopeFor(tenantId, owner)).pipe(failClosed);
            expect([converged.touches, converged.deletions, converged.verified]).toEqual([0, 0, true]);
            // The moved login then connects an app in the destination, so its Principal there holds a second binding.
            // The same file is still the replay of its attachment, found by the Principal and binding ids it names: it
            // writes nothing and reconciles to nothing. The departure it completed still hands its connected app to the
            // Shell's clean-up, so a run that stopped before that clean-up is finished by the same file.
            yield* seed(
              stage,
              ...connectedApp(stage, {
                binding: uid(153),
                grant: uid(152),
                live: true,
                person: uid(140),
                where: { legalEntityId: uid(105), tenantId: destination },
              }),
            );
            const reconnected = yield* destinationRows();
            expect(reconnected).toEqual([
              ...attached.slice(0, 1),
              { binding: 'active', person: uid(140), principal: 'active', subject: uid(152) },
              ...attached.slice(1),
            ]);
            const replayed = yield* stage.reconcile(operatorFile).pipe(failClosed);
            expect(replayed.moves.attachments.map(({ created }) => created)).toEqual([false, false]);
            expect(yield* peopleRowsOf(stage, everyone)).toBe(settled);
            expect(yield* destinationRows()).toEqual(reconnected);
            const reconciled = yield* stage.project(yield* scopeFor(tenantId, owner)).pipe(failClosed);
            expect([reconciled.touches, reconciled.deletions, reconciled.verified]).toEqual([0, 0, true]);
            const completed = yield* stage.completed(operatorFile.retiredPrincipals).pipe(failClosed);
            expect(
              completed.map(({ endedByThisRun, grantId, principalId, tenantId: at }) => ({
                at,
                endedByThisRun,
                grantId,
                principalId,
              })),
            ).toEqual([{ at: tenantId, endedByThisRun: false, grantId: uid(150), principalId: colleague }]);
            // The run recorded its revocation once, in its own transaction; the refused file and this read add none.
            expect(yield* revocationEventsOf(stage)).toEqual([revocationEvent({ grant: uid(150), person: colleague })]);
          }),
        ),
      ),
  );

  suite.effect(
    'a personal key or agent connection added to a leaver waits for the departure, which revokes only what it read',
    () =>
      withStage((stage) =>
        Effect.gen(function* serializesLateWriters() {
          const { tenantId } = stage;
          yield* stage.reconcile({ ...emptyRun, tenants: [tenantBootstrap(tenantId)] }).pipe(failClosed);
          const tenantScope = tenantContextScopeId(TenantIdSchema.make(tenantId));
          const agent = uid(90);
          yield* seed(
            stage,
            directoryRow(tenantId, colleague),
            `insert into core.principals (tenant_id, principal_id, kind, display_name, status)
             values ('${tenantId}', '${agent}', 'agent', 'Agent', 'active')`,
          );
          const retiringColleague = { ...emptyRun, retiredPrincipals: [leaving(tenantId, colleague, 'colleague')] };
          // Another transaction holds the colleague's directory row, so the departure decides, writes its People plan
          // and then waits there with every lock it took still held.
          const [departure, key, connection] = yield* whileHolding(
            stage,
            `select 1 from core.principal_company_memberships
            where tenant_id = '${tenantId}' and principal_id = '${colleague}' for update`,
            Effect.gen(function* lateWriters() {
              const running = yield* Effect.forkChild(stage.reconcile(retiringColleague));
              yield* untilBlocked(stage, 1);
              // A personal key and an agent connection for the leaver, written while the departure holds its decision.
              const lateKey = yield* Effect.forkChild(
                stage.admin
                  .unsafe(
                    `insert into core.principal_auth_bindings
                     (principal_auth_binding_id, tenant_id, principal_id, authentication_namespace_id, provider,
                      subject_type, provider_subject_id, status)
                   values ('${uid(91)}', '${tenantId}', '${colleague}', 'staff', 'better_auth', 'api_key',
                           'late-key-${tenantId}', 'active')`,
                  )
                  .pipe(Effect.orDie),
              );
              const lateConnection = yield* Effect.forkChild(
                stage.admin
                  .unsafe(
                    `insert into core.access_agent_connections
                     (connection_id, tenant_id, scope_id, agent_id, principal_id, revision, ceiling_json, status,
                      valid_from, valid_until)
                   values ('${uid(92)}', '${tenantId}', '${tenantScope}', '${agent}', '${colleague}', 1,
                           '{"cells": []}'::jsonb, 'active', now() - interval '1 day', now() + interval '1 day')`,
                  )
                  .pipe(Effect.orDie),
              );
              // Both wait behind the departure: their foreign keys need the Principal row it locked.
              yield* untilBlocked(stage, 3);
              return [running, lateKey, lateConnection] as const;
            }),
          );
          yield* Fiber.join(departure).pipe(failClosed);
          yield* Effect.all([Fiber.join(key), Fiber.join(connection)], { concurrency: 2 });
          const bindings = yield* stage.admin
            .unsafe<{ readonly id: string; readonly revision: number; readonly status: string }>(
              `select principal_auth_binding_id::text as id, binding_revision as revision, status
               from core.principal_auth_bindings where tenant_id = '${tenantId}' and principal_id = '${colleague}'
              order by 1`,
            )
            .pipe(Effect.orDie);
          // The departure revoked exactly the binding it read; the key that waited for it was never part of it.
          expect(bindings).toEqual([
            { id: uid(12), revision: 2, status: 'revoked' },
            { id: uid(91), revision: 1, status: 'active' },
          ]);
          const late = yield* stage.admin
            .unsafe<{ readonly connection: string; readonly principal: string }>(
              `select c.status as connection, p.status as principal from core.access_agent_connections c
               join core.principals p on p.tenant_id = c.tenant_id and p.principal_id = c.principal_id
              where c.connection_id = '${uid(92)}'`,
            )
            .pipe(Effect.orDie);
          expect(late).toEqual([{ connection: 'active', principal: 'archived' }]);
          // The file again does not guess: the credential it never decided on stops it.
          expect(yield* refusalOf(stage, retiringColleague, [colleague])).toMatch(/another login or credential/u);
        }),
      ),
  );

  suite.effect(
    'decides at the time it holds every lock: an ownership that runs out while the run waits counts for nobody',
    () =>
      withStage((stage) =>
        onDatabaseClock(stage, (startedAt) =>
          Effect.gen(function* decidesAtLockTime() {
            const { tenantId } = stage;
            yield* stage.reconcile({ ...emptyRun, tenants: [tenantBootstrap(tenantId)] }).pipe(failClosed);
            // The owner's ownership runs out five seconds of the case's own clock from now; that clock moves only when the
            // case moves it, so a slow run cannot let the ownership run out before the departure waits.
            yield* seed(stage, ...ownershipFor(stage, { from: startedAt - 86_400_000, until: startedAt + 5000 }));
            const period = yield* ownershipPeriodOf(stage);
            const expiresAt = period.until ?? Number.POSITIVE_INFINITY;
            // Before the departure starts, the owner still owns the tenant: otherwise this case proves nothing.
            const before = yield* Clock.currentTimeMillis;
            expect(period.from <= before && before < expiresAt).toBe(true);
            const watched = [owner, colleague];
            const untouched = yield* peopleRowsOf(stage, watched);
            // Another transaction holds the owner's Principal row, so the departure takes the People lock, the colleague's
            // rows and then waits exactly on the share lock of its administrators, before it takes the decision time.
            // The departure now waits on that row; its clock moves past the ownership's end, then the row is released.
            const departure = yield* whileHolding(
              stage,
              `select 1 from core.principals where tenant_id = '${tenantId}' and principal_id = '${owner}' for update`,
              startThenMoveClock(
                stage,
                stage.reconcile({ ...emptyRun, retiredPrincipals: [leaving(tenantId, colleague, 'colleague')] }),
                expiresAt + 1,
              ),
            );
            expect(yield* Clock.currentTimeMillis).toBeGreaterThan(expiresAt);
            const refused = yield* Fiber.join(departure).pipe(Effect.flip);
            expect(refused.reason).toMatch(/has 0 live owners/u);
            expect(yield* peopleRowsOf(stage, watched)).toBe(untouched);
          }),
        ),
      ),
  );

  suite.effect('an ownership that has not started yet makes nobody the owner a departure acts through', () =>
    withStage((stage) =>
      onDatabaseClock(stage, (startedAt) =>
        Effect.gen(function* decidesOnStartedOwnership() {
          const { tenantId } = stage;
          yield* stage.reconcile({ ...emptyRun, tenants: [tenantBootstrap(tenantId)] }).pipe(failClosed);
          // The owner's only ownership starts an hour from the case's clock.
          const startsAt = startedAt + 3_600_000;
          yield* seed(stage, ...ownershipFor(stage, { from: startsAt }));
          expect((yield* ownershipPeriodOf(stage)).from).toBeGreaterThan(yield* Clock.currentTimeMillis);
          const retiringColleague = { retiredPrincipals: [leaving(tenantId, colleague, 'colleague')] };
          expect(yield* refusalOf(stage, retiringColleague, [owner, colleague])).toMatch(/has 0 live owners/u);
          // Once it has started, the same file retires the colleague through that owner.
          yield* TestClock.setTime(startsAt);
          yield* stage.reconcile({ ...emptyRun, ...retiringColleague }).pipe(failClosed);
          const left = yield* stage.admin
            .unsafe<{ readonly status: string }>(
              `select status from core.principals where tenant_id = '${tenantId}' and principal_id = '${colleague}'`,
            )
            .pipe(Effect.orDie);
          expect(left).toEqual([{ status: 'archived' }]);
        }),
      ),
    ),
  );

  suite.effect('plans the second leaver of a tenant on every write of the first, an ended delegation included', () =>
    withStage((stage) =>
      Effect.gen(function* plansOnEveryWrite() {
        const { tenantId } = stage;
        yield* stage
          .reconcile({ ...emptyRun, tenants: [tenantBootstrap(tenantId, [bystanderAccount(tenantId)])] })
          .pipe(failClosed);
        const role = yield* fullAccessRoleOf(stage);
        const companyScope = legalEntityScopeId(TenantIdSchema.make(tenantId), LegalEntityIdSchema.make(company));
        // A delegation the colleague manages ran out yesterday but was never revoked: it blocks nothing, and the
        // colleague's departure ends it, which moves the People revision the bystander's departure is planned on.
        yield* seed(
          stage,
          `insert into core.access_delegations
             (delegation_id, tenant_id, scope_id, granted_by, manager_id, people, role_ids, capability_keys,
              amount_ceiling_json, status, valid_from, until)
           values ('${uid(85)}', '${tenantId}', '${companyScope}', '${owner}', '${colleague}',
                   array['${bystander}'::uuid], array['${role.role}'::uuid],
                   array['${READ}', '${ACTION}', '${CORE_READ}'], null, 'active',
                   now() - interval '2 days', now() - interval '1 day')`,
        );
        yield* stage
          .reconcile({
            ...emptyRun,
            retiredPrincipals: [leaving(tenantId, colleague, 'colleague'), leaving(tenantId, bystander, 'bystander')],
          })
          .pipe(TestClock.withLive, failClosed);
        const rows = yield* stage.admin
          .unsafe<{ readonly kind: string; readonly status: string }>(
            `select 'delegation' as kind, status from core.access_delegations where delegation_id = '${uid(85)}'
             union all select 'principal ' || principal_id::text, status from core.principals
              where tenant_id = '${tenantId}' and principal_id in ('${colleague}', '${bystander}')
             order by 1`,
          )
          .pipe(Effect.orDie);
        expect(rows).toEqual([
          { kind: 'delegation', status: 'revoked' },
          { kind: `principal ${colleague}`, status: 'archived' },
          { kind: `principal ${bystander}`, status: 'archived' },
        ]);
      }),
    ),
  );

  suite.effect(
    'retires a person with connected apps as the AKROS e-shop login is: ends the live one, revokes every grant binding and replays to nothing',
    () =>
      withStage((stage) =>
        onDatabaseClock(
          stage,
          Effect.gen(function* retiresWithConnectedApps() {
            const { tenantId } = stage;
            yield* stage
              .reconcile({ ...emptyRun, tenants: [tenantBootstrap(tenantId, [bystanderAccount(tenantId)])] })
              .pipe(failClosed);
            // The e-shop login administers the company beside the bystander and has its directory row, five connections
            // it revoked in the product (their bindings only disabled) and one still live, used yesterday.
            const revokedApps = [1, 2, 3, 4, 5].map((n) => ({
              binding: uid(210 + n),
              grant: uid(200 + n),
              live: false,
              person: colleague,
            }));
            const liveApp = { binding: uid(216), grant: uid(206), live: true, person: colleague };
            yield* seed(
              stage,
              directoryRow(tenantId, colleague),
              companyAdministrators(stage),
              ...[...revokedApps, liveApp].flatMap((app) => connectedApp(stage, app)),
            );
            const untouched = yield* peopleRowsOf(stage, [owner, bystander]);
            const operatorFile = { ...emptyRun, retiredPrincipals: [leaving(tenantId, colleague, 'colleague')] };
            const run = yield* stage.reconcile(operatorFile).pipe(failClosed);
            // The run reports every connected app of the leaver and ended exactly the live one.
            expect(
              run.connectedApps.map(({ endedByThisRun, grantId, principalId }) => ({
                endedByThisRun,
                grantId,
                principalId,
              })),
            ).toEqual(
              [...revokedApps, liveApp].map(({ grant, live }) => ({
                endedByThisRun: live,
                grantId: grant,
                principalId: colleague,
              })),
            );
            // The run recorded the product's revocation event of exactly the app it moved from active to revoked, by
            // the owner, in the transaction that revoked it; the five the person revoked get none.
            expect(yield* revocationEventsOf(stage)).toEqual([revocationEvent(liveApp)]);
            // The live connection ended as an administrator ends somebody else's, attributed to the acting owner; the
            // five the person revoked keep their own history.
            expect(yield* grantRowsOf(stage, colleague)).toEqual([
              ...revokedApps.map(({ grant }) => ({
                id: grant,
                reason: 'user',
                revoked_by: colleague,
                status: 'revoked',
              })),
              { id: liveApp.grant, reason: 'admin', revoked_by: owner, status: 'revoked' },
            ]);
            // Every binding is revoked by compare-and-set at the revision it was read: the login's and all six grants'.
            expect(yield* bindingSummaryOf(stage, colleague)).toEqual([
              { count: 6, revision: 2, status: 'revoked', subject: 'oauth_grant' },
              { count: 1, revision: 2, status: 'revoked', subject: 'user' },
            ]);
            const principalRows = yield* stage.admin
              .unsafe<{ readonly status: string }>(
                `select status from core.principals where tenant_id = '${tenantId}' and principal_id = '${colleague}'`,
              )
              .pipe(Effect.orDie);
            expect(principalRows).toEqual([{ status: 'archived' }]);
            expect((yield* stage.decide({ carrier: readCarrier, principalId: colleague, tenantId })).outcome).toBe(
              'DENIED',
            );
            expect(yield* peopleRowsOf(stage, [owner, bystander])).toBe(untouched);
            // The same file again finds the departure made: it ends nothing, writes nothing and reports nothing ended.
            const settled = yield* peopleRowsOf(stage, [colleague]);
            const grantsSettled = yield* grantRowsOf(stage, colleague);
            const again = yield* stage.reconcile(operatorFile).pipe(failClosed);
            // The replay ends nothing, so it records nothing: the one event stays the only one.
            expect(again.connectedApps.map(({ endedByThisRun }) => endedByThisRun)).toEqual(
              [...revokedApps, liveApp].map(() => false),
            );
            expect(yield* revocationEventsOf(stage)).toEqual([revocationEvent(liveApp)]);
            // Before the run, the same departure is read as completed and hands over the same apps.
            const completed = yield* stage.completed(operatorFile.retiredPrincipals).pipe(failClosed);
            expect(completed.map(({ grantId }) => grantId)).toEqual(again.connectedApps.map(({ grantId }) => grantId));
            expect(yield* peopleRowsOf(stage, [colleague])).toBe(settled);
            expect(yield* grantRowsOf(stage, colleague)).toEqual(grantsSettled);
          }),
        ),
      ),
  );

  suite.effect(
    'retires a person with no membership, only a directory row and three connections they revoked, as expedice is',
    () =>
      withStage((stage) =>
        onDatabaseClock(
          stage,
          Effect.gen(function* retiresWithoutMemberships() {
            const { tenantId } = stage;
            yield* stage.reconcile({ ...emptyRun, tenants: [tenantBootstrap(tenantId)] }).pipe(failClosed);
            // The unassigned account holds no membership at all: only its directory row and three connections it revoked
            // in the product, whose bindings the revocation only disabled.
            const apps = [1, 2, 3].map((n) => ({
              binding: uid(230 + n),
              grant: uid(220 + n),
              live: false,
              person: unassigned,
            }));
            yield* seed(stage, directoryRow(tenantId, unassigned), ...apps.flatMap((app) => connectedApp(stage, app)));
            const memberships = yield* stage.admin
              .unsafe<{ readonly count: number }>(
                `select count(*)::int as count from core.access_memberships
                  where tenant_id = '${tenantId}' and principal_id = '${unassigned}'`,
              )
              .pipe(Effect.orDie);
            expect(memberships).toEqual([{ count: 0 }]);
            const grantsBefore = yield* grantRowsOf(stage, unassigned);
            expect(grantsBefore.map(({ status }) => status)).toEqual(['revoked', 'revoked', 'revoked']);
            const untouched = yield* peopleRowsOf(stage, [owner, colleague]);
            const operatorFile = { ...emptyRun, retiredPrincipals: [leaving(tenantId, unassigned, 'unassigned')] };
            const run = yield* stage.reconcile(operatorFile).pipe(failClosed);
            // Nothing was live, so nothing is ended and nothing recorded; each disabled grant binding is revoked with
            // the login's.
            expect(run.connectedApps.map(({ endedByThisRun, grantId }) => ({ endedByThisRun, grantId }))).toEqual(
              apps.map(({ grant }) => ({ endedByThisRun: false, grantId: grant })),
            );
            expect(yield* revocationEventsOf(stage)).toEqual([]);
            expect(yield* grantRowsOf(stage, unassigned)).toEqual(grantsBefore);
            expect(yield* bindingSummaryOf(stage, unassigned)).toEqual([
              { count: 3, revision: 2, status: 'revoked', subject: 'oauth_grant' },
              { count: 1, revision: 2, status: 'revoked', subject: 'user' },
            ]);
            const left = yield* stage.admin
              .unsafe<{ readonly kind: string; readonly status: string }>(
                `select 'directory' as kind, status from core.principal_company_memberships
                  where tenant_id = '${tenantId}' and principal_id = '${unassigned}'
                 union all select 'principal', status from core.principals
                  where tenant_id = '${tenantId}' and principal_id = '${unassigned}'
                 order by 1`,
              )
              .pipe(Effect.orDie);
            expect(left).toEqual([
              { kind: 'directory', status: 'departed' },
              { kind: 'principal', status: 'archived' },
            ]);
            expect(yield* peopleRowsOf(stage, [owner, colleague])).toBe(untouched);
            // The same file again changes nothing.
            const settled = yield* peopleRowsOf(stage, [unassigned]);
            yield* stage.reconcile(operatorFile).pipe(failClosed);
            expect(yield* peopleRowsOf(stage, [unassigned])).toBe(settled);
            expect(yield* grantRowsOf(stage, unassigned)).toEqual(grantsBefore);
          }),
        ),
      ),
  );
  suite.effect(
    'refuses, writing nothing, to end a connected app in a company the acting owner is suspended in, and ends it once the owner administers it again',
    () =>
      withStage((stage) =>
        onDatabaseClock(
          stage,
          Effect.gen(function* refusesUnadministeredConnectedApp() {
            const { tenantId } = stage;
            yield* stage
              .reconcile({ ...emptyRun, tenants: [tenantBootstrap(tenantId, [bystanderAccount(tenantId)])] })
              .pipe(failClosed);
            // The colleague administers nothing and has one live connection in the company. The owner still owns and
            // reaches the tenant but is suspended in the company, so they do not administer it and may not end
            // somebody else's connection there.
            const liveApp = { binding: uid(246), grant: uid(236), live: true, person: colleague };
            yield* seed(stage, directoryRow(tenantId, colleague), ...connectedApp(stage, liveApp));
            yield* suspendOwnerInCompany(stage);
            const operatorFile = { retiredPrincipals: [leaving(tenantId, colleague, 'colleague')] };
            const grantsBefore = yield* grantRowsOf(stage, colleague);
            const bindingsBefore = yield* bindingSummaryOf(stage, colleague);
            const refused = yield* refusalOf(stage, operatorFile, [owner, colleague, bystander]);
            expect(refused).toMatch(/^stage_connected_app_not_administered: /u);
            expect(refused).toContain('Client 236 (https://client-236.example/metadata)');
            expect(refused).toContain(`company ${company}`);
            expect(yield* grantRowsOf(stage, colleague)).toEqual(grantsBefore);
            expect(yield* bindingSummaryOf(stage, colleague)).toEqual(bindingsBefore);
            expect(yield* revocationEventsOf(stage)).toEqual([]);
            // The owner's company membership resumed, the owner administers the company and the same file ends the app.
            yield* seed(
              stage,
              `update core.access_memberships set status = 'active'
                 where tenant_id = '${tenantId}' and principal_id = '${owner}' and kind = 'member'
                   and status = 'suspended' and scope_id = '${companyScopeOf(stage)}'`,
            );
            yield* stage.reconcile({ ...emptyRun, ...operatorFile }).pipe(failClosed);
            expect(yield* grantRowsOf(stage, colleague)).toEqual([
              { id: liveApp.grant, reason: 'admin', revoked_by: owner, status: 'revoked' },
            ]);
            expect(yield* bindingSummaryOf(stage, colleague)).toEqual([
              { count: 1, revision: 2, status: 'revoked', subject: 'oauth_grant' },
              { count: 1, revision: 2, status: 'revoked', subject: 'user' },
            ]);
            expect(yield* revocationEventsOf(stage)).toEqual([revocationEvent(liveApp)]);
          }),
        ),
      ),
  );

  suite.effect(
    'records no event for an older administrator revocation that never had one, only for the app the run itself ends',
    () =>
      withStage((stage) =>
        onDatabaseClock(
          stage,
          Effect.gen(function* recordsOnlyItsOwnRevocation() {
            const { tenantId } = stage;
            yield* stage.reconcile({ ...emptyRun, tenants: [tenantBootstrap(tenantId)] }).pipe(failClosed);
            // The owner revoked one of the colleague's connections as an administrator two days ago, and no event of it
            // was ever written; the other connection is still live.
            const olderApp = {
              binding: uid(256),
              grant: uid(255),
              live: false,
              person: colleague,
              revokedBy: { by: owner, reason: 'admin' as const },
            };
            const liveApp = { binding: uid(258), grant: uid(257), live: true, person: colleague };
            yield* seed(
              stage,
              directoryRow(tenantId, colleague),
              ...connectedApp(stage, olderApp),
              ...connectedApp(stage, liveApp),
            );
            expect(yield* revocationEventsOf(stage)).toEqual([]);
            const operatorFile = { ...emptyRun, retiredPrincipals: [leaving(tenantId, colleague, 'colleague')] };
            const run = yield* stage.reconcile(operatorFile).pipe(failClosed);
            expect(run.connectedApps.map(({ endedByThisRun, grantId }) => ({ endedByThisRun, grantId }))).toEqual([
              { endedByThisRun: false, grantId: olderApp.grant },
              { endedByThisRun: true, grantId: liveApp.grant },
            ]);
            expect(yield* grantRowsOf(stage, colleague)).toEqual([
              { id: olderApp.grant, reason: 'admin', revoked_by: owner, status: 'revoked' },
              { id: liveApp.grant, reason: 'admin', revoked_by: owner, status: 'revoked' },
            ]);
            // Only the grant this run moved from active to revoked is recorded; the older administrator revocation, as
            // revoked and as attributed as the new one, is not the run's and gets no event, on a first run or later.
            expect(yield* revocationEventsOf(stage)).toEqual([revocationEvent(liveApp)]);
            yield* stage.reconcile(operatorFile).pipe(failClosed);
            const completed = yield* stage.completed(operatorFile.retiredPrincipals).pipe(failClosed);
            expect(completed.map(({ grantId }) => grantId)).toEqual([olderApp.grant, liveApp.grant]);
            expect(yield* revocationEventsOf(stage)).toEqual([revocationEvent(liveApp)]);
          }),
        ),
      ),
  );
});
