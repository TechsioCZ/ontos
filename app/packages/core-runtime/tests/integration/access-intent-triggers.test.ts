import { NodeServices } from '@effect/platform-node';
import { Crypto, Effect, FileSystem, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  AccessScopeIdSchema,
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
  GrantIncarnationIdSchema,
  PrincipalIdSchema,
} from '../../src/access/ids.ts';
import { ActorContextSchema, AuthorityWitnessSchema, CellSchema } from '../../src/access/model.ts';
import type { AccessMode, WitnessPurpose } from '../../src/access/model.ts';
import { findPostgresFailure } from '../../src/database/postgres-failure.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { makeTestPgSession, testDatabaseClients } from '../support/database.ts';

/*
 * The access intent tables are evidence. PostgreSQL holds the half of the guarantee that no column
 * check can express, so this suite applies the migration for real and probes every trigger twice:
 * once with the write that must be accepted and once with the write that must be refused (R2-M11).
 *
 * The migration is applied into a schema of its own, with the three Core identity tables it
 * references, so the suite neither depends on nor disturbs the shared test database.
 */
const migrationPath = new URL(
  '../../drizzle/20261103093547_authorization-v2-access-intent/migration.sql',
  import.meta.url,
).pathname;

const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const tenant = uid(1);
const legalEntityAkros = uid(2);
const legalEntityNajempark = uid(3);
const scopeTenant = uid(4);
const scopeAkros = uid(5);
const scopeNajempark = uid(6);
const jana = uid(7);
const eva = uid(8);
const janaAgent = uid(9);
const ingestService = uid(10);
const catalogSnapshot = uid(11);
const role = uid(12);
const roleRevision1 = uid(13);
const roleRevision2 = uid(14);
const localRole = uid(15);
const localRoleRevision = uid(16);
const assignment = uid(17);
const secondAssignment = uid(18);
const grant = uid(19);
const readGrant = uid(20);
const secondReadGrant = uid(21);
const proposal = uid(22);
const secondProposal = uid(23);
const thirdProposal = uid(24);
const mandate = uid(25);
const delegation = uid(26);
const connection = uid(27);
const changeItem = uid(28);
const secondChangeItem = uid(29);
const changeDecision = uid(30);
const journal = uid(31);
const committedJournal = uid(32);
const decisionLog = uid(33);
const proposeGrant = uid(34);
const approveGrant = uid(35);
const executionAssignment = uid(36);
const requesterAssignment = uid(37);
const fourthProposal = uid(38);
const fifthProposal = uid(39);
const secondMandate = uid(42);
const thirdMandate = uid(43);
const membership = uid(60);
const ownerMembership = uid(61);
const adminMembership = uid(62);
const agentMembership = uid(63);
const rejoinedMembership = uid(64);
const team = uid(65);
const teamMember = uid(66);
const localGrant = uid(67);
const catalogDigest = 'a'.repeat(64);
const commandDigest = 'b'.repeat(64);
const voidKey = 'finance.invoice.void';
const readKey = 'finance.invoice.read';
// The fixtures are encoded through the model schemas, so a fixture that the model would refuse can
// never be inserted here.
const cellJson = Schema.encodeSync(Schema.fromJsonString(CellSchema));
const witnessesJson = Schema.encodeSync(Schema.fromJsonString(Schema.Array(AuthorityWitnessSchema)));
const actorJson = Schema.encodeSync(Schema.fromJsonString(ActorContextSchema));
const capability = (key: string) => CapabilityKeySchema.make(key);
const cellOf = (capabilityKey: string, mode: AccessMode) =>
  `'${cellJson({ capabilityKey: capability(capabilityKey), mode, selector: { _tag: 'all' } })}'::jsonb`;
const requester = actorJson({ _tag: 'Principal', principalId: PrincipalIdSchema.make(jana) });
/**
 * One model witness exactly as the row SQL must accept it. Each purpose has the holder, the
 * assignment and the grant cell it really belongs to, so a fixture can never quietly bind the wrong
 * grant mode, holder or assignment and still be inserted (R2-H1, R3b-N3).
 */
const boundWitness = (input: {
  readonly assignment: string;
  readonly capabilityKey: string;
  readonly grant: string;
  readonly holder: string;
  readonly mode: AccessMode;
  readonly purpose: WitnessPurpose;
}) => ({
  assignmentIncarnationId: AssignmentIncarnationIdSchema.make(input.assignment),
  capabilityKey: capability(input.capabilityKey),
  grantIncarnationId: GrantIncarnationIdSchema.make(input.grant),
  holderId: { _tag: 'Principal' as const, principalId: PrincipalIdSchema.make(input.holder) },
  mode: input.mode,
  purpose: input.purpose,
  scopeId: AccessScopeIdSchema.make(scopeAkros),
});
const GRANT_FOR_PURPOSE = {
  approval: approveGrant,
  execution: grant,
  parent_record_read: secondReadGrant,
  requester: proposeGrant,
} as const satisfies Readonly<Record<WitnessPurpose, string>>;
const ASSIGNMENT_FOR_PURPOSE = {
  approval: secondAssignment,
  execution: executionAssignment,
  parent_record_read: executionAssignment,
  requester: requesterAssignment,
} as const satisfies Readonly<Record<WitnessPurpose, string>>;
const HOLDER_FOR_PURPOSE = {
  approval: eva,
  execution: eva,
  parent_record_read: eva,
  requester: jana,
} as const satisfies Readonly<Record<WitnessPurpose, string>>;
const authority = (purpose: WitnessPurpose, mode: AccessMode, capabilityKey: string) =>
  witnessesJson([
    boundWitness({
      assignment: ASSIGNMENT_FOR_PURPOSE[purpose],
      capabilityKey,
      grant: GRANT_FOR_PURPOSE[purpose],
      holder: HOLDER_FOR_PURPOSE[purpose],
      mode,
      purpose,
    }),
  ]);
/** One witness row as SQL spells it, so a probe names only what it tests. */
const witnessRow = (input: {
  readonly assignment: string;
  readonly capabilityKey: string;
  readonly grant: string;
  readonly mandate: string;
  readonly mode: AccessMode;
  readonly purpose: WitnessPurpose;
}) =>
  `('${tenant}', '${input.mandate}', '${input.grant}', '${input.assignment}', '${input.purpose}', '${input.capabilityKey}', '${input.mode}', '${scopeAkros}')`;

/** Raised by the guard functions: object_not_in_prerequisite_state, or a check/FK/unique violation. */
const GUARD = '55000';
const CHECK = '23514';
const UNIQUE = '23505';
const FOREIGN_KEY = '23503';

const accessMigrationProgram = Effect.gen(function* accessIntentTriggers() {
  const { admin } = yield* testDatabaseClients;
  // A second, single-session client: the proposal/approval pairing is a commit-time invariant, so
  // its probes must hold one explicit transaction on one backend.
  const connections = yield* loadDatabaseConnectionPair();
  const session = yield* makeTestPgSession(connections.admin.connectionString);
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const schemaName = `access_triggers_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
  const schema = `"${schemaName}"`;
  const table = (name: string) => `${schema}."${name}"`;
  yield* admin.unsafe(`create schema ${schema}`);
  yield* Effect.addFinalizer(() => admin.unsafe(`drop schema ${schema} cascade`).pipe(Effect.orDie));

  /** The three Core identity tables the access tables reference; shape only, no behaviour. */
  for (const statement of [
    `create table ${table('tenants')} (tenant_id uuid primary key)`,
    `create table ${table('legal_entities')} (
       tenant_id uuid not null,
       legal_entity_id uuid primary key,
       unique (tenant_id, legal_entity_id)
     )`,
    `create table ${table('principals')} (
       tenant_id uuid not null,
       principal_id uuid primary key,
       kind text not null,
       unique (tenant_id, principal_id)
     )`,
    // The RLS policies name the runtime role; it exists in the real database and must exist here.
    `do $$
     begin
       if not exists (select 1 from pg_roles where rolname = 'ontos_runtime') then
         create role ontos_runtime nologin;
       end if;
     end
     $$`,
  ]) {
    yield* admin.unsafe(statement);
  }

  const migration = yield* fileSystem.readFileString(migrationPath);
  // The tables live in `core` and the guard functions are defined in it; both move together so the
  // suite can apply the migration into a schema of its own.
  for (const statement of migration
    .replaceAll('"core"', schema)
    .replaceAll('core.', `${schemaName}.`)
    .split('--> statement-breakpoint')) {
    if (statement.trim().length > 0) {
      yield* admin.unsafe(statement);
    }
  }

  const allow = (statement: string) => admin.unsafe(statement);
  /** Asserts one write is refused with one of the codes the guarantee can legitimately produce. */
  const refuse = (label: string, statement: string, codes: readonly string[]) =>
    Effect.gen(function* refusedWrite() {
      const outcome = yield* Effect.match(admin.unsafe(statement), {
        onFailure: (failure) => Option.getOrUndefined(findPostgresFailure(failure))?.code ?? 'none',
        onSuccess: () => 'accepted',
      });
      expect(codes.includes(outcome), `${label} (outcome ${outcome})`).toBe(true);
    });
  /**
   * One explicit transaction on one backend, decided at COMMIT: the proposal and its approval record
   * are required of each other only there, so a half-approved pair is refused even though each write
   * on its own is a legitimate row.
   */
  const decideTogether = (label: string, statements: readonly string[], codes: readonly string[]) =>
    Effect.gen(function* decidedTogether() {
      const outcome = yield* Effect.match(
        Effect.gen(function* inTransaction() {
          yield* session.unsafe('begin');
          for (const statement of statements) {
            yield* session.unsafe(statement);
          }
          yield* session.unsafe('commit');
        }),
        {
          onFailure: (failure) => Option.getOrUndefined(findPostgresFailure(failure))?.code ?? 'none',
          onSuccess: () => 'accepted',
        },
      );
      // An aborted transaction stays open until it is rolled back; every probe leaves one behind.
      yield* session.unsafe('rollback').pipe(Effect.ignore);
      expect(codes.includes(outcome), `${label} (outcome ${outcome})`).toBe(true);
    });
  const allowTogether = (label: string, statements: readonly string[]) =>
    decideTogether(label, statements, ['accepted']);
  const refuseTogether = (label: string, statements: readonly string[], codes: readonly string[]) =>
    decideTogether(label, statements, codes);

  // ---- fixtures -------------------------------------------------------------------------------
  yield* allow(`insert into ${table('tenants')} values ('${tenant}')`);
  yield* allow(
    `insert into ${table('legal_entities')} values ('${tenant}', '${legalEntityAkros}'), ('${tenant}', '${legalEntityNajempark}')`,
  );
  yield* allow(`insert into ${table('principals')} values
    ('${tenant}', '${jana}', 'human'),
    ('${tenant}', '${eva}', 'human'),
    ('${tenant}', '${janaAgent}', 'agent'),
    ('${tenant}', '${ingestService}', 'service')`);
  yield* allow(`insert into ${table('access_catalog_snapshots')} (catalog_snapshot_id, digest, published_at)
    values ('${catalogSnapshot}', '${catalogDigest}', now())`);
  yield* allow(`insert into ${table('access_catalog_entries')} (catalog_snapshot_id, capability_key, entry_json)
    values ('${catalogSnapshot}', '${voidKey}', '{"key": "${voidKey}"}'::jsonb),
           ('${catalogSnapshot}', '${readKey}', '{"key": "${readKey}"}'::jsonb)`);
  yield* allow(`insert into ${table('access_scopes')} (scope_id, tenant_id, tenant_context_id, legal_entity_id)
    values ('${scopeTenant}', '${tenant}', '${tenant}', null),
           ('${scopeAkros}', '${tenant}', null, '${legalEntityAkros}'),
           ('${scopeNajempark}', '${tenant}', null, '${legalEntityNajempark}')`);
  yield* allow(`insert into ${table('access_roles')} (role_id, tenant_id, created_by, legal_entity_id, name)
    values ('${role}', '${tenant}', '${jana}', null, 'Účetní'),
           ('${localRole}', '${tenant}', '${jana}', '${legalEntityAkros}', 'Skladník')`);
  yield* allow(`insert into ${table('access_role_revisions')}
      (role_revision_id, tenant_id, role_id, revision, catalog_snapshot_id, cells_json, created_by, provenance, template_key)
    values ('${roleRevision1}', '${tenant}', '${role}', 1, '${catalogSnapshot}',
            '[{"capabilityKey": "${voidKey}", "mode": "run", "selector": {"_tag": "all"}}]'::jsonb, '${jana}', 'template', 'finance.accountant'),
           ('${roleRevision2}', '${tenant}', '${role}', 2, '${catalogSnapshot}',
            '[{"capabilityKey": "${voidKey}", "mode": "run", "selector": {"_tag": "all"}}]'::jsonb, '${jana}', 'manual', null),
           ('${localRoleRevision}', '${tenant}', '${localRole}', 1, '${catalogSnapshot}', '[]'::jsonb, '${jana}', 'imported', null)`);
  yield* allow(`insert into ${table('access_assignments')}
      (incarnation_id, tenant_id, scope_id, role_id, role_revision_id, principal_id, assigned_by, status, valid_from)
    values ('${assignment}', '${tenant}', '${scopeAkros}', '${role}', '${roleRevision1}', '${jana}', '${eva}', 'active', now()),
           ('${secondAssignment}', '${tenant}', '${scopeAkros}', '${role}', '${roleRevision1}', '${eva}', '${eva}', 'active', now()),
           ('${executionAssignment}', '${tenant}', '${scopeAkros}', '${role}', '${roleRevision1}', '${eva}', '${eva}', 'active', now()),
           ('${requesterAssignment}', '${tenant}', '${scopeAkros}', '${role}', '${roleRevision1}', '${jana}', '${eva}', 'active', now())`);
  yield* allow(`insert into ${table('access_grant_incarnations')}
      (grant_incarnation_id, tenant_id, scope_id, role_id, capability_key, mode, slot, cell_json, status)
    values ('${grant}', '${tenant}', '${scopeAkros}', '${role}', '${voidKey}', 'run', 'all', ${cellOf(voidKey, 'run')}, 'active'),
           ('${proposeGrant}', '${tenant}', '${scopeAkros}', '${role}', '${voidKey}', 'propose', 'all', ${cellOf(voidKey, 'propose')}, 'active'),
           ('${approveGrant}', '${tenant}', '${scopeAkros}', '${role}', '${voidKey}', 'approve', 'all', ${cellOf(voidKey, 'approve')}, 'active'),
           ('${readGrant}', '${tenant}', '${scopeAkros}', '${role}', '${readKey}', 'run', 'all', ${cellOf(readKey, 'run')}, 'active')`);
  yield* allow(`insert into ${table('access_delegations')}
      (delegation_id, tenant_id, scope_id, granted_by, manager_id, people, role_ids, capability_keys,
       amount_ceiling_json, status, valid_from, until)
    values ('${delegation}', '${tenant}', '${scopeAkros}', '${jana}', '${eva}', array['${janaAgent}'::uuid],
            array['${role}'::uuid], array['${voidKey}'], '{"currency": "CZK", "limitMinor": 100000}'::jsonb,
            'active', now(), now() + interval '1 day')`);
  yield* allow(`insert into ${table('access_agent_connections')}
      (connection_id, tenant_id, scope_id, agent_id, principal_id, revision, ceiling_json, status, valid_from, valid_until)
    values ('${connection}', '${tenant}', '${scopeAkros}', '${janaAgent}', '${jana}', 1, '{"cells": []}'::jsonb,
            'active', now(), now() + interval '1 day')`);
  yield* allow(`insert into ${table('access_consent_snapshots')}
      (tenant_id, connection_id, revision, ceiling_json, granted_at, granted_by)
    values ('${tenant}', '${connection}', 1, '{"cells": []}'::jsonb, now(), '${jana}')`);
  yield* allow(`insert into ${table('access_change_items')}
      (item_id, tenant_id, capability_key, catalog_snapshot_id, kind, lineage_from, risk, status, suggested_role_ids)
    values ('${changeItem}', '${tenant}', '${voidKey}', '${catalogSnapshot}', 'new', array[]::text[], 'critical', 'pending',
            array['${role}'::uuid]),
           ('${secondChangeItem}', '${tenant}', '${readKey}', '${catalogSnapshot}', 'new', array[]::text[], 'routine', 'pending',
            array[]::uuid[])`);
  yield* allow(`insert into ${table('access_change_decisions')}
      (decision_id, tenant_id, batch_id, item_id, decision, decided_by, decided_at, role_revision_ids)
    values ('${changeDecision}', '${tenant}', '${uid(40)}', '${changeItem}', 'adopt', '${jana}', now(),
            array['${roleRevision2}'::uuid])`);
  yield* allow(`insert into ${table('access_operation_journals')}
      (operation_id, tenant_id, scope_id, command_digest, phase, started_at, updated_at, projection_token)
    values ('${journal}', '${tenant}', '${scopeAkros}', '${commandDigest}', 'validated', now(), now(), null),
           ('${committedJournal}', '${tenant}', '${scopeAkros}', '${commandDigest}', 'committed', now(), now(), 'token')`);
  yield* allow(`insert into ${table('access_scope_fences')} (scope_id, tenant_id, state, revision)
    values ('${scopeNajempark}', '${tenant}', 'Ready', 1)`);
  yield* allow(`insert into ${table('access_decision_logs')}
      (decision_log_id, tenant_id, scope_id, actor_json, actor_principal_id, capability_key, correlation_id,
       decided_at, mode, outcome, reasons_json)
    values ('${decisionLog}', '${tenant}', '${scopeAkros}', '{"_tag": "Principal", "principalId": "${jana}"}'::jsonb,
            '${jana}', '${voidKey}', 'request-1', now(), 'run', 'DENIED', '[{"code": "grant.missing"}]'::jsonb)`);
  yield* allow(`insert into ${table('access_proposals')}
      (proposal_id, tenant_id, scope_id, capability_key, command_digest, created_at, expires_at, requester_json,
       requester_principal_id, status, requester_authority_json)
    values ('${proposal}', '${tenant}', '${scopeAkros}', '${voidKey}', '${commandDigest}', now(), now() + interval '1 day',
            '${requester}'::jsonb, '${jana}', 'pending', '${authority('requester', 'propose', voidKey)}'::jsonb),
           ('${secondProposal}', '${tenant}', '${scopeAkros}', '${voidKey}', '${commandDigest}', now(), now() + interval '1 day',
            '${requester}'::jsonb, '${jana}', 'pending', '${authority('requester', 'propose', voidKey)}'::jsonb),
           ('${thirdProposal}', '${tenant}', '${scopeAkros}', '${voidKey}', '${commandDigest}', now(), now() + interval '1 day',
            '${requester}'::jsonb, '${jana}', 'pending', '${authority('requester', 'propose', voidKey)}'::jsonb),
           ('${fourthProposal}', '${tenant}', '${scopeAkros}', '${voidKey}', '${commandDigest}', now(), now() + interval '1 day',
            '${requester}'::jsonb, '${jana}', 'pending', '${authority('requester', 'propose', voidKey)}'::jsonb),
           ('${fifthProposal}', '${tenant}', '${scopeAkros}', '${voidKey}', '${commandDigest}', now(), now() + interval '1 day',
            '${requester}'::jsonb, '${jana}', 'pending', '${authority('requester', 'propose', voidKey)}'::jsonb)`);

  yield* allow(`insert into ${table('access_grant_incarnations')}
      (grant_incarnation_id, tenant_id, scope_id, role_id, capability_key, mode, slot, cell_json, status)
    values ('${localGrant}', '${tenant}', '${scopeAkros}', '${localRole}', '${voidKey}', 'run', 'all', ${cellOf(voidKey, 'run')}, 'active')`);

  // ---- D6/D27: membership is one live row per scope, holder and kind -------------------------
  yield* allow(`insert into ${table('access_memberships')}
      (membership_id, tenant_id, scope_id, principal_id, kind, status, recorded_by, valid_from)
    values ('${membership}', '${tenant}', '${scopeTenant}', '${jana}', 'member', 'active', '${jana}', now()),
           ('${ownerMembership}', '${tenant}', '${scopeTenant}', '${jana}', 'owner', 'active', '${jana}', now()),
           ('${adminMembership}', '${tenant}', '${scopeAkros}', '${jana}', 'access_admin', 'active', '${jana}', now())`);
  yield* allow(`insert into ${table('access_memberships')}
      (membership_id, tenant_id, scope_id, agent_id, kind, status, recorded_by, valid_from)
    values ('${agentMembership}', '${tenant}', '${scopeAkros}', '${janaAgent}', 'member', 'active', '${jana}', now())`);
  yield* refuse(
    'tenant ownership is held in the tenant-context scope only',
    `insert into ${table('access_memberships')}
       (membership_id, tenant_id, scope_id, principal_id, kind, status, recorded_by, valid_from)
     values ('${uid(70)}', '${tenant}', '${scopeAkros}', '${jana}', 'owner', 'active', '${jana}', now())`,
    [CHECK],
  );
  yield* refuse(
    'company administration is held inside one legal entity only',
    `insert into ${table('access_memberships')}
       (membership_id, tenant_id, scope_id, principal_id, kind, status, recorded_by, valid_from)
     values ('${uid(71)}', '${tenant}', '${scopeTenant}', '${jana}', 'access_admin', 'active', '${jana}', now())`,
    [CHECK],
  );
  yield* refuse(
    'an agent never holds management authority',
    `insert into ${table('access_memberships')}
       (membership_id, tenant_id, scope_id, agent_id, kind, status, recorded_by, valid_from)
     values ('${uid(72)}', '${tenant}', '${scopeTenant}', '${janaAgent}', 'owner', 'active', '${jana}', now())`,
    [CHECK],
  );
  yield* refuse(
    'a service principal is never a member',
    `insert into ${table('access_memberships')}
       (membership_id, tenant_id, scope_id, principal_id, kind, status, recorded_by, valid_from)
     values ('${uid(73)}', '${tenant}', '${scopeTenant}', '${ingestService}', 'member', 'active', '${jana}', now())`,
    [CHECK],
  );
  yield* refuse(
    'one live membership per scope, holder and kind',
    `insert into ${table('access_memberships')}
       (membership_id, tenant_id, scope_id, principal_id, kind, status, recorded_by, valid_from)
     values ('${uid(74)}', '${tenant}', '${scopeTenant}', '${jana}', 'member', 'suspended', '${jana}', now())`,
    [UNIQUE],
  );
  yield* refuse(
    'a membership never changes its holder',
    `update ${table('access_memberships')} set principal_id = '${eva}' where membership_id = '${membership}'`,
    [GUARD],
  );
  yield* refuse(
    'a membership deadline is never extended',
    `update ${table('access_memberships')} set valid_until = now() + interval '30 days'
      where membership_id = '${membership}'`,
    [GUARD],
  );
  yield* allow(`update ${table('access_memberships')} set status = 'suspended' where membership_id = '${membership}'`);
  yield* allow(`update ${table('access_memberships')} set status = 'active' where membership_id = '${membership}'`);
  yield* allow(`update ${table('access_memberships')} set status = 'revoked' where membership_id = '${membership}'`);
  yield* refuse(
    'a revoked membership never returns to active',
    `update ${table('access_memberships')} set status = 'active' where membership_id = '${membership}'`,
    [GUARD],
  );
  yield* refuse(
    'a membership is never deleted',
    `delete from ${table('access_memberships')} where membership_id = '${agentMembership}'`,
    [GUARD],
  );
  yield* refuse('memberships are never truncated', `truncate ${table('access_memberships')} cascade`, [GUARD]);
  // A rejoin is a new membership: the revoked row ends, it is not reopened (D27).
  yield* allow(`insert into ${table('access_memberships')}
      (membership_id, tenant_id, scope_id, principal_id, kind, status, recorded_by, valid_from)
    values ('${rejoinedMembership}', '${tenant}', '${scopeTenant}', '${jana}', 'member', 'active', '${jana}', now())`);

  // ---- O24: a team is one scope's identity, and its membership is current intent -------------
  yield* allow(`insert into ${table('access_teams')} (team_id, tenant_id, scope_id, created_by, name)
    values ('${team}', '${tenant}', '${scopeAkros}', '${jana}', 'Skladníci')`);
  yield* allow(`insert into ${table('access_team_members')}
      (team_member_id, tenant_id, team_id, principal_id, added_by, added_at)
    values ('${teamMember}', '${tenant}', '${team}', '${jana}', '${jana}', now())`);
  yield* allow(`insert into ${table('access_team_members')}
      (team_member_id, tenant_id, team_id, agent_id, added_by, added_at)
    values ('${uid(75)}', '${tenant}', '${team}', '${janaAgent}', '${jana}', now())`);
  yield* refuse(
    'a team holds a person or an agent, never both',
    `insert into ${table('access_team_members')}
       (team_member_id, tenant_id, team_id, principal_id, agent_id, added_by, added_at)
     values ('${uid(76)}', '${tenant}', '${team}', '${eva}', '${janaAgent}', '${jana}', now())`,
    [CHECK],
  );
  yield* refuse(
    'a service principal is never a team member',
    `insert into ${table('access_team_members')}
       (team_member_id, tenant_id, team_id, principal_id, added_by, added_at)
     values ('${uid(77)}', '${tenant}', '${team}', '${ingestService}', '${jana}', now())`,
    [CHECK],
  );
  yield* refuse(
    'one team of one name per scope',
    `insert into ${table('access_teams')} (team_id, tenant_id, scope_id, created_by, name)
     values ('${uid(78)}', '${tenant}', '${scopeAkros}', '${jana}', 'Skladníci')`,
    [UNIQUE],
  );
  yield* allow(`update ${table('access_teams')} set name = 'Skladníci II' where team_id = '${team}'`);
  yield* refuse(
    'a team never moves to another scope',
    `update ${table('access_teams')} set scope_id = '${scopeNajempark}' where team_id = '${team}'`,
    [GUARD],
  );
  yield* refuse('a team is never deleted', `delete from ${table('access_teams')} where team_id = '${team}'`, [GUARD]);
  yield* refuse('teams are never truncated', `truncate ${table('access_teams')} cascade`, [GUARD]);
  // A holder leaving a team ends the authority the team carried for them; the row is removed.
  yield* allow(`delete from ${table('access_team_members')} where team_member_id = '${teamMember}'`);
  yield* refuse('team memberships are never truncated', `truncate ${table('access_team_members')} cascade`, [GUARD]);

  // ---- M1: a v2 subject is a human or an agent, never a workload -----------------------------
  yield* refuse(
    'an agent is never stored as the human holder',
    `insert into ${table('access_assignments')}
       (incarnation_id, tenant_id, scope_id, role_id, role_revision_id, principal_id, assigned_by, status, valid_from)
     values ('${uid(50)}', '${tenant}', '${scopeAkros}', '${role}', '${roleRevision1}', '${janaAgent}', '${eva}', 'active', now())`,
    [CHECK],
  );
  yield* refuse(
    'a service principal is never stored as a v2 subject',
    `insert into ${table('access_assignments')}
       (incarnation_id, tenant_id, scope_id, role_id, role_revision_id, principal_id, assigned_by, status, valid_from)
     values ('${uid(51)}', '${tenant}', '${scopeAkros}', '${role}', '${roleRevision1}', '${ingestService}', '${eva}', 'active', now())`,
    [CHECK],
  );
  yield* refuse(
    'a person is never stored as the agent holder',
    `insert into ${table('access_assignments')}
       (incarnation_id, tenant_id, scope_id, role_id, role_revision_id, agent_id, assigned_by, status, valid_from)
     values ('${uid(52)}', '${tenant}', '${scopeAkros}', '${role}', '${roleRevision1}', '${jana}', '${eva}', 'active', now())`,
    [CHECK],
  );
  yield* refuse(
    'a person is never stored as the agent of a connection',
    `insert into ${table('access_agent_connections')}
       (connection_id, tenant_id, scope_id, agent_id, principal_id, revision, ceiling_json, status, valid_from, valid_until)
     values ('${uid(53)}', '${tenant}', '${scopeAkros}', '${jana}', '${jana}', 1, '{"cells": []}'::jsonb, 'active', now(), now() + interval '1 day')`,
    [CHECK],
  );
  yield* allow(`insert into ${table('access_assignments')}
      (incarnation_id, tenant_id, scope_id, role_id, role_revision_id, agent_id, assigned_by, status, valid_from)
    values ('${uid(54)}', '${tenant}', '${scopeAkros}', '${role}', '${roleRevision1}', '${janaAgent}', '${eva}', 'active', now())`);

  // ---- M3: an assignment follows one role, forward only, inside the role's legal entity -------
  yield* refuse(
    'an assignment never changes its holder',
    `update ${table('access_assignments')} set principal_id = '${eva}' where incarnation_id = '${assignment}'`,
    [GUARD],
  );
  yield* refuse(
    'an assignment never moves to another role',
    `update ${table('access_assignments')} set role_id = '${localRole}', role_revision_id = '${localRoleRevision}'
      where incarnation_id = '${secondAssignment}'`,
    [GUARD],
  );
  yield* allow(`update ${table('access_assignments')} set role_revision_id = '${roleRevision2}'
    where incarnation_id = '${secondAssignment}'`);
  yield* refuse(
    'an assignment never follows an older revision of its role',
    `update ${table('access_assignments')} set role_revision_id = '${roleRevision1}'
      where incarnation_id = '${secondAssignment}'`,
    [GUARD],
  );
  yield* allow(`insert into ${table('access_assignments')}
      (incarnation_id, tenant_id, scope_id, role_id, role_revision_id, principal_id, assigned_by, status, valid_from)
    values ('${uid(55)}', '${tenant}', '${scopeAkros}', '${localRole}', '${localRoleRevision}', '${jana}', '${eva}', 'active', now())`);
  yield* refuse(
    'a company-local role is never assigned in another legal entity',
    `insert into ${table('access_assignments')}
       (incarnation_id, tenant_id, scope_id, role_id, role_revision_id, principal_id, assigned_by, status, valid_from)
     values ('${uid(56)}', '${tenant}', '${scopeNajempark}', '${localRole}', '${localRoleRevision}', '${jana}', '${eva}', 'active', now())`,
    [CHECK],
  );
  yield* refuse(
    'a company-local role is never assigned in tenant context',
    `insert into ${table('access_assignments')}
       (incarnation_id, tenant_id, scope_id, role_id, role_revision_id, principal_id, assigned_by, status, valid_from)
     values ('${uid(57)}', '${tenant}', '${scopeTenant}', '${localRole}', '${localRoleRevision}', '${jana}', '${eva}', 'active', now())`,
    [CHECK],
  );
  yield* allow(`update ${table('access_assignments')} set status = 'revoked' where incarnation_id = '${assignment}'`);
  yield* refuse(
    'a revoked assignment never returns to active',
    `update ${table('access_assignments')} set status = 'active' where incarnation_id = '${assignment}'`,
    [GUARD],
  );
  yield* refuse(
    'an assignment is never deleted',
    `delete from ${table('access_assignments')} where incarnation_id = '${secondAssignment}'`,
    [GUARD],
  );
  yield* refuse('assignments are never truncated', `truncate ${table('access_assignments')} cascade`, [GUARD]);
  // The escape R3b found: a live assignment pointing at a role, while the role's own legal entity was
  // moved (or dropped, which makes a local role tenant-wide) under it.
  yield* refuse(
    'a role never moves to another legal entity',
    `update ${table('access_roles')} set legal_entity_id = '${legalEntityNajempark}' where role_id = '${localRole}'`,
    [GUARD],
  );
  yield* refuse(
    'a company-local role never becomes a tenant-wide one',
    `update ${table('access_roles')} set legal_entity_id = null where role_id = '${localRole}'`,
    [GUARD],
  );
  yield* refuse(
    'a scope never moves to another legal entity',
    `update ${table('access_scopes')} set legal_entity_id = '${legalEntityNajempark}' where scope_id = '${scopeAkros}'`,
    [GUARD],
  );
  yield* refuse(
    'a scope is never deleted',
    `delete from ${table('access_scopes')} where scope_id = '${scopeNajempark}'`,
    [GUARD],
  );
  yield* allow(`update ${table('access_roles')} set name = 'Účetní II' where role_id = '${role}'`);

  // ---- O52: the grant incarnation is an exact, never-reused cell -----------------------------
  yield* refuse(
    'one cell has at most one live grant incarnation',
    `insert into ${table('access_grant_incarnations')}
       (grant_incarnation_id, tenant_id, scope_id, role_id, capability_key, mode, slot, cell_json, status)
     values ('${uid(58)}', '${tenant}', '${scopeAkros}', '${role}', '${voidKey}', 'run', 'all', ${cellOf(voidKey, 'run')}, 'active')`,
    [UNIQUE],
  );
  yield* refuse(
    'a grant incarnation never rewrites its cell',
    `update ${table('access_grant_incarnations')} set cell_json = ${cellOf(voidKey, 'approve')} where grant_incarnation_id = '${grant}'`,
    [GUARD],
  );
  yield* refuse(
    'a grant incarnation never moves to another role',
    `update ${table('access_grant_incarnations')} set role_id = '${localRole}' where grant_incarnation_id = '${grant}'`,
    [GUARD],
  );
  yield* allow(
    `update ${table('access_grant_incarnations')} set status = 'retired' where grant_incarnation_id = '${readGrant}'`,
  );
  yield* refuse(
    'a retired grant incarnation never returns to active',
    `update ${table('access_grant_incarnations')} set status = 'active' where grant_incarnation_id = '${readGrant}'`,
    [GUARD],
  );
  // A removed cell that comes back is a new incarnation: no old approval can reach the new one.
  yield* allow(`insert into ${table('access_grant_incarnations')}
      (grant_incarnation_id, tenant_id, scope_id, role_id, capability_key, mode, slot, cell_json, status)
    values ('${secondReadGrant}', '${tenant}', '${scopeAkros}', '${role}', '${readKey}', 'run', 'all', ${cellOf(readKey, 'run')}, 'active')`);
  yield* refuse(
    'a grant incarnation is never deleted',
    `delete from ${table('access_grant_incarnations')} where grant_incarnation_id = '${secondReadGrant}'`,
    [GUARD],
  );

  // ---- M5: the proposal owns the status, and the approval is stored once ----------------------
  // An approved proposal without an approval record is refused at commit, and so is an approval
  // record that no transition ever reached: the pair is required of both rows, in either write order.
  yield* refuse(
    'a pending proposal never jumps straight to executed',
    `update ${table('access_proposals')} set status = 'executed', executed_at = now(), execution_operation_id = '${uid(59)}'
      where proposal_id = '${thirdProposal}'`,
    [GUARD, CHECK],
  );
  yield* refuse(
    'an approved proposal carries its approval record',
    `update ${table('access_proposals')} set status = 'approved' where proposal_id = '${fourthProposal}'`,
    [CHECK],
  );
  /** The whole approval as Core writes it: the approval record, its witnesses, then the transition. */
  const approvalStatements = (proposalId: string, mandateId: string) => [
    `insert into ${table('access_mandates')}
       (mandate_id, proposal_id, tenant_id, scope_id, capability_key, command_digest,
        approved_at, approval_expires_at, approver_id,
        approver_assignment_incarnation_id, execution_assignment_incarnation_id)
     values ('${mandateId}', '${proposalId}', '${tenant}', '${scopeAkros}', '${voidKey}', '${commandDigest}',
             now(), now() + interval '1 hour', '${eva}', '${secondAssignment}', '${executionAssignment}')`,
    `insert into ${table('access_mandate_grants')}
       (tenant_id, mandate_id, grant_incarnation_id, assignment_incarnation_id, purpose, capability_key, mode, scope_id)
     values ${witnessRow({ assignment: requesterAssignment, capabilityKey: voidKey, grant: proposeGrant, mandate: mandateId, mode: 'propose', purpose: 'requester' })},
            ${witnessRow({ assignment: secondAssignment, capabilityKey: voidKey, grant: approveGrant, mandate: mandateId, mode: 'approve', purpose: 'approval' })},
            ${witnessRow({ assignment: executionAssignment, capabilityKey: voidKey, grant, mandate: mandateId, mode: 'run', purpose: 'execution' })},
            ${witnessRow({ assignment: executionAssignment, capabilityKey: readKey, grant: secondReadGrant, mandate: mandateId, mode: 'run', purpose: 'parent_record_read' })}`,
    `update ${table('access_proposals')} set status = 'approved' where proposal_id = '${proposalId}'`,
  ];
  yield* refuseTogether(
    'an approval record belongs to a proposal that reached its approval',
    approvalStatements(fourthProposal, thirdMandate).slice(0, 2),
    [CHECK],
  );
  yield* allowTogether(
    'an approval record and the transition it authorises commit together',
    approvalStatements(proposal, mandate),
  );
  yield* allowTogether(
    'the approval of a second proposal is stored the same single way',
    approvalStatements(fifthProposal, secondMandate),
  );
  // The approval names the frozen command of the proposal it approves, so no second copy of the
  // approval exists that could claim another capability, scope or digest (R3b-N3c).
  for (const [label, capabilityKey, digest] of [
    ['an approval never names another capability', readKey, commandDigest],
    ['an approval never names another frozen command', voidKey, 'c'.repeat(64)],
  ] as const) {
    yield* refuse(
      label,
      `insert into ${table('access_mandates')}
         (mandate_id, proposal_id, tenant_id, scope_id, capability_key, command_digest,
          approved_at, approval_expires_at, approver_id,
          approver_assignment_incarnation_id, execution_assignment_incarnation_id)
       values ('${thirdMandate}', '${fourthProposal}', '${tenant}', '${scopeAkros}', '${capabilityKey}', '${digest}',
               now(), now() + interval '1 hour', '${eva}', '${secondAssignment}', '${executionAssignment}')`,
      [FOREIGN_KEY],
    );
  }
  yield* refuse(
    'an approval happens inside the lifetime of the proposal it approves',
    `insert into ${table('access_mandates')}
       (mandate_id, proposal_id, tenant_id, scope_id, capability_key, command_digest,
        approved_at, approval_expires_at, approver_id,
        approver_assignment_incarnation_id, execution_assignment_incarnation_id)
     values ('${thirdMandate}', '${fourthProposal}', '${tenant}', '${scopeAkros}', '${voidKey}', '${commandDigest}',
             now() + interval '2 days', now() + interval '3 days', '${eva}', '${secondAssignment}',
             '${executionAssignment}')`,
    [CHECK],
  );
  yield* refuse(
    "an approval binds the approver's own live assignment",
    `insert into ${table('access_mandates')}
       (mandate_id, proposal_id, tenant_id, scope_id, capability_key, command_digest,
        approved_at, approval_expires_at, approver_id,
        approver_assignment_incarnation_id, execution_assignment_incarnation_id)
     values ('${thirdMandate}', '${fourthProposal}', '${tenant}', '${scopeAkros}', '${voidKey}', '${commandDigest}',
             now(), now() + interval '1 hour', '${eva}', '${requesterAssignment}', '${executionAssignment}')`,
    [CHECK],
  );
  yield* refuse(
    'a mandate never rewrites who approved it',
    `update ${table('access_mandates')} set approver_id = '${jana}' where mandate_id = '${mandate}'`,
    [GUARD],
  );
  yield* refuse(
    'a mandate is never deleted',
    `delete from ${table('access_mandates')} where mandate_id = '${mandate}'`,
    [GUARD],
  );
  yield* refuse('mandates are never truncated', `truncate ${table('access_mandates')} cascade`, [GUARD]);

  // ---- O52/O57: the proposal owns the lifecycle; withdrawal lapses, it never rejects ----------
  yield* refuse(
    'an approved mandate is withdrawn to lapsed, never rejected (O57)',
    `update ${table('access_proposals')} set status = 'rejected', rejected_by = '${eva}', ended_at = now()
      where proposal_id = '${proposal}'`,
    [GUARD],
  );
  yield* refuse(
    'a proposal keeps the frozen command it was made with',
    `update ${table('access_proposals')} set command_digest = '${'c'.repeat(64)}' where proposal_id = '${proposal}'`,
    [GUARD],
  );

  // ---- R2-H1/R3b-N3/O63: a witness binds the grant's real mode, holder and assignment ---------
  yield* refuse(
    'an approval witness is held in an approve-mode grant, never a propose-mode one',
    `insert into ${table('access_mandate_grants')}
       (tenant_id, mandate_id, grant_incarnation_id, assignment_incarnation_id, purpose, capability_key, mode, scope_id)
     values ${witnessRow({ assignment: secondAssignment, capabilityKey: voidKey, grant: proposeGrant, mandate: secondMandate, mode: 'approve', purpose: 'approval' })}`,
    [FOREIGN_KEY],
  );
  yield* refuse(
    'a witness never claims a capability its grant does not hold',
    `insert into ${table('access_mandate_grants')}
       (tenant_id, mandate_id, grant_incarnation_id, assignment_incarnation_id, purpose, capability_key, mode, scope_id)
     values ${witnessRow({ assignment: executionAssignment, capabilityKey: voidKey, grant: secondReadGrant, mandate: secondMandate, mode: 'run', purpose: 'execution' })}`,
    [FOREIGN_KEY],
  );
  yield* refuse(
    'a witness is never held in another scope than its mandate',
    `insert into ${table('access_mandate_grants')}
       (tenant_id, mandate_id, grant_incarnation_id, assignment_incarnation_id, purpose, capability_key, mode, scope_id)
     values ('${tenant}', '${secondMandate}', '${grant}', '${executionAssignment}', 'execution', '${voidKey}', 'run', '${scopeNajempark}')`,
    // The witness guard finds no live assignment of that holder in the other scope first, and the
    // foreign key to the approval rejects the row as well; either refusal is the same verdict.
    [CHECK, FOREIGN_KEY],
  );
  yield* refuse(
    'a witness is held in the mode its purpose requires',
    `insert into ${table('access_mandate_grants')}
       (tenant_id, mandate_id, grant_incarnation_id, assignment_incarnation_id, purpose, capability_key, mode, scope_id)
     values ('${tenant}', '${secondMandate}', '${grant}', '${executionAssignment}', 'approval', '${voidKey}', 'run', '${scopeAkros}')`,
    [CHECK],
  );
  yield* refuse(
    'the requester witness belongs to the requester itself',
    `insert into ${table('access_mandate_grants')}
       (tenant_id, mandate_id, grant_incarnation_id, assignment_incarnation_id, purpose, capability_key, mode, scope_id)
     values ${witnessRow({ assignment: secondAssignment, capabilityKey: voidKey, grant: proposeGrant, mandate: secondMandate, mode: 'propose', purpose: 'requester' })}`,
    [CHECK],
  );
  yield* refuse(
    "an agent never holds the approving person's execution witness (O63)",
    `insert into ${table('access_mandate_grants')}
       (tenant_id, mandate_id, grant_incarnation_id, assignment_incarnation_id, purpose, capability_key, mode, scope_id)
     values ${witnessRow({ assignment: uid(54), capabilityKey: voidKey, grant, mandate: secondMandate, mode: 'run', purpose: 'execution' })}`,
    [CHECK],
  );
  yield* refuse(
    'a witness is held by a live assignment',
    `insert into ${table('access_mandate_grants')}
       (tenant_id, mandate_id, grant_incarnation_id, assignment_incarnation_id, purpose, capability_key, mode, scope_id)
     values ${witnessRow({ assignment, capabilityKey: voidKey, grant: proposeGrant, mandate: secondMandate, mode: 'propose', purpose: 'requester' })}`,
    [CHECK],
  );
  yield* refuse(
    'the approval witness is the assignment the approval names',
    `insert into ${table('access_mandate_grants')}
       (tenant_id, mandate_id, grant_incarnation_id, assignment_incarnation_id, purpose, capability_key, mode, scope_id)
     values ${witnessRow({ assignment: executionAssignment, capabilityKey: voidKey, grant: approveGrant, mandate: secondMandate, mode: 'approve', purpose: 'approval' })}`,
    [CHECK],
  );
  yield* refuse(
    'a witness grant belongs to the role its assignment holds (R4-M3)',
    `insert into ${table('access_mandate_grants')}
       (tenant_id, mandate_id, grant_incarnation_id, assignment_incarnation_id, purpose, capability_key, mode, scope_id)
     values ${witnessRow({ assignment: executionAssignment, capabilityKey: voidKey, grant: localGrant, mandate: secondMandate, mode: 'run', purpose: 'execution' })}`,
    [CHECK],
  );
  yield* refuse(
    'a witness is held by a live grant incarnation (R4-M3)',
    `insert into ${table('access_mandate_grants')}
       (tenant_id, mandate_id, grant_incarnation_id, assignment_incarnation_id, purpose, capability_key, mode, scope_id)
     values ${witnessRow({ assignment: executionAssignment, capabilityKey: readKey, grant: readGrant, mandate: secondMandate, mode: 'run', purpose: 'parent_record_read' })}`,
    [CHECK],
  );
  yield* refuse(
    'an execution witness is held on the capability the proposal commands (R4-M3)',
    `insert into ${table('access_mandate_grants')}
       (tenant_id, mandate_id, grant_incarnation_id, assignment_incarnation_id, purpose, capability_key, mode, scope_id)
     values ${witnessRow({ assignment: executionAssignment, capabilityKey: readKey, grant: readGrant, mandate: secondMandate, mode: 'run', purpose: 'execution' })}`,
    [CHECK],
  );
  yield* refuse(
    'a witness is never rewritten',
    `update ${table('access_mandate_grants')} set mode = 'run' where mandate_id = '${mandate}'`,
    [GUARD],
  );
  yield* refuse('mandate witnesses are never truncated', `truncate ${table('access_mandate_grants')}`, [GUARD]);

  // A withdrawn approval keeps the record it was withdrawn from (O57).
  yield* allow(
    `update ${table('access_proposals')} set status = 'lapsed', ended_at = now() where proposal_id = '${proposal}'`,
  );
  yield* refuse(
    'a lapsed proposal keeps its end time',
    `update ${table('access_proposals')} set ended_at = now() + interval '1 hour' where proposal_id = '${proposal}'`,
    [GUARD],
  );
  yield* refuse(
    'a terminal proposal never leaves its terminal state',
    `update ${table('access_proposals')} set status = 'approved' where proposal_id = '${proposal}'`,
    [GUARD, CHECK],
  );
  yield* refuse(
    'a proposal is never deleted',
    `delete from ${table('access_proposals')} where proposal_id = '${thirdProposal}'`,
    [GUARD],
  );
  yield* refuse('proposals are never truncated', `truncate ${table('access_proposals')} cascade`, [GUARD]);

  // ---- M2: an envelope never grows in place --------------------------------------------------
  yield* refuse(
    'a delegation envelope never widens',
    `update ${table('access_delegations')} set capability_keys = array['${voidKey}', '${readKey}']
      where delegation_id = '${delegation}'`,
    [GUARD],
  );
  yield* refuse(
    'a delegation deadline never extends',
    `update ${table('access_delegations')} set until = now() + interval '30 days' where delegation_id = '${delegation}'`,
    [GUARD],
  );
  yield* allow(`update ${table('access_delegations')} set status = 'revoked' where delegation_id = '${delegation}'`);
  yield* refuse(
    'a revoked delegation never returns to active',
    `update ${table('access_delegations')} set status = 'active' where delegation_id = '${delegation}'`,
    [GUARD],
  );
  yield* refuse(
    'a delegation is never deleted',
    `delete from ${table('access_delegations')} where delegation_id = '${delegation}'`,
    [GUARD],
  );
  yield* refuse('delegations are never truncated', `truncate ${table('access_delegations')} cascade`, [GUARD]);
  yield* refuse(
    'a connection ceiling never widens in place',
    `update ${table('access_agent_connections')} set ceiling_json = '{"cells": [{"capabilityKey": "${voidKey}", "mode": "run", "selector": {"_tag": "all"}}]}'::jsonb
      where connection_id = '${connection}'`,
    [GUARD],
  );
  yield* refuse(
    'a connection revision never changes in place',
    `update ${table('access_agent_connections')} set revision = 2 where connection_id = '${connection}'`,
    [GUARD],
  );
  yield* allow(
    `update ${table('access_agent_connections')} set status = 'revoked' where connection_id = '${connection}'`,
  );
  yield* refuse(
    'a revoked connection never returns to active',
    `update ${table('access_agent_connections')} set status = 'active' where connection_id = '${connection}'`,
    [GUARD],
  );
  yield* refuse(
    'a connection is never deleted',
    `delete from ${table('access_agent_connections')} where connection_id = '${connection}'`,
    [GUARD],
  );
  yield* refuse('connections are never truncated', `truncate ${table('access_agent_connections')} cascade`, [GUARD]);

  // ---- Novinky: an item moves once, and an undone item is final (O54) ------------------------
  yield* refuse(
    'a pending item is never undone directly',
    `update ${table('access_change_items')} set status = 'undone' where item_id = '${secondChangeItem}'`,
    [GUARD],
  );
  yield* allow(`update ${table('access_change_items')} set status = 'adopted' where item_id = '${changeItem}'`);
  yield* allow(`update ${table('access_change_items')} set status = 'undone' where item_id = '${changeItem}'`);
  yield* refuse(
    'an undone item is never adopted again',
    `update ${table('access_change_items')} set status = 'adopted' where item_id = '${changeItem}'`,
    [GUARD],
  );
  yield* refuse(
    'an item keeps the release identity it describes',
    `update ${table('access_change_items')} set risk = 'critical' where item_id = '${secondChangeItem}'`,
    [GUARD],
  );
  yield* refuse(
    'a change decision is append-only',
    `update ${table('access_change_decisions')} set decision = 'decline' where decision_id = '${changeDecision}'`,
    [GUARD],
  );
  yield* refuse('change decisions are never truncated', `truncate ${table('access_change_decisions')} cascade`, [
    GUARD,
  ]);
  yield* refuse(
    'a change item is never deleted',
    `delete from ${table('access_change_items')} where item_id = '${secondChangeItem}'`,
    [GUARD],
  );
  yield* refuse('change items are never truncated', `truncate ${table('access_change_items')} cascade`, [GUARD]);

  // ---- Evidence tables are append-only -------------------------------------------------------
  yield* refuse(
    'a consent snapshot is append-only',
    `update ${table('access_consent_snapshots')} set ceiling_json = '{"cells": []}'::jsonb where connection_id = '${connection}'`,
    [GUARD],
  );
  yield* refuse('consent snapshots are never truncated', `truncate ${table('access_consent_snapshots')}`, [GUARD]);
  yield* refuse(
    'a decision log is append-only',
    `update ${table('access_decision_logs')} set outcome = 'ALLOWED' where decision_log_id = '${decisionLog}'`,
    [GUARD],
  );
  yield* refuse('decision logs are never truncated', `truncate ${table('access_decision_logs')}`, [GUARD]);
  yield* refuse(
    'a role revision is immutable',
    `update ${table('access_role_revisions')} set cells_json = '[]'::jsonb where role_revision_id = '${roleRevision1}'`,
    [GUARD],
  );
  yield* refuse('role revisions are never truncated', `truncate ${table('access_role_revisions')} cascade`, [GUARD]);
  yield* refuse(
    'a catalog snapshot is append-only',
    `update ${table('access_catalog_snapshots')} set digest = '${'d'.repeat(64)}' where catalog_snapshot_id = '${catalogSnapshot}'`,
    [GUARD],
  );
  yield* refuse('catalog entries are never truncated', `truncate ${table('access_catalog_entries')} cascade`, [GUARD]);

  // ---- Journals only advance, and a fence belongs to its operation ---------------------------
  yield* allow(
    `update ${table('access_operation_journals')} set phase = 'fenced', updated_at = now() where operation_id = '${journal}'`,
  );
  yield* refuse(
    'a journal never goes backwards',
    `update ${table('access_operation_journals')} set phase = 'validated', updated_at = now() where operation_id = '${journal}'`,
    [GUARD],
  );
  yield* refuse(
    'a committed journal never fails afterwards',
    `update ${table('access_operation_journals')} set phase = 'failed', failure_code = 'projection.unavailable' where operation_id = '${committedJournal}'`,
    [GUARD],
  );
  yield* refuse(
    'a journal belongs to the operation that started it',
    `update ${table('access_operation_journals')} set command_digest = '${'e'.repeat(64)}' where operation_id = '${journal}'`,
    [GUARD],
  );
  // R4-L3: a terminal journal's content is final, not only its phase.
  yield* refuse(
    'a committed journal never rewrites its projection token',
    `update ${table('access_operation_journals')} set projection_token = 'rewritten'
      where operation_id = '${committedJournal}'`,
    [GUARD],
  );
  yield* allow(`update ${table('access_operation_journals')} set phase = 'failed', failure_code = 'projection.unavailable',
    updated_at = now() where operation_id = '${journal}'`);
  yield* refuse(
    'a failed journal never rewrites its failure code',
    `update ${table('access_operation_journals')} set failure_code = 'projection.rejected'
      where operation_id = '${journal}'`,
    [GUARD],
  );
  yield* refuse(
    'a journal is never deleted',
    `delete from ${table('access_operation_journals')} where operation_id = '${journal}'`,
    [GUARD],
  );
  yield* refuse('journals are never truncated', `truncate ${table('access_operation_journals')} cascade`, [GUARD]);
  yield* refuse(
    'a fence is never deleted',
    `delete from ${table('access_scope_fences')} where scope_id = '${scopeNajempark}'`,
    [GUARD],
  );
  yield* refuse('fences are never truncated', `truncate ${table('access_scope_fences')}`, [GUARD]);

  // Every probe above ran against a schema that only this suite created.
  const remaining = yield* admin.unsafe<{ readonly name: string }>(
    `select table_name as name from information_schema.tables where table_schema = $1`,
    [schemaName],
  );
  expect(remaining.length).toBeGreaterThan(0);
});

it.layer(NodeServices.layer)('the access intent migration enforces its triggers', (suite) => {
  suite.effect(
    'refuses every forbidden write and accepts the allowed one beside it',
    Effect.fnUntraced(function* accessIntentMigrationEffect() {
      yield* accessMigrationProgram;
    }),
  );
});
