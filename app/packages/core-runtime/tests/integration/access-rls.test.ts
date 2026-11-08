import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Crypto, Effect, FileSystem, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { findPostgresFailure } from '../../src/database/postgres-failure.ts';
import { makeTestPgClient, makeTestPgSession } from '../support/database.ts';

/*
 * Tenant isolation is a database fact, not a repository convention (guarantee 2, D3). This suite
 * applies the real access migration into a schema of its own, grants the runtime role what the
 * bootstrap grants it in `core`, and then proves as `ontos_runtime` itself that tenant A cannot
 * read, insert, update or delete tenant B's rows in any of the 16 tenant access tables, while the
 * same operation on its own tenant reaches its own row. The release catalog stays global: no row
 * security, and the same rows are visible whatever tenant context the caller installs.
 *
 * Every refusal is paired with the allowed write beside it, so a table that refuses everything (a
 * missing grant, a trigger that fires too early) can never look isolated.
 */
const migrationPath = new URL(
  '../../drizzle/20261103093547_authorization-v2-access-intent/migration.sql',
  import.meta.url,
).pathname;

const TENANT_TABLES = [
  'access_scopes',
  'access_roles',
  'access_role_revisions',
  'access_assignments',
  'access_grant_incarnations',
  'access_delegations',
  'access_agent_connections',
  'access_consent_snapshots',
  'access_change_items',
  'access_change_decisions',
  'access_operation_journals',
  'access_scope_fences',
  'access_decision_logs',
  'access_proposals',
  'access_mandates',
  'access_mandate_grants',
  'access_memberships',
  'access_teams',
  'access_team_members',
  'access_workload_bindings',
  'access_frozen_commands',
] as const;
const CATALOG_TABLES = ['access_catalog_snapshots', 'access_catalog_entries'] as const;
type TenantTable = (typeof TENANT_TABLES)[number];

const GUARD = '55000';
const RESTRICT = '23001';
const FOREIGN_KEY = '23503';
const PRIVILEGE = '42501';

const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const digest = (letter: string) => letter.repeat(64);
const readKey = 'finance.invoice.read';
const voidKey = 'finance.invoice.void';

const idsOf = (base: number) => ({
  adminMembership: uid(base + 26),
  agent: uid(base + 10),
  approveGrant: uid(base + 21),
  approver: uid(base + 5),
  assignment: uid(base + 8),
  changeDecision: uid(base + 13),
  changeItem: uid(base + 14),
  connection: uid(base + 11),
  decisionLog: uid(base + 16),
  delegation: uid(base + 9),
  entity: uid(base + 1),
  frozenProposal: uid(base + 12),
  grant: uid(base + 7),
  human: uid(base + 4),
  journal: uid(base + 15),
  mandate: uid(base + 17),
  membership: uid(base + 24),
  ownerMembership: uid(base + 25),
  proposal: uid(base + 12),
  proposeGrant: uid(base + 23),
  revision: uid(base + 6),
  role: uid(base + 20),
  runGrant: uid(base + 22),
  scopeEntity: uid(base + 3),
  scopeTenant: uid(base + 2),
  team: uid(base + 27),
  teamMember: uid(base + 28),
  tenant: uid(base),
  workloadBinding: uid(base + 29),
  workloadIncarnation: uid(base + 30),
});
type TenantIds = ReturnType<typeof idsOf>;

interface RowProbe {
  /** The column that tells one tenant's row from another's. */
  readonly column: string;
  /**
   * What writing another tenant's row is refused with. Row security answers first on almost every
   * table; an approval record and its witnesses are also guarded by a `BEFORE` trigger that reads the
   * proposal, which row security hides from this tenant, so the guard reports the missing reference
   * instead. Both are the same refusal: nothing of another tenant is written here.
   */
  readonly foreignInsert?: string;
  /** What deleting the caller's own row does: the evidence tables keep it, a parent keeps it too. */
  readonly ownDelete: string;
  /** What updating the caller's own row does: only mutable tables accept it. */
  readonly ownUpdate: string;
  /** The caller's own row in this table. */
  readonly row: (ids: TenantIds) => string;
}

/**
 * No foreign probe may ever produce any of these outcomes: row security hides the other tenant's
 * row before a status trigger or a foreign key can see it, so the foreign answer is always zero rows.
 */
const OWN_ROW = {
  access_agent_connections: {
    column: 'connection_id',
    ownDelete: GUARD,
    ownUpdate: 'accepted:1',
    row: (ids) => ids.connection,
  },
  access_assignments: {
    column: 'incarnation_id',
    ownDelete: GUARD,
    ownUpdate: 'accepted:1',
    row: (ids) => ids.assignment,
  },
  access_change_decisions: {
    column: 'decision_id',
    ownDelete: GUARD,
    ownUpdate: GUARD,
    row: (ids) => ids.changeDecision,
  },
  access_change_items: {
    column: 'item_id',
    ownDelete: GUARD,
    ownUpdate: 'accepted:1',
    row: (ids) => ids.changeItem,
  },
  access_consent_snapshots: {
    column: 'connection_id',
    ownDelete: GUARD,
    ownUpdate: GUARD,
    row: (ids) => ids.connection,
  },
  access_decision_logs: {
    column: 'decision_log_id',
    ownDelete: GUARD,
    ownUpdate: GUARD,
    row: (ids) => ids.decisionLog,
  },
  access_delegations: {
    column: 'delegation_id',
    ownDelete: GUARD,
    ownUpdate: 'accepted:1',
    row: (ids) => ids.delegation,
  },
  access_frozen_commands: {
    column: 'proposal_id',
    ownDelete: 'accepted:0',
    ownUpdate: 'accepted:0',
    row: (ids) => ids.frozenProposal,
  },
  access_grant_incarnations: {
    column: 'grant_incarnation_id',
    ownDelete: GUARD,
    ownUpdate: 'accepted:1',
    row: (ids) => ids.grant,
  },
  access_mandate_grants: {
    column: 'grant_incarnation_id',
    foreignInsert: FOREIGN_KEY,
    ownDelete: GUARD,
    ownUpdate: GUARD,
    row: (ids) => ids.approveGrant,
  },
  access_mandates: {
    column: 'mandate_id',
    foreignInsert: FOREIGN_KEY,
    ownDelete: GUARD,
    ownUpdate: GUARD,
    row: (ids) => ids.mandate,
  },
  access_memberships: {
    column: 'membership_id',
    ownDelete: GUARD,
    ownUpdate: 'accepted:1',
    row: (ids) => ids.membership,
  },
  access_operation_journals: {
    column: 'operation_id',
    ownDelete: GUARD,
    ownUpdate: 'accepted:1',
    row: (ids) => ids.journal,
  },
  access_proposals: {
    column: 'proposal_id',
    ownDelete: GUARD,
    ownUpdate: 'accepted:1',
    row: (ids) => ids.proposal,
  },
  access_role_revisions: {
    column: 'role_revision_id',
    ownDelete: GUARD,
    ownUpdate: GUARD,
    row: (ids) => ids.revision,
  },
  access_roles: { column: 'role_id', ownDelete: RESTRICT, ownUpdate: 'accepted:1', row: (ids) => ids.role },
  access_scope_fences: {
    column: 'scope_id',
    ownDelete: GUARD,
    ownUpdate: 'accepted:1',
    row: (ids) => ids.scopeTenant,
  },
  access_scopes: { column: 'scope_id', ownDelete: GUARD, ownUpdate: GUARD, row: (ids) => ids.scopeEntity },
  access_teams: { column: 'team_id', ownDelete: GUARD, ownUpdate: 'accepted:1', row: (ids) => ids.team },
  // A team membership is current intent, so a holder leaving the team removes the row and keeps the
  // team identity itself (O24).
  access_team_members: {
    column: 'team_member_id',
    ownDelete: 'accepted:1',
    ownUpdate: 'accepted:1',
    row: (ids) => ids.teamMember,
  },
  // A binding is current intent: it is revoked (an update) or removed, and a re-bind is a new row.
  access_workload_bindings: {
    column: 'binding_id',
    ownDelete: 'accepted:1',
    ownUpdate: 'accepted:1',
    row: (ids) => ids.workloadBinding,
  },
} satisfies Record<TenantTable, RowProbe>;
/** The probe for one table, as the interface declares it: the optional arms are not narrowed away. */
const probeOf = (name: TenantTable): RowProbe => OWN_ROW[name];

/**
 * One tenant's witnesses, spelled the way the model and the migration spell them: the requester holds
 * a propose-mode cell of the command, the approving person an approve-mode cell of it and a run-mode
 * cell to execute it (O63).
 */
const authorityJson = (ids: TenantIds) =>
  `[{"assignmentIncarnationId": "${ids.assignment}", "capabilityKey": "${voidKey}", "grantIncarnationId": "${ids.proposeGrant}", "holderId": {"_tag": "Principal", "principalId": "${ids.human}"}, "mode": "propose", "purpose": "requester", "scopeId": "${ids.scopeEntity}"}]`;

interface TenantFixture {
  /** How many rows this statement writes when the tenant is allowed to write it. */
  readonly rows: number;
  readonly statement: string;
  readonly table: TenantTable;
}

/**
 * One tenant's complete, self-consistent intent set: the same fixtures the trigger suite writes,
 * written twice so every table holds one visible and one invisible row. Each statement reports what
 * it wrote, so a silently filtered insert can never pass as an accepted one.
 */
const tenantFixtures = (ids: TenantIds, catalogSnapshotId: string): readonly TenantFixture[] => [
  {
    rows: 2,
    statement: `insert into "core"."access_scopes" (scope_id, tenant_id, tenant_context_id, legal_entity_id)
      values ('${ids.scopeTenant}', '${ids.tenant}', '${ids.tenant}', null),
             ('${ids.scopeEntity}', '${ids.tenant}', null, '${ids.entity}') returning 1 as affected`,
    table: 'access_scopes',
  },
  {
    rows: 3,
    statement: `insert into "core"."access_memberships"
      (membership_id, tenant_id, scope_id, principal_id, kind, status, recorded_by, valid_from)
    values ('${ids.membership}', '${ids.tenant}', '${ids.scopeTenant}', '${ids.human}', 'member', 'active',
            '${ids.human}', now()),
           ('${ids.ownerMembership}', '${ids.tenant}', '${ids.scopeTenant}', '${ids.human}', 'owner', 'active',
            '${ids.human}', now()),
           ('${ids.adminMembership}', '${ids.tenant}', '${ids.scopeEntity}', '${ids.human}', 'access_admin', 'active',
            '${ids.human}', now())
    returning 1 as affected`,
    table: 'access_memberships',
  },
  {
    rows: 1,
    statement: `insert into "core"."access_roles" (role_id, tenant_id, created_by, legal_entity_id, name)
      values ('${ids.role}', '${ids.tenant}', '${ids.human}', null, 'Účetní') returning 1 as affected`,
    table: 'access_roles',
  },
  {
    rows: 1,
    statement: `insert into "core"."access_role_revisions"
      (role_revision_id, tenant_id, role_id, revision, catalog_snapshot_id, cells_json, created_by, provenance)
    values ('${ids.revision}', '${ids.tenant}', '${ids.role}', 1, '${catalogSnapshotId}',
            '[{"capabilityKey": "${readKey}", "mode": "run", "selector": {"_tag": "all"}}]'::jsonb,
            '${ids.human}', 'imported') returning 1 as affected`,
    table: 'access_role_revisions',
  },
  {
    rows: 1,
    statement: `insert into "core"."access_assignments"
      (incarnation_id, tenant_id, scope_id, role_id, role_revision_id, principal_id, assigned_by, status, valid_from)
    values ('${ids.assignment}', '${ids.tenant}', '${ids.scopeEntity}', '${ids.role}', '${ids.revision}',
            '${ids.human}', '${ids.approver}', 'active', now()) returning 1 as affected`,
    table: 'access_assignments',
  },
  {
    rows: 4,
    statement: `insert into "core"."access_grant_incarnations"
      (grant_incarnation_id, tenant_id, scope_id, role_id, capability_key, mode, slot, cell_json, status)
    values ('${ids.grant}', '${ids.tenant}', '${ids.scopeEntity}', '${ids.role}', '${readKey}', 'run', 'all',
            '{"capabilityKey": "${readKey}", "mode": "run", "selector": {"_tag": "all"}}'::jsonb, 'active'),
           ('${ids.approveGrant}', '${ids.tenant}', '${ids.scopeEntity}', '${ids.role}', '${voidKey}', 'approve', 'all',
            '{"capabilityKey": "${voidKey}", "mode": "approve", "selector": {"_tag": "all"}}'::jsonb, 'active'),
           ('${ids.runGrant}', '${ids.tenant}', '${ids.scopeEntity}', '${ids.role}', '${voidKey}', 'run', 'all',
            '{"capabilityKey": "${voidKey}", "mode": "run", "selector": {"_tag": "all"}}'::jsonb, 'active'),
           ('${ids.proposeGrant}', '${ids.tenant}', '${ids.scopeEntity}', '${ids.role}', '${voidKey}', 'propose', 'all',
            '{"capabilityKey": "${voidKey}", "mode": "propose", "selector": {"_tag": "all"}}'::jsonb, 'active')
    returning 1 as affected`,
    table: 'access_grant_incarnations',
  },
  {
    rows: 1,
    statement: `insert into "core"."access_delegations" (delegation_id, tenant_id, scope_id, granted_by, manager_id,
       people, role_ids, capability_keys, amount_ceiling_json, status, valid_from, until)
    values ('${ids.delegation}', '${ids.tenant}', '${ids.scopeEntity}', '${ids.human}', '${ids.approver}',
            array['${ids.agent}'::uuid], array['${ids.role}'::uuid], array['${readKey}'],
            '{"currency": "CZK", "limitMinor": 100000}'::jsonb, 'active', now(), now() + interval '1 day')
    returning 1 as affected`,
    table: 'access_delegations',
  },
  {
    rows: 1,
    statement: `insert into "core"."access_agent_connections"
      (connection_id, tenant_id, scope_id, agent_id, principal_id, revision, ceiling_json, status, valid_from, valid_until)
    values ('${ids.connection}', '${ids.tenant}', '${ids.scopeEntity}', '${ids.agent}', '${ids.human}', 1,
            '{"cells": []}'::jsonb, 'active', now(), now() + interval '1 day') returning 1 as affected`,
    table: 'access_agent_connections',
  },
  {
    rows: 1,
    statement: `insert into "core"."access_consent_snapshots"
      (tenant_id, connection_id, revision, ceiling_json, granted_at, granted_by)
    values ('${ids.tenant}', '${ids.connection}', 1, '{"cells": []}'::jsonb, now(), '${ids.human}')
    returning 1 as affected`,
    table: 'access_consent_snapshots',
  },
  {
    rows: 1,
    statement: `insert into "core"."access_change_items"
      (item_id, tenant_id, capability_key, catalog_snapshot_id, kind, lineage_from, risk, status, suggested_role_ids)
    values ('${ids.changeItem}', '${ids.tenant}', '${readKey}', '${catalogSnapshotId}', 'new', array[]::text[],
            'routine', 'pending', array['${ids.role}'::uuid]) returning 1 as affected`,
    table: 'access_change_items',
  },
  {
    rows: 1,
    statement: `insert into "core"."access_change_decisions"
      (decision_id, tenant_id, batch_id, item_id, decision, decided_by, decided_at, role_revision_ids)
    values ('${ids.changeDecision}', '${ids.tenant}', '${uid(700)}', '${ids.changeItem}', 'adopt', '${ids.human}',
            now(), array['${ids.revision}'::uuid]) returning 1 as affected`,
    table: 'access_change_decisions',
  },
  {
    rows: 1,
    statement: `insert into "core"."access_operation_journals"
      (operation_id, tenant_id, scope_id, command_digest, phase, started_at, updated_at)
    values ('${ids.journal}', '${ids.tenant}', '${ids.scopeEntity}', '${digest('b')}', 'validated', now(), now())
    returning 1 as affected`,
    table: 'access_operation_journals',
  },
  {
    rows: 1,
    statement: `insert into "core"."access_scope_fences" (scope_id, tenant_id, state, revision)
    values ('${ids.scopeTenant}', '${ids.tenant}', 'Ready', 1) returning 1 as affected`,
    table: 'access_scope_fences',
  },
  {
    rows: 1,
    statement: `insert into "core"."access_decision_logs"
      (decision_log_id, tenant_id, scope_id, actor_json, actor_principal_id, capability_key, correlation_id,
       decided_at, mode, outcome, reasons_json)
    values ('${ids.decisionLog}', '${ids.tenant}', '${ids.scopeEntity}',
            '{"_tag": "Principal", "principalId": "${ids.human}"}'::jsonb, '${ids.human}', '${readKey}',
            'request-1', now(), 'run', 'DENIED', '[{"code": "grant.missing"}]'::jsonb) returning 1 as affected`,
    table: 'access_decision_logs',
  },
  {
    rows: 1,
    statement: `insert into "core"."access_proposals"
      (proposal_id, tenant_id, scope_id, capability_key, command_digest, created_at, expires_at, requester_json,
       requester_principal_id, status, requester_authority_json)
    values ('${ids.proposal}', '${ids.tenant}', '${ids.scopeEntity}', '${voidKey}', '${digest('c')}', now(),
            now() + interval '1 day', '{"_tag": "Principal", "principalId": "${ids.human}"}'::jsonb,
            '${ids.human}', 'pending', '${authorityJson(ids)}'::jsonb) returning 1 as affected`,
    table: 'access_proposals',
  },
  {
    rows: 1,
    statement: `insert into "core"."access_frozen_commands"
      (tenant_id, proposal_id, scope_id, capability_key, action_key, command_digest, command_json)
    values ('${ids.tenant}', '${ids.proposal}', '${ids.scopeEntity}', '${voidKey}', 'finance.invoice.void',
            '${digest('c')}', '{"capabilityKey":"${voidKey}","payload":{}}'::jsonb) returning 1 as affected`,
    table: 'access_frozen_commands',
  },
  // The approval record owns the approval (M5): it names the frozen command of that one proposal and
  // the approving person's own live assignment, and it carries neither a status nor a second copy of
  // the witnesses, which live once, as rows of `access_mandate_grants`.
  {
    rows: 1,
    statement: `insert into "core"."access_mandates"
      (mandate_id, proposal_id, tenant_id, scope_id, capability_key, command_digest, approved_at,
       approval_expires_at, approver_id, approver_assignment_incarnation_id, execution_assignment_incarnation_id)
    values ('${ids.mandate}', '${ids.proposal}', '${ids.tenant}', '${ids.scopeEntity}', '${voidKey}',
            '${digest('c')}', now(), now() + interval '1 hour', '${ids.human}', '${ids.assignment}',
            '${ids.assignment}') returning 1 as affected`,
    table: 'access_mandates',
  },
  {
    rows: 2,
    statement: `insert into "core"."access_mandate_grants"
      (tenant_id, mandate_id, grant_incarnation_id, assignment_incarnation_id, purpose, capability_key, mode, scope_id)
    values ('${ids.tenant}', '${ids.mandate}', '${ids.approveGrant}', '${ids.assignment}', 'approval', '${voidKey}',
            'approve', '${ids.scopeEntity}'),
           ('${ids.tenant}', '${ids.mandate}', '${ids.runGrant}', '${ids.assignment}', 'execution', '${voidKey}',
            'run', '${ids.scopeEntity}') returning 1 as affected`,
    table: 'access_mandate_grants',
  },
  {
    rows: 1,
    statement: `insert into "core"."access_teams" (team_id, tenant_id, scope_id, created_by, name)
    values ('${ids.team}', '${ids.tenant}', '${ids.scopeEntity}', '${ids.human}', 'Skladníci')
    returning 1 as affected`,
    table: 'access_teams',
  },
  {
    rows: 1,
    statement: `insert into "core"."access_team_members"
      (team_member_id, tenant_id, team_id, principal_id, added_by, added_at)
    values ('${ids.teamMember}', '${ids.tenant}', '${ids.team}', '${ids.human}', '${ids.human}', now())
    returning 1 as affected`,
    table: 'access_team_members',
  },
  {
    rows: 1,
    statement: `insert into "core"."access_workload_bindings"
      (binding_id, tenant_id, principal_id, workload_key, status, incarnation, created_at)
    values ('${ids.workloadBinding}', '${ids.tenant}', '${ids.human}', 'finance.machine-provisioner', 'active',
            '${ids.workloadIncarnation}', now())
    returning 1 as affected`,
    table: 'access_workload_bindings',
  },
];

const queryEffect = <Row extends object>(
  client: PgClient.PgClient,
  statement: string,
  parameters: readonly unknown[] = [],
): Effect.Effect<readonly Row[]> => client.unsafe<Row>(statement, parameters).pipe(Effect.orDie);

/** The SQLSTATE of a refused statement, or `accepted:<rows>` when PostgreSQL took it. */
const outcomeOf = (
  client: PgClient.PgClient,
  statement: string,
  parameters: readonly unknown[] = [],
): Effect.Effect<string> =>
  Effect.match(client.unsafe(statement, parameters), {
    onFailure: (failure) => Option.getOrUndefined(findPostgresFailure(failure))?.code ?? 'none',
    onSuccess: (rows) => `accepted:${rows.length}`,
  });

const accessRlsProgram = Effect.gen(function* accessTenantIsolation() {
  const connections = yield* loadDatabaseConnectionPair();
  const admin = yield* makeTestPgClient(connections.admin.connectionString);
  // One physical session: the tenant setting is transaction-local and must never leak to the next
  // statement, so every probe gets its own transaction on this connection.
  const runtime = yield* makeTestPgSession(connections.runtime.connectionString);
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const schemaName = `access_rls_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
  const schema = `"${schemaName}"`;
  const table = (name: TenantTable | (typeof CATALOG_TABLES)[number]) => `${schema}."${name}"`;
  const catalogSnapshotId = uid(600);
  const tenantA = idsOf(100);
  const tenantB = idsOf(200);
  /** The fixtures name their tables the way the schema does; move them into this suite's schema. */
  const inSchema = (fixture: TenantFixture): TenantFixture => ({
    ...fixture,
    statement: fixture.statement.replaceAll('"core".', `${schema}.`),
  });
  const fixturesA = tenantFixtures(tenantA, catalogSnapshotId).map(inSchema);

  yield* queryEffect(admin, `create schema ${schema}`);
  yield* Effect.addFinalizer(() => queryEffect(admin, `drop schema if exists ${schema} cascade`));

  // The tables live in `core` and the guard functions are defined in it; both move together so the
  // suite can apply the committed migration, unchanged, to a schema of its own.
  const migration = yield* fileSystem.readFileString(migrationPath);
  for (const statement of [
    `create table ${schema}.tenants (tenant_id uuid primary key)`,
    `create table ${schema}.legal_entities (
       tenant_id uuid not null,
       legal_entity_id uuid primary key,
       unique (tenant_id, legal_entity_id)
     )`,
    `create table ${schema}.principals (
       tenant_id uuid not null,
       principal_id uuid primary key,
       kind text not null,
       unique (tenant_id, principal_id)
     )`,
    // The policies name the runtime and the explicit request role; both exist in the real database
    // and must exist here.
    `do $$
     begin
       if not exists (select 1 from pg_roles where rolname = 'ontos_runtime') then
         create role ontos_runtime nologin;
       end if;
       if not exists (select 1 from pg_roles where rolname = 'party_registry_runtime') then
         create role party_registry_runtime nologin;
       end if;
     end
     $$`,
    // The gateway-request policies call the trusted-scope function an earlier trust migration defines.
    // This suite applies only the access migration, so it stands that schema up itself, without
    // touching a `trust` schema a real database already has.
    `do $trust$
     begin
       if not exists (select 1 from pg_namespace where nspname = 'trust') then
         create schema trust;
       end if;
       if not exists (
         select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'trust' and p.proname = 'current_tenant_id'
       ) then
         create function trust.current_tenant_id() returns uuid language sql stable as
           $fn$ select nullif(current_setting('ontos.tenant_id', true), '')::uuid $fn$;
       end if;
     end
     $trust$`,
    ...migration.replaceAll('"core"', schema).replaceAll('core.', `${schemaName}.`).split('--> statement-breakpoint'),
  ]) {
    if (statement.trim().length > 0) {
      yield* queryEffect(admin, statement);
    }
  }
  // Exactly what the runtime-role bootstrap grants the shared runtime in `core` after a migration.
  yield* queryEffect(admin, `grant usage on schema ${schema} to ontos_runtime`);
  yield* queryEffect(admin, `grant select, insert, update, delete on all tables in schema ${schema} to ontos_runtime`);
  yield* queryEffect(admin, `revoke update, delete on ${table('access_frozen_commands')} from ontos_runtime`);

  const relations = yield* queryEffect<{
    relforcerowsecurity: boolean;
    relname: string;
    relrowsecurity: boolean;
  }>(
    admin,
    `select relation.relname, relation.relrowsecurity, relation.relforcerowsecurity
       from pg_catalog.pg_class as relation
       join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = $1 and relation.relkind = 'r'
      order by relation.relname`,
    [schemaName],
  );
  const securityOf = (name: string) => {
    const relation = relations.find(({ relname }) => relname === name);
    return [relation?.relrowsecurity, relation?.relforcerowsecurity];
  };
  for (const name of TENANT_TABLES) {
    expect([name, securityOf(name)]).toEqual([name, [true, true]]);
  }
  for (const name of CATALOG_TABLES) {
    // A release is global. Row security without a policy grants nothing, so the catalog keeps none
    // and every runtime reads the release the Core publication path wrote.
    expect([name, securityOf(name)]).toEqual([name, [false, false]]);
  }

  for (const ids of [tenantA, tenantB]) {
    yield* queryEffect(admin, `insert into ${schema}.tenants (tenant_id) values ('${ids.tenant}')`);
    yield* queryEffect(
      admin,
      `insert into ${schema}.legal_entities (tenant_id, legal_entity_id) values ('${ids.tenant}', '${ids.entity}')`,
    );
    yield* queryEffect(
      admin,
      `insert into ${schema}.principals (tenant_id, principal_id, kind) values
        ('${ids.tenant}', '${ids.human}', 'human'),
        ('${ids.tenant}', '${ids.approver}', 'human'),
        ('${ids.tenant}', '${ids.agent}', 'agent')`,
    );
  }
  yield* queryEffect(
    admin,
    `insert into ${table('access_catalog_snapshots')} (catalog_snapshot_id, digest, published_at)
    values ('${catalogSnapshotId}', '${digest('a')}', now())`,
  );
  yield* queryEffect(
    admin,
    `insert into ${table('access_catalog_entries')} (catalog_snapshot_id, capability_key, entry_json)
    values ('${catalogSnapshotId}', '${readKey}', '{"key": "${readKey}"}'::jsonb),
           ('${catalogSnapshotId}', '${voidKey}', '{"key": "${voidKey}"}'::jsonb)`,
  );
  // The other tenant's rows are written by the table owner, so they exist whatever the runtime may
  // do, and the same statements later show what the runtime is refused.
  const fixturesB = tenantFixtures(tenantB, catalogSnapshotId).map(inSchema);
  /**
   * The transition that turns the pending proposal into the approved pair. It belongs to the same
   * transaction as the approval record: the two rows are required of each other at COMMIT, so the
   * commit below is the evidence that the pair a tenant stores is whole (M5).
   */
  const approveStatement = (ids: TenantIds) =>
    `update ${table('access_proposals')} set status = 'approved' where proposal_id = '${ids.proposal}' returning 1 as affected`;
  yield* queryEffect(admin, 'begin');
  for (const { rows, statement, table: name } of fixturesB) {
    expect([name, yield* outcomeOf(admin, statement)]).toEqual([name, `accepted:${rows}`]);
  }
  expect(['access_proposals approval', yield* outcomeOf(admin, approveStatement(tenantB))]).toEqual([
    'access_proposals approval',
    'accepted:1',
  ]);
  expect(['commit', yield* outcomeOf(admin, 'commit')]).toEqual(['commit', 'accepted:0']);

  // ---- no scope, no rows, on every tenant table ----------------------------------------------
  for (const name of TENANT_TABLES) {
    expect([name, (yield* queryEffect(runtime, `select 1 as present from ${table(name)} limit 1`)).length]).toEqual([
      name,
      0,
    ]);
  }
  // The release catalog is the exception: global, and readable without any tenant context.
  expect(yield* queryEffect(runtime, `select count(*)::int as count from ${table('access_catalog_entries')}`)).toEqual([
    { count: 2 },
  ]);

  // ---- tenant A writes its own intent: the allowed control for every refusal below -----------
  // One transaction: the proposal, the approval record that approves it, the witnesses it binds and
  // the transition itself are one fact, and only the commit can prove it (M5).
  yield* queryEffect(runtime, 'begin');
  yield* queryEffect(runtime, "select set_config('ontos.tenant_id', $1, true)", [tenantA.tenant]);
  for (const { rows, statement, table: name } of fixturesA) {
    expect([name, yield* outcomeOf(runtime, statement)]).toEqual([name, `accepted:${rows}`]);
  }
  expect(['access_proposals approval', yield* outcomeOf(runtime, approveStatement(tenantA))]).toEqual([
    'access_proposals approval',
    'accepted:1',
  ]);
  expect(['commit', yield* outcomeOf(runtime, 'commit')]).toEqual(['commit', 'accepted:0']);

  /** One probe in its own transaction under one tenant's context, rolled back whatever it does. */
  const probe = (tenantId: string, statement: string, parameters: readonly unknown[] = []) =>
    Effect.gen(function* probeInTransaction() {
      yield* queryEffect(runtime, 'begin');
      yield* queryEffect(runtime, "select set_config('ontos.tenant_id', $1, true)", [tenantId]);
      return yield* outcomeOf(runtime, statement, parameters).pipe(Effect.ensuring(queryEffect(runtime, 'rollback')));
    });
  const readProbe = (name: TenantTable, key: string) =>
    `select ${OWN_ROW[name].column} as row_id from ${table(name)} where ${OWN_ROW[name].column} = '${key}'`;
  const updateProbe = (name: TenantTable, key: string) =>
    `update ${table(name)} set ${OWN_ROW[name].column} = ${OWN_ROW[name].column} where ${OWN_ROW[name].column} = '${key}' returning 1 as affected`;
  const deleteProbe = (name: TenantTable, key: string) =>
    `delete from ${table(name)} where ${OWN_ROW[name].column} = '${key}' returning 1 as affected`;

  // ---- the caller's own rows stay reachable and writable, whatever the triggers allow --------
  for (const name of TENANT_TABLES) {
    const own = OWN_ROW[name].row(tenantA);
    expect([name, yield* probe(tenantA.tenant, readProbe(name, own))]).toEqual([name, 'accepted:1']);
    expect([name, yield* probe(tenantA.tenant, updateProbe(name, own))]).toEqual([
      name,
      name === 'access_frozen_commands' ? PRIVILEGE : OWN_ROW[name].ownUpdate,
    ]);
    expect([name, yield* probe(tenantA.tenant, deleteProbe(name, own))]).toEqual([
      name,
      name === 'access_frozen_commands' ? PRIVILEGE : OWN_ROW[name].ownDelete,
    ]);
  }

  // Even a privileged table owner cannot rewrite or erase frozen evidence (the SQL trigger).
  expect(yield* outcomeOf(admin, updateProbe('access_frozen_commands', tenantA.proposal))).toBe(GUARD);
  expect(yield* outcomeOf(admin, deleteProbe('access_frozen_commands', tenantA.proposal))).toBe(GUARD);

  // ---- the other tenant's rows are invisible to every operation ------------------------------
  for (const name of TENANT_TABLES) {
    const foreign = OWN_ROW[name].row(tenantB);
    // The row is really there: the owner sees it and so does the tenant that owns it. Without this
    // control, a tenant filter that simply matches nothing would look identical.
    expect([name, (yield* queryEffect(admin, readProbe(name, foreign))).length]).toEqual([name, 1]);
    expect([name, yield* probe(tenantB.tenant, readProbe(name, foreign))]).toEqual([name, 'accepted:1']);
    expect([name, yield* probe(tenantA.tenant, readProbe(name, foreign))]).toEqual([name, 'accepted:0']);
    expect([name, yield* probe(tenantA.tenant, updateProbe(name, foreign))]).toEqual([
      name,
      name === 'access_frozen_commands' ? PRIVILEGE : 'accepted:0',
    ]);
    expect([name, yield* probe(tenantA.tenant, deleteProbe(name, foreign))]).toEqual([
      name,
      name === 'access_frozen_commands' ? PRIVILEGE : 'accepted:0',
    ]);
  }

  // ---- nothing of another tenant can be written in this one ----------------------------------
  for (const { statement, table: name } of fixturesB) {
    expect([name, yield* probe(tenantA.tenant, statement)]).toEqual([name, probeOf(name).foreignInsert ?? PRIVILEGE]);
  }
});

it.layer(NodeServices.layer)('the access intent tables isolate tenants', (suite) => {
  suite.effect(
    'refuses every cross-tenant read, insert, update and delete and allows the same write inside',
    Effect.fnUntraced(function* accessTenantIsolationEffect() {
      yield* accessRlsProgram;
    }),
  );
});
