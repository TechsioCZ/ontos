import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Cause, Crypto, DateTime, Effect, Exit, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import type { AccessIntentError } from '../../src/access/intent/errors.ts';
import type { AccessTeam, AccessTeamMember, AccessTeamStoreService } from '../../src/access/intent/teams.ts';
import { AccessTeamMemberIdSchema, makeAccessTeamDrizzleStore } from '../../src/access/intent/teams.ts';
import { AccessTeamIdSchema } from '../../src/access/decision/authority.ts';
import type { AccessMembership, AccessMembershipStoreService } from '../../src/access/intent/memberships.ts';
import {
  AccessMembershipIdSchema,
  canTransitionMembershipStatus,
  makeAccessMembershipDrizzleStore,
} from '../../src/access/intent/memberships.ts';
import { AccessScopeIdSchema, AgentIdSchema, PrincipalIdSchema, TenantIdSchema } from '../../src/access/ids.ts';
import { holderKey } from '../../src/access/model.ts';
import { optionalProperty, principalIdOf } from '../../src/access/intent/persistence.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { loadDatabaseConnectionPair, parseDatabaseConnectionPair } from '../../src/db/config.ts';
import { coreRelations } from '../../src/db/schema.ts';
import {
  createTemplateDatabase,
  insertTenantStatement,
  replacedDatabase,
} from '../support/access-scenarios/database.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

/** Model instants are Effect `DateTime`s: the suite never builds a mutable `Date` of its own. */
const INSTANT = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-03T09:35:47Z'));
const LATER = DateTime.toDateUtc(DateTime.makeUnsafe('2027-01-01T00:00:00Z'));

/*
 * Membership and team intent is what the graph is built from, so PostgreSQL has to keep it: one live
 * row per scope, holder and kind, a status that only ever ends, a scope that is the request's own and
 * an author who is the scoped person. These suites apply the whole committed schema into a database of
 * their own, write through the stores the writers use, and probe every refusal beside the
 * command that must be accepted.
 *
 * Each suite owns its database and drops it again: the access tables are append-only by design, so
 * intent written into a shared test database could never be cleaned up afterwards.
 */
const databasePrefix = 'ontos_test_access_intent_store_';

const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const tenantA = uid(1);
const tenantB = uid(2);
const jana = uid(3);
const eva = uid(4);
const janaAgent = uid(5);
const pavel = uid(6);
const legalEntityA = uid(7);
const legalEntityB = uid(8);
const scopeTenantA = uid(10);
const scopeEntityA = uid(11);
const scopeTenantB = uid(12);
const authBinding = uid(20);

/** A holder as the model brands it: a person or an agent, never a plain string. */
const person = (principalId: string): AccessMembership['holder'] => ({
  _tag: 'Principal',
  principalId: PrincipalIdSchema.make(principalId),
});
const agentHolder = (agentId: string): AccessMembership['holder'] => ({
  _tag: 'Agent',
  agentId: AgentIdSchema.make(agentId),
});

const membershipOf = (input: {
  readonly holder: AccessMembership['holder'];
  readonly id: string;
  readonly kind: AccessMembership['kind'];
  readonly recordedBy?: string;
  readonly scopeId: string;
  readonly status?: AccessMembership['status'];
  readonly tenantId: string;
  readonly validUntil?: Date;
}): AccessMembership => ({
  createdAt: INSTANT,
  holder: input.holder,
  id: AccessMembershipIdSchema.make(input.id),
  kind: input.kind,
  recordedBy:
    input.recordedBy === undefined
      ? Option.getOrElse(principalIdOf(input.holder), () => PrincipalIdSchema.make(jana))
      : PrincipalIdSchema.make(input.recordedBy),
  scopeId: AccessScopeIdSchema.make(input.scopeId),
  status: input.status ?? 'active',
  tenantId: TenantIdSchema.make(input.tenantId),
  validFrom: INSTANT,
  ...optionalProperty({}, 'validUntil', input.validUntil),
});

const memberOf = (id: string, scopeId: string, validUntil?: Date) =>
  membershipOf({
    holder: person(jana),
    id,
    kind: 'member',
    scopeId,
    tenantId: tenantA,
    ...optionalProperty({}, 'validUntil', validUntil),
  });

const ownerOf = (id: string) =>
  membershipOf({ holder: person(jana), id, kind: 'owner', scopeId: scopeTenantA, tenantId: tenantA });

const agentMemberOf = (id: string, scopeId: string) =>
  membershipOf({ holder: agentHolder(janaAgent), id, kind: 'member', scopeId, tenantId: tenantA });

const teamOf = (id: string, name: string): AccessTeam => ({
  createdAt: INSTANT,
  createdBy: PrincipalIdSchema.make(jana),
  id: AccessTeamIdSchema.make(id),
  name,
  scopeId: AccessScopeIdSchema.make(scopeEntityA),
  tenantId: TenantIdSchema.make(tenantA),
});

const teamMemberOf = (input: {
  readonly holder: AccessTeamMember['holder'];
  readonly id: string;
  readonly teamId: string;
}) => ({
  addedAt: INSTANT,
  addedBy: PrincipalIdSchema.make(jana),
  holder: input.holder,
  id: AccessTeamMemberIdSchema.make(input.id),
  teamId: AccessTeamIdSchema.make(input.teamId),
  tenantId: TenantIdSchema.make(tenantA),
});

/** The trusted request scope a store call runs in: one session principal of one tenant. */
const scopeOf = (tenantId: string, principalId: string, legalEntityId?: string): Effect.Effect<OperationalScope> =>
  Schema.decodeEffect(TrustedPrincipalContextSchema)({
    authBindingId: authBinding,
    authContextRef: 'better-auth-session:access-intent-store',
    authMethod: 'session',
    principalId,
    tenantId,
    ...optionalProperty({}, 'legalEntityId', legalEntityId),
  }).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'access-intent-store' })),
    Effect.orDie,
  );

/** The exact refusal a store operation produced, so a suite asserts a code and never a message. */
const failureOf = <Value>(effect: Effect.Effect<Value, AccessIntentError>) =>
  Effect.gen(function* storeFailureOf() {
    const exit = yield* Effect.exit(effect);
    return Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;
  });

interface AccessIntentSchema {
  readonly admin: PgClient.PgClient;
  readonly membershipStore: AccessMembershipStoreService;
  readonly otherMembershipStore: AccessMembershipStoreService;
  readonly scopeA: OperationalScope;
  readonly scopeB: OperationalScope;
  readonly scopeOwnedByJana: OperationalScope;
  readonly teamStore: AccessTeamStoreService;
}

/** A database of this run's own, with the committed schema applied and the runtime role granted. */
const makeAccessIntentSchema = Effect.gen(function* accessIntentSchema() {
  const connections = yield* loadDatabaseConnectionPair();
  const crypto = yield* Crypto.Crypto;
  const database = `${databasePrefix}${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
  const sourceAdmin = yield* makeTestPgClient(connections.admin.connectionString);
  yield* sourceAdmin.unsafe(`create database "${database}"`);
  yield* Effect.addFinalizer(() =>
    database.startsWith(databasePrefix)
      ? sourceAdmin.unsafe(`drop database if exists "${database}"`).pipe(Effect.orDie)
      : Effect.die('Unsafe isolated database cleanup target'),
  );
  const isolated = yield* parseDatabaseConnectionPair({
    DATABASE_ADMIN_URL: replacedDatabase(connections.admin.connectionString, database),
    DATABASE_URL: replacedDatabase(connections.runtime.connectionString, database),
  });
  const admin = yield* makeTestPgClient(isolated.admin.connectionString);
  yield* createTemplateDatabase(admin);
  const runtime = yield* makeTestPgClient(isolated.runtime.connectionString);
  const runtimeDatabase = yield* makeTestDatabaseFromClient(runtime, coreRelations);
  // A second pool, so a second writer really connects as the same runtime identity.
  const otherRuntime = yield* makeTestPgClient(isolated.runtime.connectionString);
  const otherDatabase = yield* makeTestDatabaseFromClient(otherRuntime, coreRelations);
  return {
    admin,
    membershipStore: makeAccessMembershipDrizzleStore({
      enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
      executor: runtimeDatabase,
    }),
    otherMembershipStore: makeAccessMembershipDrizzleStore({
      enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
      executor: otherDatabase,
    }),
    scopeA: yield* scopeOf(tenantA, jana, legalEntityA),
    scopeB: yield* scopeOf(tenantB, pavel),
    scopeOwnedByJana: yield* scopeOf(tenantA, jana),
    teamStore: makeAccessTeamDrizzleStore({
      enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
      executor: runtimeDatabase,
    }),
  } satisfies AccessIntentSchema;
});

it.layer(NodeServices.layer)('the Access membership store', (suite) => {
  suite.effect(
    'records a tenant bootstrap, ends one membership and refuses every command outside its scope',
    Effect.fnUntraced(function* accessMembershipStoreIntegration() {
      const schema = yield* makeAccessIntentSchema;
      const { admin, membershipStore, scopeA, scopeB, scopeOwnedByJana } = schema;

      yield* admin.unsafe(insertTenantStatement(tenantA));
      yield* admin.unsafe(insertTenantStatement(tenantB));
      yield* admin.unsafe(`insert into "core"."legal_entities"
        (tenant_id, legal_entity_id, legal_name, registration_country, registration_number, status) values
        ('${tenantA}', '${legalEntityA}', 'Firma A s.r.o.', 'CZ', '10000001', 'active'),
        ('${tenantB}', '${legalEntityB}', 'Firma B s.r.o.', 'CZ', '10000002', 'active')`);
      yield* admin.unsafe(`insert into "core"."principals" (tenant_id, principal_id, kind, display_name, status) values
        ('${tenantA}', '${jana}', 'human', 'Jana', 'active'),
        ('${tenantA}', '${eva}', 'human', 'Eva', 'active'),
        ('${tenantA}', '${janaAgent}', 'agent', 'Janin agent', 'active'),
        ('${tenantB}', '${pavel}', 'human', 'Pavel', 'active')`);
      yield* admin.unsafe(`insert into "core"."access_scopes" (scope_id, tenant_id, tenant_context_id, legal_entity_id) values
        ('${scopeTenantA}', '${tenantA}', '${tenantA}', null),
        ('${scopeEntityA}', '${tenantA}', null, '${legalEntityA}'),
        ('${scopeTenantB}', '${tenantB}', '${tenantB}', null)`);

      // ---- a bootstrap writes the owner and every member in one statement ----------------------
      const bootstrap = [memberOf(uid(30), scopeTenantA), ownerOf(uid(31)), agentMemberOf(uid(32), scopeTenantA)];
      yield* membershipStore.recordMemberships(scopeOwnedByJana, { memberships: bootstrap });
      const stored = yield* membershipStore.loadTenantMemberships(scopeOwnedByJana);
      expect(stored.map(({ kind, status }) => `${kind}:${status}`).toSorted()).toEqual([
        'member:active',
        'member:active',
        'owner:active',
      ]);
      // The agent takes part too: v2 membership is a human's or an agent's (O46, L43X).
      expect(stored.map(({ holder }) => holderKey(holder))).toContain(holderKey(agentHolder(janaAgent)));
      // A retry of the same bootstrap is not silently accepted twice: it collides with its own rows.
      const replay = yield* failureOf(membershipStore.recordMemberships(scopeOwnedByJana, { memberships: bootstrap }));
      expect(replay?.code).toBe('access_intent_record_conflict');

      // ---- a command belongs to its tenant and to its acting person (O66) ----------------------
      const foreignTenant = yield* failureOf(
        membershipStore.recordMembership(scopeA, {
          membership: membershipOf({
            holder: person(jana),
            id: uid(33),
            kind: 'member',
            scopeId: scopeTenantB,
            tenantId: tenantB,
          }),
        }),
      );
      expect(foreignTenant?.code).toBe('access_intent_scope_mismatch');
      const foreignActor = yield* failureOf(
        membershipStore.recordMembership(scopeA, {
          membership: { ...memberOf(uid(34), scopeEntityA), recordedBy: PrincipalIdSchema.make(eva) },
        }),
      );
      expect(foreignActor?.code).toBe('access_intent_scope_mismatch');
      // A company administration row is written in its company scope, and a tenant one in the tenant
      // scope: PostgreSQL refuses the other pairing, and the store reports the write as a conflict.
      const misplacedOwner = yield* failureOf(
        membershipStore.recordMembership(scopeA, {
          membership: membershipOf({
            holder: person(jana),
            id: uid(35),
            kind: 'owner',
            scopeId: scopeEntityA,
            tenantId: tenantA,
          }),
        }),
      );
      expect(misplacedOwner?.code).toBe('access_intent_write_refused');
      // A membership is written as it begins; every other state is a transition.
      const bornSuspended = yield* failureOf(
        membershipStore.recordMembership(scopeA, {
          membership: membershipOf({
            holder: person(eva),
            id: uid(36),
            kind: 'member',
            recordedBy: jana,
            scopeId: scopeEntityA,
            status: 'suspended',
            tenantId: tenantA,
          }),
        }),
      );
      expect(bornSuspended?.code).toBe('access_intent_record_conflict');
      yield* membershipStore.recordMembership(scopeA, {
        membership: membershipOf({
          holder: person(eva),
          id: uid(37),
          kind: 'member',
          recordedBy: jana,
          scopeId: scopeEntityA,
          tenantId: tenantA,
        }),
      });

      // ---- one live row per scope, holder and kind; suspension is that row's status ------------
      yield* membershipStore.recordMembership(scopeA, {
        membership: membershipOf({
          holder: person(jana),
          id: uid(38),
          kind: 'member',
          scopeId: scopeEntityA,
          tenantId: tenantA,
          validUntil: LATER,
        }),
      });
      const duplicate = yield* failureOf(
        membershipStore.recordMembership(scopeA, {
          membership: membershipOf({
            holder: person(jana),
            id: uid(39),
            kind: 'member',
            scopeId: scopeEntityA,
            tenantId: tenantA,
          }),
        }),
      );
      expect(duplicate?.code).toBe('access_intent_record_conflict');

      // ---- the lifecycle: active <-> suspended, and revoked is final (D27) ---------------------
      const suspended = yield* membershipStore.setMembershipStatus(scopeA, {
        membershipId: AccessMembershipIdSchema.make(uid(37)),
        status: 'suspended',
      });
      expect(suspended.status).toBe('suspended');
      const resumed = yield* membershipStore.setMembershipStatus(scopeA, {
        membershipId: AccessMembershipIdSchema.make(uid(37)),
        status: 'active',
      });
      expect(resumed.status).toBe('active');
      // A same-state command is the state it asked for, not a conflict.
      expect(
        (yield* membershipStore.setMembershipStatus(scopeA, {
          membershipId: AccessMembershipIdSchema.make(uid(37)),
          status: 'active',
        })).status,
      ).toBe('active');
      const revoked = yield* membershipStore.setMembershipStatus(scopeA, {
        membershipId: AccessMembershipIdSchema.make(uid(37)),
        status: 'revoked',
      });
      expect(revoked.status).toBe('revoked');
      const reopened = yield* failureOf(
        membershipStore.setMembershipStatus(scopeA, {
          membershipId: AccessMembershipIdSchema.make(uid(37)),
          status: 'active',
        }),
      );
      expect(reopened?.code).toBe('access_intent_status_terminated');
      const missing = yield* failureOf(
        membershipStore.setMembershipStatus(scopeA, {
          membershipId: AccessMembershipIdSchema.make(uid(90)),
          status: 'revoked',
        }),
      );
      expect(missing?.code).toBe('access_intent_record_conflict');
      // The model agrees with the trigger: no path returns from revoked.
      expect(canTransitionMembershipStatus('revoked', 'active')).toBe(false);
      expect(canTransitionMembershipStatus('suspended', 'active')).toBe(true);

      // ---- a second tenant never sees this one's memberships -----------------------------------
      expect(
        (yield* schema.otherMembershipStore.loadTenantMemberships(scopeB)).map(({ tenantId }) => tenantId),
      ).toEqual([]);
      // The scope's own tenant is the only one a read returns, even from a legal-entity scope.
      expect((yield* membershipStore.loadTenantMemberships(scopeA)).every(({ tenantId }) => tenantId === tenantA)).toBe(
        true,
      );
    }),
  );
});

it.layer(NodeServices.layer)('the Access team store', (suite) => {
  suite.effect(
    'keeps a team and its membership in the scope that owns them, and removes only the membership',
    Effect.fnUntraced(function* accessTeamStoreIntegration() {
      const schema = yield* makeAccessIntentSchema;
      const { admin, scopeB, scopeOwnedByJana, teamStore } = schema;

      yield* admin.unsafe(insertTenantStatement(tenantA));
      yield* admin.unsafe(insertTenantStatement(tenantB));
      yield* admin.unsafe(`insert into "core"."legal_entities"
        (tenant_id, legal_entity_id, legal_name, registration_country, registration_number, status) values
        ('${tenantA}', '${legalEntityA}', 'Firma A s.r.o.', 'CZ', '10000001', 'active')`);
      yield* admin.unsafe(`insert into "core"."access_scopes" (scope_id, tenant_id, tenant_context_id, legal_entity_id) values
        ('${scopeTenantA}', '${tenantA}', '${tenantA}', null),
        ('${scopeEntityA}', '${tenantA}', null, '${legalEntityA}'),
        ('${scopeTenantB}', '${tenantB}', '${tenantB}', null)`);
      yield* admin.unsafe(`insert into "core"."principals" (tenant_id, principal_id, kind, display_name, status) values
        ('${tenantA}', '${jana}', 'human', 'Jana', 'active'),
        ('${tenantA}', '${janaAgent}', 'agent', 'Janin agent', 'active'),
        ('${tenantB}', '${pavel}', 'human', 'Pavel', 'active')`);

      yield* teamStore.recordTeam(scopeOwnedByJana, { team: teamOf(uid(40), 'Skladníci') });
      yield* teamStore.recordTeamMember(scopeOwnedByJana, {
        member: teamMemberOf({ holder: person(jana), id: uid(41), teamId: uid(40) }),
      });
      yield* teamStore.recordTeamMember(scopeOwnedByJana, {
        member: teamMemberOf({ holder: agentHolder(janaAgent), id: uid(42), teamId: uid(40) }),
      });
      const loaded = yield* teamStore.loadTenantTeams(scopeOwnedByJana);
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.team.name).toBe('Skladníci');
      expect(loaded[0]?.members.map(({ holder }) => holder._tag).toSorted()).toEqual(['Agent', 'Principal']);

      // ---- one name and one holder per team ---------------------------------------------------
      const duplicateName = yield* failureOf(
        teamStore.recordTeam(scopeOwnedByJana, { team: teamOf(uid(43), 'Skladníci') }),
      );
      expect(duplicateName?.code).toBe('access_intent_record_conflict');
      const duplicateMember = yield* failureOf(
        teamStore.recordTeamMember(scopeOwnedByJana, {
          member: teamMemberOf({
            holder: person(jana),
            id: uid(44),
            teamId: uid(40),
          }),
        }),
      );
      expect(duplicateMember?.code).toBe('access_intent_record_conflict');

      // ---- a team command belongs to its tenant and to its acting person (O66) ------------------
      const foreignTenant = yield* failureOf(
        teamStore.recordTeamMember(scopeB, {
          member: { ...teamMemberOf({ holder: person(jana), id: uid(45), teamId: uid(40) }) },
        }),
      );
      expect(foreignTenant?.code).toBe('access_intent_scope_mismatch');

      // ---- a holder leaving the team ends only that membership ---------------------------------
      yield* teamStore.removeTeamMember(scopeOwnedByJana, { teamMemberId: AccessTeamMemberIdSchema.make(uid(41)) });
      const remaining = yield* teamStore.loadTenantTeams(scopeOwnedByJana);
      expect(remaining[0]?.members.map(({ id }) => id)).toEqual([uid(42)]);
      // The team identity itself stays, so the records it scopes keep their projection (O24).
      expect(remaining).toHaveLength(1);
      // A removal repeated is not an error: the authority it ended is already gone.
      yield* teamStore.removeTeamMember(scopeOwnedByJana, { teamMemberId: AccessTeamMemberIdSchema.make(uid(41)) });
    }),
  );
});
