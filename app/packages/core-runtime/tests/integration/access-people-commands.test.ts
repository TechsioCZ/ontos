import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Context, Crypto, DateTime, Deferred, Effect, Fiber, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { AccessEnforcementPortsLive } from '../../src/actions/runtime-wiring.ts';
import { TenantAccessBootstrap, TenantAccessBootstrapLive } from '../../src/access/bootstrap/index.ts';
import { compileFullAccessRole } from '../../src/access/bootstrap/full-access-role.ts';
import { buildAccessCatalogRelease } from '../../src/access/catalog/release.ts';
import { legalEntityScopeId, tenantContextScopeId } from '../../src/access/bootstrap/persistence.ts';
import { AccessChangesStoreLive } from '../../src/access/changes/persistence/drizzle-store.ts';
import { AccessChangesStore } from '../../src/access/changes/persistence/store.ts';
import { writeRoleCreation } from '../../src/access/changes/role-revision.ts';
import {
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '../../src/access/compiler/spice-db-compiler.ts';
import type { AccessDecision } from '../../src/access/decision/contract.ts';
import { AccessDecisionGate } from '../../src/access/enforcement/contract.ts';
import { AccessDecisionLive } from '../../src/access/enforcement/service.ts';
import {
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
  DelegationIdSchema,
  LegalEntityIdSchema,
  ModuleKeySchema,
  PrincipalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import type {
  AssignmentIncarnationId,
  LegalEntityId,
  PrincipalId,
  RoleId,
  RoleRevisionId,
  TenantId,
} from '../../src/access/ids.ts';
import type { CatalogSnapshot, CatalogSnapshotEntry, Cell } from '../../src/access/model.ts';
import { AssignmentSchema } from '../../src/access/model.ts';
import { AccessCatalogSnapshotWriterLive } from '../../src/access/intent/catalog-snapshot-writer.ts';
import { AccessMembershipStoreLive } from '../../src/access/intent/memberships.ts';
import { AccessPeopleStore, AccessPeopleStoreLive } from '../../src/access/intent/people-store.ts';
import { AccessProjectionCompiler } from '../../src/access/intent/projection-compiler.ts';
import { AccessProjectionWriter, AccessProjectionWriterLive } from '../../src/access/intent/projection-writer.ts';
import { AccessTeamStore, makeAccessTeamDrizzleStore } from '../../src/access/intent/teams.ts';
import { TenantIntentLoaderLive } from '../../src/access/intent/tenant-intent-loader.ts';
import { AccessWriteJournalStoreLive } from '../../src/access/lifecycle/persistence/journal-store.ts';
import { AccessPeopleCommands, AccessPeopleCommandsLive } from '../../src/access/lifecycle/people-service.ts';
import type { GrantDelegationCommand } from '../../src/access/lifecycle/people-service.ts';
import { decodeAccessDeclarationOrThrow } from '../../src/authorization/access-declaration.ts';
import type { AccessCatalogModule, AccessDeclarationInput } from '../../src/authorization/access-declaration.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { coreRelations } from '../../src/db/schema.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';
import { newSpiceDbGrpcClient } from '../../src/permissions/spicedb-grpc-rpc.ts';
import {
  createTemplateDatabase,
  insertTenantStatement,
  replacedDatabase,
} from '../support/access-scenarios/database.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';

/*
 * The people commands (`lifecycle/people-service.ts`) on the real stores, the single projection writer and
 * the real gate. A role the owner creates and then assigns through the people commands grants its cells
 * once reconciled, because the assignment writes the role's grant incarnations in its scope; and a
 * delegation is granted by the acting person to the manager it names, never by a person to themselves.
 */
const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

const MODULE = 'desk.notes';
const NOTE_READ = 'desk.notes.note.read';
const NOTE_DELETE = 'desk.notes.note.delete';
const NOTE_ARCHIVE = 'desk.notes.note.archive';

const entrypoint = (key: string, access: 'read' | 'write') =>
  defineTenantModuleEntrypoint({
    access,
    authorization: { kind: 'protected' },
    entrypointKey: key,
    moduleKey: MODULE,
    role: access === 'read' ? 'api' : 'action',
  });
const declaration = (key: string, kind: 'action' | 'read'): AccessDeclarationInput => ({
  key,
  kind,
  modes: kind === 'read' ? ['run'] : ['run', 'propose'],
  placement: { group: 'desk', level: 'basic' },
  risk: 'sensitive',
  selectors: [],
});

const noteRead = declaration(NOTE_READ, 'read');
const noteDelete = declaration(NOTE_DELETE, 'action');
const noteReadEntrypoint = entrypoint('desk.notes.api.note-read', 'read');
const noteDeleteEntrypoint = entrypoint('desk.notes.note-delete', 'write');
const modules: readonly AccessCatalogModule[] = [
  {
    descriptors: [
      { accessDeclaration: noteRead, entrypoint: noteReadEntrypoint },
      { accessDeclaration: noteDelete, entrypoint: noteDeleteEntrypoint },
    ],
    moduleId: MODULE,
  },
];
/** The module's next release: everything it published before, plus one new action. */
const nextModules: readonly AccessCatalogModule[] = [
  {
    descriptors: [
      ...modules.flatMap(({ descriptors }) => descriptors),
      {
        accessDeclaration: declaration(NOTE_ARCHIVE, 'action'),
        entrypoint: entrypoint('desk.notes.note-archive', 'write'),
      },
    ],
    moduleId: MODULE,
  },
];
const noteReadCarrier = { accessDeclaration: decodeAccessDeclarationOrThrow(noteRead, noteReadEntrypoint) };
const noteDeleteCarrier = { accessDeclaration: decodeAccessDeclarationOrThrow(noteDelete, noteDeleteEntrypoint) };

const owner = PrincipalIdSchema.make(uid(2));
const colleague = PrincipalIdSchema.make(uid(3));
const teammate = PrincipalIdSchema.make(uid(4));
const company = LegalEntityIdSchema.make(uid(6));

/** The tenant as the product creates it: identity rows and one installed module, never any access. */
const seedTenant = (admin: PgClient.PgClient, tenantId: TenantId) =>
  Effect.forEach(
    [
      insertTenantStatement(tenantId),
      `insert into core.legal_entities
         (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status) values
         ('${company}', '${tenantId}', 'Kancelář s.r.o.', 'CZ', '12345678', 'active')`,
      `insert into core.principals (tenant_id, principal_id, kind, display_name, status) values
         ('${tenantId}', '${owner}', 'human', 'Vlastník', 'active'),
         ('${tenantId}', '${colleague}', 'human', 'Kolegyně', 'active'),
         ('${tenantId}', '${teammate}', 'human', 'Kolega', 'active')`,
      `insert into core.tenant_module_states (tenant_module_state_id, tenant_id, module_key, state) values
         ('${uid(8)}', '${tenantId}', '${MODULE}', 'active')`,
    ],
    (statement) => admin.unsafe(statement).pipe(Effect.orDie),
    { concurrency: 1, discard: true },
  );

/** The owner made both colleagues members of the tenant and the company before any of this. */
const seedMembers = (admin: PgClient.PgClient, tenantId: TenantId) =>
  admin
    .unsafe(
      `insert into core.access_memberships
         (membership_id, tenant_id, scope_id, principal_id, kind, status, valid_from, recorded_by) values
         ('${uid(20)}', '${tenantId}', '${tenantContextScopeId(tenantId)}', '${colleague}', 'member', 'active',
          now() - interval '1 day', '${owner}'),
         ('${uid(21)}', '${tenantId}', '${legalEntityScopeId(tenantId, company)}', '${colleague}', 'member', 'active',
          now() - interval '1 day', '${owner}'),
         ('${uid(22)}', '${tenantId}', '${tenantContextScopeId(tenantId)}', '${teammate}', 'member', 'active',
          now() - interval '1 day', '${owner}'),
         ('${uid(23)}', '${tenantId}', '${legalEntityScopeId(tenantId, company)}', '${teammate}', 'member', 'active',
          now() - interval '1 day', '${owner}')`,
    )
    .pipe(Effect.orDie);

/** One trusted request scope: the acting principal, the tenant and, when given, the selected company (O66). */
const scopeFor = (tenantId: TenantId, principalId: PrincipalId, legalEntityId?: LegalEntityId) => {
  const session = {
    authBindingId: uid(300),
    authContextRef: 'session:access-people-commands:1',
    authMethod: 'session' as const,
    principalId,
    tenantId,
  };
  return Schema.decodeEffect(TrustedPrincipalContextSchema)(
    legalEntityId === undefined ? session : { ...session, legalEntityId },
  ).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'access-people-commands' }) satisfies OperationalScope),
    Effect.orDie,
  );
};

interface Tenant {
  readonly admin: PgClient.PgClient;
  /** The cells the full-access role compiles for one capability of the first release. */
  readonly cellsOf: (capabilityKey: string) => readonly Cell[];
  readonly changes: (typeof AccessChangesStore)['Service'];
  /** Creates a company role of exactly the named capability, as the role editor does, by the owner. */
  readonly createRole: (capabilityKey: string) => Effect.Effect<{ roleId: RoleId; roleRevisionId: RoleRevisionId }>;
  readonly gate: (typeof AccessDecisionGate)['Service'];
  readonly newIncarnationId: Effect.Effect<AssignmentIncarnationId>;
  readonly owner: OperationalScope;
  readonly people: (typeof AccessPeopleCommands)['Service'];
  readonly peopleStore: (typeof AccessPeopleStore)['Service'];
  readonly projection: (typeof AccessProjectionWriter)['Service'];
  readonly release: CatalogSnapshot;
  readonly tenantId: TenantId;
}

/**
 * One tenant of this suite's own: a database with the committed schema, the identity rows of a real tenant
 * bootstrapped by its owner, two plain members, and a SpiceDB carrying the v2 schema.
 */
const withTenant = <Value, Failure>(run: (tenant: Tenant) => Effect.Effect<Value, Failure>) =>
  Effect.gen(function* tenantScenario() {
    const connections = yield* loadDatabaseConnectionPair();
    const crypto = yield* Crypto.Crypto;
    const configuration = yield* loadSpiceDbConfig();
    const bootstrapConnection = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
    const database = `access_people_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
    yield* bootstrapConnection.unsafe(`create database "${database}"`).pipe(Effect.orDie);
    yield* Effect.addFinalizer(() =>
      bootstrapConnection.unsafe(`drop database if exists "${database}" with (force)`).pipe(Effect.orDie),
    );
    const admin = yield* makeTestPgClient(replacedDatabase(connections.admin.connectionString, database), {
      maxConnections: 2,
    });
    yield* createTemplateDatabase(admin);
    const tenantId = TenantIdSchema.make(yield* crypto.randomUUIDv4());
    yield* seedTenant(admin, tenantId);
    const runtime = yield* makeTestPgClient(replacedDatabase(connections.runtime.connectionString, database), {
      maxConnections: 3,
    });
    const executor = yield* makeTestDatabaseFromClient(runtime, coreRelations);
    yield* Effect.acquireUseRelease(
      Effect.sync(() => newSpiceDbGrpcClient(configuration)),
      (client) =>
        Effect.tryPromise(() =>
          client.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })),
        ).pipe(Effect.orDie),
      (client) => Effect.sync(() => client.close()),
    );
    const compiler = makeAccessProjectionCompiler(makeAccessProjectionTransport(configuration));
    const platforms = Layer.mergeAll(
      Layer.succeed(CoreDatabase, { executor }),
      Layer.succeed(AccessProjectionCompiler, compiler),
      NodeServices.layer,
    );
    const stores = Layer.mergeAll(
      platforms,
      TenantIntentLoaderLive.pipe(Layer.provide(platforms)),
      AccessWriteJournalStoreLive.pipe(Layer.provide(platforms)),
      AccessChangesStoreLive.pipe(Layer.provide(platforms)),
      AccessMembershipStoreLive.pipe(Layer.provide(platforms)),
      AccessPeopleStoreLive.pipe(Layer.provide(platforms)),
      Layer.succeed(AccessTeamStore, makeAccessTeamDrizzleStore({ executor })),
    );
    const base = Layer.mergeAll(
      stores,
      AccessCatalogSnapshotWriterLive.pipe(Layer.provide(stores)),
      AccessProjectionWriterLive.pipe(Layer.provide(stores)),
    );
    const context = yield* Layer.build(
      Layer.mergeAll(
        base,
        TenantAccessBootstrapLive.pipe(Layer.provide(base)),
        AccessDecisionLive.pipe(Layer.provide(AccessEnforcementPortsLive), Layer.provide(base)),
        AccessPeopleCommandsLive.pipe(Layer.provide(base)),
      ),
    );
    const ownerScope = yield* scopeFor(tenantId, owner);
    // The owner's bootstrap is the only access the tenant starts with: the release, the scopes and its role.
    yield* Context.get(context, TenantAccessBootstrap)
      .bootstrapTenantAccess({ legalEntityIds: [company], modules, scope: ownerScope })
      .pipe(
        Effect.mapError((cause) => new Error(`${cause.code}: ${cause.reason}`)),
        Effect.orDie,
      );
    yield* seedMembers(admin, tenantId);
    const release = Option.getOrThrow(
      yield* Context.get(context, AccessPeopleStore).loadCatalogSnapshot(ownerScope).pipe(Effect.orDie),
    );
    const { cells } = yield* Effect.fromResult(compileFullAccessRole(release)).pipe(Effect.orDie);
    const cellsOf = (capabilityKey: string) => cells.filter((cell) => cell.capabilityKey === capabilityKey);
    const createRole = (capabilityKey: string) => {
      const roleCells = cellsOf(capabilityKey);
      return Effect.gen(function* createRoleEffect() {
        const [roleUuid, revisionUuid] = yield* Effect.all([crypto.randomUUIDv4(), crypto.randomUUIDv4()]);
        const created = yield* writeRoleCreation({
          catalogSnapshotId: release.id,
          cells: roleCells,
          decidedAt: yield* DateTime.nowAsDate,
          legalEntityId: company,
          name: `Role of ${capabilityKey}`,
          scope: ownerScope,
          targetRevisionId: RoleRevisionIdSchema.make(revisionUuid),
          targetRoleId: RoleIdSchema.make(roleUuid),
        });
        return { roleId: created.roleId, roleRevisionId: created.roleRevisionId };
      }).pipe(Effect.provideContext(context), Effect.orDie);
    };
    return yield* run({
      admin,
      cellsOf,
      changes: Context.get(context, AccessChangesStore),
      createRole,
      gate: Context.get(context, AccessDecisionGate),
      newIncarnationId: crypto.randomUUIDv4().pipe(
        Effect.map((uuid) => AssignmentIncarnationIdSchema.make(uuid)),
        Effect.orDie,
      ),
      owner: ownerScope,
      people: Context.get(context, AccessPeopleCommands),
      peopleStore: Context.get(context, AccessPeopleStore),
      projection: Context.get(context, AccessProjectionWriter),
      release,
      tenantId,
    });
  }).pipe(Effect.scoped);

/** The instant the gate decides at: after every row the write path records, so no case reads a clock. */
const decisionAt = DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-01T00:00:00Z'));

const decide = (
  tenant: Tenant,
  carrier: typeof noteReadCarrier,
  principalId: PrincipalId,
): Effect.Effect<AccessDecision> =>
  Effect.flatMap(scopeFor(tenant.tenantId, principalId, company), (scope) =>
    tenant.gate.decide({ carrier, legalEntityScope: 'required', now: decisionAt, scope }),
  );

const incarnationsOf = (tenant: Tenant, roleId: RoleId) =>
  tenant.admin
    .unsafe<{ readonly capability_key: string; readonly scope_id: string; readonly status: string }>(
      `select capability_key, scope_id::text, status from core.access_grant_incarnations
        where tenant_id = '${tenant.tenantId}' and role_id = '${roleId}' order by capability_key, mode`,
    )
    .pipe(Effect.orDie);

/**
 * How many backends of the suite's database wait on a lock another transaction holds. The query pauses
 * on the server first, so polling it paces itself without an Effect timer.
 */
const blockedBackends = (tenant: Tenant) =>
  tenant.admin
    .unsafe<{ readonly blocked: number }>(
      `select count(*)::int as blocked from pg_stat_activity, pg_sleep(0.02)
        where datname = current_database() and cardinality(pg_blocking_pids(pid)) > 0`,
    )
    .pipe(
      Effect.map(([row]) => row?.blocked ?? 0),
      Effect.orDie,
    );

/** Polls, for at most about ten seconds, until the database reaches the interleaving a case needs. */
const eventually = (check: Effect.Effect<boolean>, attempts = 500): Effect.Effect<void> =>
  check.pipe(
    Effect.flatMap((reached) => {
      if (reached) {
        return Effect.void;
      }
      return attempts > 1
        ? eventually(check, attempts - 1)
        : Effect.die(new Error('the expected lock interleaving was never reached'));
    }),
  );

type CreatedRole = Effect.Success<ReturnType<Tenant['createRole']>>;

/** One company assignment by the acting person, under a fresh incarnation. */
const assignInCompany = (tenant: Tenant, actor: OperationalScope, principalId: PrincipalId, role: CreatedRole) =>
  Effect.gen(function* assignInCompanyEffect() {
    return yield* tenant.people.assignRole(actor, {
      incarnationId: yield* tenant.newIncarnationId,
      principalId,
      roleId: role.roleId,
      roleRevisionId: role.roleRevisionId,
      scopeId: legalEntityScopeId(tenant.tenantId, company),
    });
  });

/** The capability keys of a release, in one order. */
const keysOf = (entries: readonly CatalogSnapshotEntry[]) => entries.map(({ key }) => key).toSorted();

/** The next release is published after the bootstrap's, whatever the clock reads. */
const nextReleaseAt = DateTime.toDateUtc(DateTime.makeUnsafe('2029-01-01T00:00:00Z'));

it.layer(NodeServices.layer, { excludeTestServices: true })('people commands on the real stores', (suite) => {
  suite.effect('grants a newly created role through its first assignment, once the tenant is reconciled', () =>
    withTenant((tenant) =>
      Effect.gen(function* firstAssignmentGrants() {
        const companyScope = legalEntityScopeId(tenant.tenantId, company);
        const role = yield* tenant.createRole(NOTE_READ);
        // A role nobody holds yet has no incarnation anywhere: there is no scope it is bound in.
        expect(yield* incarnationsOf(tenant, role.roleId)).toEqual([]);
        expect((yield* decide(tenant, noteReadCarrier, colleague)).outcome).toBe('DENIED');

        yield* tenant.people
          .assignRole(tenant.owner, {
            incarnationId: yield* tenant.newIncarnationId,
            principalId: colleague,
            roleId: role.roleId,
            roleRevisionId: role.roleRevisionId,
            scopeId: companyScope,
          })
          .pipe(Effect.orDie);
        expect((yield* decide(tenant, noteReadCarrier, colleague)).outcome).toBe('ALLOWED');
        // The role opens its own capability and nothing else of the module.
        expect((yield* decide(tenant, noteDeleteCarrier, colleague)).outcome).toBe('DENIED');
        const witnessed = yield* incarnationsOf(tenant, role.roleId);
        expect(witnessed.map(({ capability_key, scope_id, status }) => [capability_key, scope_id, status])).toEqual(
          witnessed.map(() => [NOTE_READ, companyScope, 'active']),
        );
        expect(witnessed.length).toBeGreaterThan(0);

        // A second holder in the same scope reuses the live incarnations: the witness never moves.
        yield* tenant.people
          .assignRole(tenant.owner, {
            incarnationId: yield* tenant.newIncarnationId,
            principalId: teammate,
            roleId: role.roleId,
            roleRevisionId: role.roleRevisionId,
            scopeId: companyScope,
          })
          .pipe(Effect.orDie);
        expect(yield* incarnationsOf(tenant, role.roleId)).toEqual(witnessed);
        expect((yield* decide(tenant, noteReadCarrier, teammate)).outcome).toBe('ALLOWED');
      }),
    ),
  );

  suite.effect('grants a delegation from the acting person to another manager, and refuses self-delegation', () =>
    withTenant((tenant) =>
      Effect.gen(function* delegationIsGrantedByTheActor() {
        const companyScope = legalEntityScopeId(tenant.tenantId, company);
        const role = yield* tenant.createRole(NOTE_READ);
        const command = (managerId: PrincipalId, delegationId: number): GrantDelegationCommand => ({
          capabilityKeys: [CapabilityKeySchema.make(NOTE_READ)],
          delegationId: DelegationIdSchema.make(uid(delegationId)),
          managerId,
          people: [teammate],
          roleIds: [role.roleId],
          scopeId: companyScope,
          validUntil: DateTime.toDateUtc(DateTime.makeUnsafe('2031-01-01T00:00:00Z')),
        });

        const granted = yield* tenant.people.grantDelegation(tenant.owner, command(colleague, 40)).pipe(Effect.orDie);
        expect(granted.delegation?.grantedBy).toBe(owner);
        expect(granted.delegation?.managerId).toBe(colleague);
        const stored = yield* tenant.admin
          .unsafe<{ readonly granted_by: string; readonly manager_id: string; readonly status: string }>(
            `select granted_by::text, manager_id::text, status from core.access_delegations
              where tenant_id = '${tenant.tenantId}'`,
          )
          .pipe(Effect.orDie);
        expect(stored).toEqual([{ granted_by: owner, manager_id: colleague, status: 'active' }]);

        // Nobody hands an envelope to themselves, the owner included.
        const selfGrant = yield* Effect.flip(tenant.people.grantDelegation(tenant.owner, command(owner, 41)));
        expect(selfGrant.code).toBe('delegation_self_grant');
      }),
    ),
  );

  suite.effect('lets a delegated manager assign only inside the envelope, and ends that authority with it', () =>
    withTenant((tenant) =>
      Effect.gen(function* delegatedManagerAssignsInsideEnvelope() {
        const companyScope = legalEntityScopeId(tenant.tenantId, company);
        const role = yield* tenant.createRole(NOTE_READ);
        const unnamedRole = yield* tenant.createRole(NOTE_READ);
        const granted = yield* tenant.people
          .grantDelegation(tenant.owner, {
            capabilityKeys: [CapabilityKeySchema.make(NOTE_READ)],
            delegationId: DelegationIdSchema.make(uid(43)),
            managerId: colleague,
            people: [teammate],
            roleIds: [role.roleId],
            scopeId: companyScope,
            validUntil: DateTime.toDateUtc(DateTime.makeUnsafe('2031-01-01T00:00:00Z')),
          })
          .pipe(Effect.orDie);
        const delegationId = DelegationIdSchema.make(uid(43));
        expect(granted.delegation?.id).toBe(delegationId);
        const manager = yield* scopeFor(tenant.tenantId, colleague);
        const assign = (principalId: PrincipalId, chosen: CreatedRole) =>
          assignInCompany(tenant, manager, principalId, chosen);

        // The manager assigns a role the envelope names to a person it names: bounded by the delegation.
        const assigned = yield* assign(teammate, role).pipe(Effect.orDie);
        expect(assigned.assignment?.delegated?.delegationId).toBe(delegationId);
        expect((yield* decide(tenant, noteReadCarrier, teammate)).outcome).toBe('ALLOWED');

        // Never another role, never themselves, never a person outside the envelope.
        expect((yield* Effect.flip(assign(teammate, unnamedRole))).code).toBe('delegation_role_outside_envelope');
        expect((yield* Effect.flip(assign(colleague, role))).code).toBe('delegation_self_assignment');
        expect((yield* Effect.flip(assign(owner, role))).code).toBe('delegation_holder_outside_envelope');
        expect((yield* decide(tenant, noteReadCarrier, colleague)).outcome).toBe('DENIED');

        // Once the owner revokes the delegation, what it created grants nothing.
        yield* tenant.people.revokeDelegation(tenant.owner, { delegationId }).pipe(Effect.orDie);
        expect((yield* decide(tenant, noteReadCarrier, teammate)).outcome).toBe('DENIED');
        expect((yield* Effect.flip(assign(teammate, role))).code).toBe('people_authority_missing');
      }),
    ),
  );

  suite.effect('reads only the newest release once a second one is published, and still grants a delegation', () =>
    withTenant((tenant) =>
      Effect.gen(function* newestReleaseIsReadAlone() {
        const companyScope = legalEntityScopeId(tenant.tenantId, company);
        const next = yield* Effect.fromResult(
          buildAccessCatalogRelease({
            installedModuleKeys: [ModuleKeySchema.make(MODULE)],
            modules: nextModules,
            publishedAt: nextReleaseAt,
          }),
        ).pipe(Effect.orDie);
        expect((yield* tenant.changes.publishCatalog({ snapshot: next }).pipe(Effect.orDie)).inserted).toBe(true);

        // Both releases carry the capabilities they share, so the newest one is read without the first's entries.
        const newest = Option.getOrThrow(
          yield* tenant.peopleStore.loadCatalogSnapshot(tenant.owner).pipe(Effect.orDie),
        );
        expect(newest.id).toBe(next.id);
        expect(keysOf(newest.entries)).toEqual([NOTE_ARCHIVE, NOTE_DELETE, NOTE_READ]);
        const pinned = yield* tenant.peopleStore
          .loadCatalogSnapshot(tenant.owner, tenant.release.id)
          .pipe(Effect.orDie);
        expect(keysOf(Option.getOrThrow(pinned).entries)).toEqual([NOTE_DELETE, NOTE_READ]);
        const offered = yield* tenant.people.readCatalog(tenant.owner).pipe(Effect.orDie);
        expect(keysOf(offered)).toEqual([NOTE_ARCHIVE, NOTE_DELETE, NOTE_READ]);

        const role = yield* tenant.createRole(NOTE_READ);
        const granted = yield* tenant.people
          .grantDelegation(tenant.owner, {
            capabilityKeys: [CapabilityKeySchema.make(NOTE_READ)],
            delegationId: DelegationIdSchema.make(uid(42)),
            managerId: colleague,
            people: [teammate],
            roleIds: [role.roleId],
            scopeId: companyScope,
            validUntil: DateTime.toDateUtc(DateTime.makeUnsafe('2031-01-01T00:00:00Z')),
          })
          .pipe(Effect.orDie);
        expect(granted.delegation?.managerId).toBe(colleague);
      }),
    ),
  );

  suite.effect('serializes a new assignment against an edit of its role, so every holder pins the head', () =>
    withTenant((tenant) =>
      Effect.gen(function* assignmentRacesRoleEdit() {
        const companyScope = legalEntityScopeId(tenant.tenantId, company);
        const role = yield* tenant.createRole(NOTE_READ);
        yield* tenant.people
          .assignRole(tenant.owner, {
            incarnationId: yield* tenant.newIncarnationId,
            principalId: colleague,
            roleId: role.roleId,
            roleRevisionId: role.roleRevisionId,
            scopeId: companyScope,
          })
          .pipe(Effect.orDie);
        const now = yield* DateTime.nowAsDate;
        const assignment = AssignmentSchema.make({
          assignedAt: now,
          assignedBy: owner,
          holder: { _tag: 'Principal', principalId: teammate },
          incarnationId: yield* tenant.newIncarnationId,
          roleId: role.roleId,
          roleRevisionId: role.roleRevisionId,
          scopeId: companyScope,
          status: 'active',
          tenantId: tenant.tenantId,
          validFrom: now,
        });
        const successor = RoleRevisionIdSchema.make(uid(500));

        // The test claims the new assignment's identity first, so the people change parks at its insert,
        // after it checked the role's head; rolling the claim back lets it go on.
        const claimed = yield* Deferred.make<null>();
        const released = yield* Deferred.make<null>();
        const claim = yield* Effect.gen(function* claimIncarnation() {
          yield* tenant.admin
            .unsafe(
              `insert into core.access_assignments
                 (incarnation_id, tenant_id, scope_id, principal_id, role_id, role_revision_id, status, valid_from,
                  assigned_by) values
                 ('${assignment.incarnationId}', '${tenant.tenantId}', '${companyScope}', '${teammate}',
                  '${role.roleId}', '${role.roleRevisionId}', 'active', now(), '${owner}')`,
            )
            .pipe(Effect.orDie);
          yield* Deferred.succeed(claimed, null);
          yield* Deferred.await(released);
          return yield* Effect.fail('rolled back' as const);
        }).pipe(tenant.admin.withTransaction, Effect.flip, Effect.forkChild);
        yield* Deferred.await(claimed);
        const assigning = yield* tenant.peopleStore
          .applyPeopleChange(tenant.owner, { writes: [{ _tag: 'RecordAssignment', assignment }] })
          .pipe(Effect.forkChild);
        yield* eventually(Effect.map(blockedBackends(tenant), (blocked) => blocked === 1));

        // The edit queues behind the assignment's role lock; without that lock it would commit right away.
        const edited = yield* Deferred.make<null>();
        const editing = yield* tenant.changes
          .recordRoleRevision({
            catalogSnapshotId: tenant.release.id,
            decidedAt: now,
            edit: {
              addedCells: tenant.cellsOf(NOTE_DELETE),
              cells: [...tenant.cellsOf(NOTE_READ), ...tenant.cellsOf(NOTE_DELETE)],
              removedCells: [],
              roleId: role.roleId,
              sourceRevisionId: role.roleRevisionId,
              targetRevisionId: successor,
            },
            scope: tenant.owner,
          })
          .pipe(Effect.ensuring(Deferred.succeed(edited, null)), Effect.forkChild);
        yield* eventually(
          Effect.zipWith(blockedBackends(tenant), Deferred.isDone(edited), (blocked, done) => blocked === 2 || done),
        );
        yield* Deferred.succeed(released, null);
        yield* Fiber.join(claim);
        yield* Fiber.join(assigning).pipe(Effect.orDie);
        yield* Fiber.join(editing).pipe(Effect.orDie);

        // Both commit, and the edit moved the holder the assignment added as well as the one before it.
        const pins = yield* tenant.admin
          .unsafe<{ readonly principal_id: string; readonly role_revision_id: string }>(
            `select principal_id::text, role_revision_id::text from core.access_assignments
              where tenant_id = '${tenant.tenantId}' and role_id = '${role.roleId}' and status = 'active'
              order by principal_id`,
          )
          .pipe(Effect.orDie);
        expect(pins).toEqual([
          { principal_id: colleague, role_revision_id: successor },
          { principal_id: teammate, role_revision_id: successor },
        ]);
        yield* tenant.projection.reconcileTenant({ scope: tenant.owner }).pipe(Effect.orDie);
        expect((yield* decide(tenant, noteDeleteCarrier, teammate)).outcome).toBe('ALLOWED');
      }),
    ),
  );
});
