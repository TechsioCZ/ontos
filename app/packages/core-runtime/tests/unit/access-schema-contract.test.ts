import { fileURLToPath } from 'node:url';
import { NodeFileSystem } from '@effect/platform-node';
import { getTableConfig, PgDialect, PgRole } from 'drizzle-orm/pg-core';
import type { PgPolicy } from 'drizzle-orm/pg-core';
import { is, sql } from 'drizzle-orm';
import { Effect, FileSystem, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ACCESS_TABLES,
  ACCESS_TABLE_INVENTORY,
  CORE_SCHEMA_NAME,
  CORE_TABLE_INVENTORY,
  CORE_TABLES,
  accessAssignments,
  accessCatalogEntries,
  accessCatalogSnapshots,
  accessChangeItems,
  accessConsentSnapshots,
  accessDatabaseSchema,
  accessDecisionLogs,
  accessAgentConnections,
  accessDelegations,
  accessFrozenCommands,
  accessGrantIncarnations,
  accessMandates,
  accessMandateGrants,
  accessMemberships,
  accessOperationJournals,
  accessProposals,
  accessRoleRevisions,
  accessScopes,
  accessTeamMembers,
  accessTeams,
  accessWorkloadBindings,
  coreDatabaseSchema,
} from '../../src/db/schema.ts';

/*
 * SQL can only hold part of the access intent. This contract pins the half it holds: the scope and
 * holder XORs, the identity-bearing unique keys, the same-tenant foreign keys, per-tenant RLS, and
 * the immutability triggers the migration adds because no column check can carry them.
 */
const drizzleDirectory = fileURLToPath(new URL('../../drizzle/', import.meta.url));
const MIGRATION_SUFFIX = '_authorization-v2-access-intent';
const readMigration = Effect.gen(function* readMigrationEffect() {
  const fileSystem = yield* FileSystem.FileSystem;
  const folders = (yield* fileSystem.readDirectory(drizzleDirectory)).filter((folder) =>
    folder.endsWith(MIGRATION_SUFFIX),
  );
  const [name] = folders;
  if (name === undefined) {
    throw new Error('The access intent migration is missing');
  }
  const migration = yield* fileSystem.readFileString(`${drizzleDirectory}/${name}/migration.sql`);
  return { folders, migration };
});

const dialect = new PgDialect();
/** A release is global, so the two catalog tables never carry tenant row security. */
const CATALOG_TABLE_NAMES: ReadonlySet<string> = new Set(['access_catalog_snapshots', 'access_catalog_entries']);
const checks = (table: Parameters<typeof getTableConfig>[0]) =>
  new Map(
    getTableConfig(table).checks.map((constraint) => [constraint.name, dialect.sqlToQuery(constraint.value).sql]),
  );
const constraintNames = (table: Parameters<typeof getTableConfig>[0]) => ({
  foreignKeys: getTableConfig(table).foreignKeys.map((key) => key.getName() ?? ''),
  indexes: getTableConfig(table).indexes.map((index) => index.config.name ?? ''),
  uniqueConstraints: getTableConfig(table).uniqueConstraints.map((unique) => unique.name ?? ''),
});
const nullArms = (value: string) => (value.match(/is null/gu) ?? []).length;
/** One policy target as a role name; an omitted target means PUBLIC. */
const policyRoleName = (role: Exclude<PgPolicy['to'], undefined>): string => {
  if (Predicate.isString(role)) {
    return role;
  }
  if (is(role, PgRole)) {
    return role.name;
  }
  return '';
};
/** The roles a Drizzle policy targets, normalized. */
const policyRolesOf = (policy: PgPolicy): readonly string[] => {
  const { to } = policy;
  if (to === undefined) {
    return ['public'];
  }
  return (Array.isArray(to) ? to : [to]).flatMap((role) => [policyRoleName(role)]);
};
/**
 * The Core tables one access decision reads, and the one table it appends evidence to, as the gate's
 * ports touch them. `core.legal_entities` and `core.principals` already carry a Party request policy,
 * so only the access intent tables are named here.
 */
const GATEWAY_REQUEST_READ_TABLES: ReadonlySet<string> = new Set([
  'access_scopes',
  'access_memberships',
  'access_assignments',
  'access_role_revisions',
  'access_grant_incarnations',
  'access_delegations',
  'access_agent_connections',
  'access_consent_snapshots',
  'access_team_members',
  'access_teams',
  'access_workload_bindings',
  'access_frozen_commands',
]);
const GATEWAY_REQUEST_INSERT_TABLES: ReadonlySet<string> = new Set(['access_decision_logs']);

it('registers every access intent table once in the Core schema inventory', () => {
  const tables = Object.values(accessDatabaseSchema);
  expect(tables).toHaveLength(23);
  expect(ACCESS_TABLE_INVENTORY).toHaveLength(23);
  expect(new Set(ACCESS_TABLE_INVENTORY).size).toBe(23);
  expect(ACCESS_TABLES).toEqual(tables);
  for (const table of tables) {
    const config = getTableConfig(table);
    expect(config.schema).toBe(CORE_SCHEMA_NAME);
    expect(config.name.startsWith('access_')).toBe(true);
    expect(new Set<string>(ACCESS_TABLE_INVENTORY).has(config.name)).toBe(true);
    expect(new Set<string>(CORE_TABLE_INVENTORY).has(config.name)).toBe(true);
    expect(CORE_TABLES.includes(table)).toBe(true);
    expect(Object.values(coreDatabaseSchema).includes(table)).toBe(true);
  }
});

it('keeps the global release catalog outside tenant RLS and every intent table inside it', () => {
  for (const table of [accessCatalogSnapshots, accessCatalogEntries]) {
    const config = getTableConfig(table);
    expect(config.enableRLS).toBe(false);
    expect(config.policies).toHaveLength(0);
  }
  const tenantTables = Object.values(accessDatabaseSchema).filter(
    (table) => table !== accessCatalogSnapshots && table !== accessCatalogEntries,
  );
  expect(tenantTables).toHaveLength(21);
  for (const table of tenantTables) {
    const config = getTableConfig(table);
    expect(config.enableRLS).toBe(true);
    // The shared runtime keeps its four session-setting policies on every tenant table.
    const runtime = config.policies.filter((policy) => policyRolesOf(policy).includes('ontos_runtime'));
    expect(runtime.map((policy) => `${policy.name}:${policy.for}`)).toEqual(
      config.name === 'access_frozen_commands'
        ? [`${config.name}_select:select`, `${config.name}_insert:insert`]
        : [
            `${config.name}_select:select`,
            `${config.name}_insert:insert`,
            `${config.name}_update:update`,
            `${config.name}_delete:delete`,
          ],
    );
    // An explicit request identity reaches only the tables the gate touches, through the scope it
    // redeemed: one gateway-scoped policy per table, never a session-setting one (D6).
    const request = config.policies.filter((policy) => policyRolesOf(policy).includes('party_registry_runtime'));
    const expectedRequest: string[] = [];
    if (GATEWAY_REQUEST_READ_TABLES.has(config.name)) {
      expectedRequest.push(`${config.name}_gateway_request_select:select`);
    }
    if (GATEWAY_REQUEST_INSERT_TABLES.has(config.name)) {
      expectedRequest.push(`${config.name}_gateway_request_insert:insert`);
    }
    expect(request.map((policy) => `${policy.name}:${policy.for}`).toSorted()).toEqual(expectedRequest);
  }
  // Every policy targets exactly one runtime role: the shared runtime or the Party request identity.
  for (const table of tenantTables) {
    for (const policy of getTableConfig(table).policies) {
      const roles = policyRolesOf(policy);
      expect(roles.length).toBe(1);
      expect(['ontos_runtime', 'party_registry_runtime']).toContain(roles[0]);
    }
  }
});

it('pins the registered workload bindings to one live row per principal and key (O73)', () => {
  const workloadChecks = checks(accessWorkloadBindings);
  // The key grammar of the contract: a module namespace and one kebab name.
  expect(workloadChecks.get('access_workload_bindings_key_ck')).toContain('workload_key');
  expect(workloadChecks.get('access_workload_bindings_key_ck')).toContain('length');
  // A revoked binding names its revocation instant; an active one never does.
  expect(workloadChecks.get('access_workload_bindings_revoked_ck')).toContain('revoked_at');
  expect(workloadChecks.get('access_workload_bindings_status_ck')).toContain("'revoked'");
  const indexes = constraintNames(accessWorkloadBindings);
  expect(indexes.indexes).toEqual(
    expect.arrayContaining([
      'access_workload_bindings_active_uk',
      'access_workload_bindings_incarnation_uk',
      'access_workload_bindings_tenant_id_uk',
    ]),
  );
  // At most one live binding per principal and key, so a revoked one never blocks a re-bind.
  const activeIndex = getTableConfig(accessWorkloadBindings).indexes.find(
    (index) => index.config.name === 'access_workload_bindings_active_uk',
  );
  const activeWhere = activeIndex?.config.where;
  expect(activeWhere).toBeDefined();
  expect(dialect.sqlToQuery(activeWhere ?? sql`false`).sql).toBe(
    '"core"."access_workload_bindings"."status" = \'active\'',
  );
  // The binding's principal is a person or a workload of this same tenant, never another tenant's.
  expect(constraintNames(accessWorkloadBindings).foreignKeys).toEqual(
    expect.arrayContaining([
      'access_workload_bindings_principal_fk',
      'access_workload_bindings_tenant_id_tenants_tenant_id_fk',
    ]),
  );
});

it('binds each frozen command to the exact proposal and its digest, with no mutation policy (O75/O90)', () => {
  const frozen = getTableConfig(accessFrozenCommands);
  expect(frozen.primaryKeys.map((key) => key.getName())).toContain('access_frozen_commands_pk');
  expect(
    frozen.foreignKeys
      .find((key) => key.getName() === 'access_frozen_commands_proposal_fk')
      ?.reference()
      .columns.map((column) => column.name),
  ).toEqual(['tenant_id', 'proposal_id', 'scope_id', 'capability_key', 'command_digest']);
  expect(checks(accessFrozenCommands).get('access_frozen_commands_digest_ck')).toContain('command_digest');
  expect(checks(accessFrozenCommands).get('access_frozen_commands_command_ck')).toContain('jsonb_typeof');
  expect(constraintNames(accessProposals).indexes).toContain('access_proposals_invocation_uk');
  expect(getTableConfig(accessProposals).columns.map((column) => column.name)).toContain('action_invocation_id');
});

it('holds exactly one scope and one holder in SQL', () => {
  const scopeChecks = checks(accessScopes);
  expect(scopeChecks.get('access_scopes_xor_ck')).toContain('is null');
  expect(scopeChecks.get('access_scopes_xor_ck')).toContain('<>');
  expect(scopeChecks.get('access_scopes_tenant_context_ck')).toContain('"tenant_context_id" is null or');
  expect(nullArms(scopeChecks.get('access_scopes_xor_ck') ?? '')).toBe(2);
  const assignmentChecks = checks(accessAssignments);
  expect(assignmentChecks.get('access_assignments_holder_xor_ck')).toContain('<>');
  expect(nullArms(assignmentChecks.get('access_assignments_holder_xor_ck') ?? '')).toBe(2);
  // Membership and team membership carry the same holder XOR: a person and an agent never share a row.
  for (const table of [accessMemberships, accessTeamMembers]) {
    const config = getTableConfig(table);
    const holderCheck = checks(table).get(`${config.name}_holder_xor_ck`);
    expect(holderCheck).toContain('<>');
    expect(nullArms(holderCheck ?? '')).toBe(2);
  }
  // An invalid control: the XOR is not a tautology over one column pair.
  expect(assignmentChecks.get('access_assignments_holder_xor_ck')).not.toBe(scopeChecks.get('access_scopes_xor_ck'));
});

it('keeps incarnations, envelopes and approvals in named unique keys and checks', () => {
  const revisions = constraintNames(accessRoleRevisions);
  expect(revisions.indexes).toContain('access_role_revisions_number_uk');
  expect(checks(accessRoleRevisions).get('access_role_revisions_provenance_ck')).toContain(
    "('template', 'customer_changed', 'manual', 'imported')",
  );
  // O47: only the template-derived provenances name a template.
  expect(checks(accessRoleRevisions).get('access_role_revisions_template_ck')).toContain(
    "('template', 'customer_changed')",
  );
  const mandates = constraintNames(accessMandates);
  expect(mandates.indexes).toContain('access_mandates_proposal_uk');
  expect(mandates.indexes).toContain('access_mandates_scope_uk');
  const proposalColumns = getTableConfig(accessProposals).columns.map((column) => column.name);
  const mandateColumns = getTableConfig(accessMandates).columns.map((column) => column.name);
  // M5/O52: exactly one table owns the lifecycle status, the proposal row, and exactly one table owns
  // the approval, the approval record: no approval fact exists on both sides and no witness set is
  // stored twice, so there is nothing that could ever diverge.
  expect(mandateColumns).not.toContain('status');
  expect(mandateColumns).not.toContain('authority_json');
  expect(mandateColumns).toEqual(
    expect.arrayContaining([
      'approved_at',
      'approval_expires_at',
      'approver_assignment_incarnation_id',
      'approver_id',
      'execution_assignment_incarnation_id',
    ]),
  );
  expect(proposalColumns).toEqual(expect.arrayContaining(['ended_at', 'executed_at', 'status']));
  for (const approvalColumn of [
    'approval_expires_at',
    'approved_at',
    'approver_assignment_incarnation_id',
    'approver_id',
    'execution_assignment_incarnation_id',
  ]) {
    expect(proposalColumns).not.toContain(approvalColumn);
  }
  const proposalChecks = checks(accessProposals);
  expect(proposalChecks.get('access_proposals_execution_ck')).toContain('execution_operation_id');
  // The approval record points at the one frozen command of one proposal, so it can never claim
  // another scope, capability or digest than the proposal it approves (R3b-N3c).
  expect(constraintNames(accessProposals).indexes).toContain('access_proposals_command_uk');
  const proposalKey = getTableConfig(accessMandates).foreignKeys.find(
    (key) => key.getName() === 'access_mandates_proposal_fk',
  );
  expect(proposalKey?.reference().columns.map((column) => column.name)).toEqual([
    'tenant_id',
    'proposal_id',
    'scope_id',
    'capability_key',
    'command_digest',
  ]);
  expect(checks(accessMandates).get('access_mandates_ttl_ck')).toContain('approval_expires_at');
  // R3b-N3a: a witness row carries the grant's real mode, so a propose-mode grant can never stand in
  // for an approval witness.
  const witnessKey = getTableConfig(accessMandateGrants).foreignKeys.find(
    (key) => key.getName() === 'access_mandate_grants_grant_fk',
  );
  expect(witnessKey?.reference().columns.map((column) => column.name)).toContain('mode');
  expect(constraintNames(accessProposals).indexes).toContain('access_proposals_execution_uk');
  // O52: the grant identity omits the role revision and names the exact cell.
  const grantColumns = getTableConfig(accessGrantIncarnations).columns.map((column) => column.name);
  expect(grantColumns).toEqual(expect.arrayContaining(['capability_key', 'mode', 'role_id', 'slot']));
  expect(grantColumns).not.toContain('role_revision_id');
  expect(checks(accessGrantIncarnations).get('access_grants_cell_identity_ck')).toContain('capability_key');
  // R2-H1: a witness carries the mode its purpose requires and the grant's real capability.
  const witnessColumns = getTableConfig(accessMandateGrants).columns.map((column) => column.name);
  expect(witnessColumns).toEqual(expect.arrayContaining(['mode', 'scope_id']));
  expect(checks(accessMandateGrants).get('access_mandate_grants_mode_ck')).toContain("'approve'");
  const delegationChecks = checks(accessDelegations);
  expect(delegationChecks.get('access_delegations_self_ck')).toContain('manager_id');
  expect(delegationChecks.get('access_delegations_redelegate_ck')).toBe(
    'not "core"."access_delegations"."can_redelegate"',
  );
  expect(delegationChecks.get('access_delegations_envelope_ck')).toContain('cardinality');
  expect(checks(accessProposals).get('access_proposals_requester_ck')).toContain('principalId');
  expect(checks(accessDecisionLogs).get('access_decision_logs_actor_ck')).toContain('principalId');
  expect(checks(accessChangeItems).get('access_change_items_status_ck')).toContain("'undone'");
  expect(checks(accessAgentConnections).get('access_connections_status_ck')).toContain("'expired'");
  expect(checks(accessAgentConnections).get('access_connections_period_ck')).toContain('<');
  expect(checks(accessConsentSnapshots).get('access_consent_snapshots_revision_ck')).toContain('> 0');
  expect(checks(accessProposals).get('access_proposals_end_ck')).toContain('rejected_by');
  const journalChecks = checks(accessOperationJournals);
  expect(journalChecks.get('access_operation_journals_phase_ck')).toContain("'committed'");
  expect(journalChecks.get('access_operation_journals_time_ck')).toContain('<=');
  expect(journalChecks.get('access_operation_journals_projection_ck')).toContain('projection_token');
  expect(checks(accessDecisionLogs).get('access_decision_logs_correlation_ck')).toContain('correlation_id');
  expect(checks(accessChangeItems).get('access_change_items_lineage_ck')).toContain('lineage_from');
});

it('keeps every reference tenant-qualified inside one tenant', () => {
  for (const table of [
    accessAssignments,
    accessDelegations,
    accessMandates,
    accessMandateGrants,
    accessMemberships,
    accessProposals,
    accessConsentSnapshots,
    accessDecisionLogs,
    accessScopes,
    accessTeamMembers,
    accessTeams,
    accessWorkloadBindings,
  ]) {
    const { foreignKeys } = constraintNames(table);
    expect(foreignKeys.some((name) => name.endsWith('_tenant_id_tenants_tenant_id_fk'))).toBe(true);
  }
  for (const table of [
    accessAssignments,
    accessMandates,
    accessMandateGrants,
    accessConsentSnapshots,
    accessMemberships,
    accessTeamMembers,
    accessWorkloadBindings,
  ]) {
    for (const key of getTableConfig(table).foreignKeys) {
      const reference = key.reference();
      const scoped = reference.columns.length === reference.foreignColumns.length;
      expect([key.getName(), scoped]).toEqual([key.getName(), true]);
      if (reference.foreignTable !== undefined) {
        expect(reference.columns.map((column) => column.name)).toContain('tenant_id');
      }
    }
  }
});

it('pins membership and team intent to one scope, one holder and one live row', () => {
  const membershipChecks = checks(accessMemberships);
  expect(membershipChecks.get('access_memberships_kind_ck')).toContain("'access_admin'");
  expect(membershipChecks.get('access_memberships_status_ck')).toContain("'suspended'");
  // O46: owner and access_admin are a verified human's relations, never an agent's.
  expect(membershipChecks.get('access_memberships_manager_ck')).toContain("'member'");
  expect(membershipChecks.get('access_memberships_period_ck')).toContain('<');
  const membershipIndexes = constraintNames(accessMemberships).indexes;
  expect(membershipIndexes).toEqual(
    expect.arrayContaining(['access_memberships_subject_uk', 'access_memberships_agent_uk']),
  );
  const teamChecks = checks(accessTeams);
  expect(teamChecks.get('access_teams_name_ck')).toContain('200');
  expect(constraintNames(accessTeams).indexes).toContain('access_teams_name_uk');
  // A team belongs to exactly one scope, and a team membership reaches its team inside that tenant.
  const teamKey = getTableConfig(accessTeamMembers).foreignKeys.find(
    (key) => key.getName() === 'access_team_members_team_fk',
  );
  expect(teamKey?.reference().columns.map((column) => column.name)).toEqual(['tenant_id', 'team_id']);
  expect(teamKey?.reference().foreignColumns.map((column) => column.name)).toEqual(['tenant_id', 'team_id']);
  const scopeKey = getTableConfig(accessMemberships).foreignKeys.find(
    (key) => key.getName() === 'access_memberships_scope_fk',
  );
  expect(scopeKey?.reference().foreignColumns.map((column) => column.name)).toEqual(['tenant_id', 'scope_id']);
  // A team membership is current intent: it is removed, so no status column narrows it.
  expect(checks(accessTeamMembers).has('access_team_members_status_ck')).toBe(false);
});

it.layer(NodeFileSystem.layer)('the access intent migration', (suite) => {
  suite.effect(
    'pins the catalog release time and retirement vocabulary the model declares',
    Effect.fnUntraced(function* pinnedRelease() {
      const { migration } = yield* readMigration;
      const snapshotColumns = new Map(
        getTableConfig(accessCatalogSnapshots).columns.map((column) => [column.name, column]),
      );
      expect(snapshotColumns.get('published_at')?.notNull).toBe(true);
      expect(checks(accessGrantIncarnations).get('access_grants_status_ck')).toContain("'retired'");
      expect(migration).toContain('"published_at" timestamp with time zone NOT NULL');
    }),
  );

  suite.effect(
    'only adds access objects and carries the immutability triggers',
    Effect.fnUntraced(function* onlyAdds() {
      const { folders, migration } = yield* readMigration;
      expect(folders).toHaveLength(1);
      for (const table of ACCESS_TABLE_INVENTORY) {
        expect(migration).toContain(`CREATE TABLE "core"."${table}"`);
      }
      const altered = [...migration.matchAll(/ALTER TABLE "core"\."(?<table>[a-z_]+)"/gu)].map(
        (match) => match.groups?.['table'] ?? '',
      );
      expect(altered.every((table) => table.startsWith('access_'))).toBe(true);
      expect(migration).not.toContain('DROP TABLE');
      expect(migration).not.toContain('DROP COLUMN');
      expect(
        [...migration.matchAll(/CREATE (?:CONSTRAINT )?TRIGGER (?<trigger>[a-z_]+)/gu)]
          .map((match) => match.groups?.['trigger'] ?? '')
          .toSorted((left, right) => left.localeCompare(right)),
      ).toEqual([
        'core_access_assignments_incarnation',
        'core_access_assignments_no_delete',
        'core_access_assignments_no_truncate',
        'core_access_assignments_scope',
        'core_access_assignments_subject_kind',
        'core_access_catalog_entries_append_only',
        'core_access_catalog_entries_no_truncate',
        'core_access_catalog_snapshots_append_only',
        'core_access_catalog_snapshots_no_truncate',
        'core_access_change_decisions_append_only',
        'core_access_change_decisions_no_truncate',
        'core_access_change_decisions_subject_kind',
        'core_access_change_items_no_delete',
        'core_access_change_items_no_truncate',
        'core_access_change_items_status',
        'core_access_connections_envelope',
        'core_access_connections_no_delete',
        'core_access_connections_no_truncate',
        'core_access_connections_subject_kind',
        'core_access_consent_snapshots_append_only',
        'core_access_consent_snapshots_no_truncate',
        'core_access_consent_snapshots_subject_kind',
        'core_access_decision_logs_append_only',
        'core_access_decision_logs_no_truncate',
        'core_access_decision_logs_subject_kind',
        'core_access_delegations_envelope',
        'core_access_delegations_no_delete',
        'core_access_delegations_no_truncate',
        'core_access_delegations_subject_kind',
        'core_access_frozen_commands_append_only',
        'core_access_frozen_commands_no_truncate',
        'core_access_grant_incarnations_cell',
        'core_access_grant_incarnations_no_delete',
        'core_access_grant_incarnations_no_truncate',
        'core_access_mandate_grants_append_only',
        'core_access_mandate_grants_no_truncate',
        'core_access_mandate_grants_witness',
        'core_access_mandates_append_only',
        'core_access_mandates_authority',
        'core_access_mandates_no_truncate',
        'core_access_mandates_proposal',
        'core_access_mandates_subject_kind',
        'core_access_memberships_identity',
        'core_access_memberships_no_delete',
        'core_access_memberships_no_truncate',
        'core_access_memberships_scope',
        'core_access_memberships_subject_kind',
        'core_access_operation_journals_no_delete',
        'core_access_operation_journals_no_truncate',
        'core_access_operation_journals_phase',
        'core_access_proposals_approval',
        'core_access_proposals_no_delete',
        'core_access_proposals_no_truncate',
        'core_access_proposals_status',
        'core_access_proposals_subject_kind',
        'core_access_role_revisions_immutable',
        'core_access_role_revisions_no_truncate',
        'core_access_role_revisions_subject_kind',
        'core_access_roles_identity',
        'core_access_roles_subject_kind',
        'core_access_scope_fences_no_delete',
        'core_access_scope_fences_no_truncate',
        'core_access_scopes_append_only',
        'core_access_scopes_no_truncate',
        'core_access_team_members_no_truncate',
        'core_access_team_members_subject_kind',
        'core_access_teams_identity',
        'core_access_teams_no_delete',
        'core_access_teams_no_truncate',
      ]);
      // Invalid control: the append-only guard is not attached to a table that must stay editable.
      expect(migration).not.toContain('CREATE TRIGGER core_access_roles_append_only');
      // R3b-N4: a role is immutable except its name, and a scope is append-only, so a live assignment
      // can never escape its role's legal entity through a later role or scope update.
      expect(migration).toContain('CREATE TRIGGER core_access_roles_identity');
      expect(migration).toContain('BEFORE UPDATE ON core.access_roles');
      expect(migration).toContain('core.keep_access_role_identity()');
      expect(migration).toContain('CREATE TRIGGER core_access_scopes_append_only');
      expect(migration).toContain('BEFORE UPDATE OR DELETE ON core.access_scopes');
      for (const guard of [
        'core_access_connections',
        'core_access_change_items',
        'core_access_operation_journals',
        'core_access_scope_fences',
      ]) {
        expect(migration).toContain(`CREATE TRIGGER ${guard}_no_delete`);
        expect(migration).toContain(`CREATE TRIGGER ${guard}_no_truncate`);
      }
      // A live membership is unique per scope, holder and kind, so suspension is one row's status and
      // a revoked membership never blocks the rejoin that writes a new one (D27).
      expect(migration).toContain(
        'CREATE UNIQUE INDEX "access_memberships_subject_uk" ON "core"."access_memberships" ("tenant_id","scope_id","principal_id","kind") WHERE "status" <> \'revoked\' and "principal_id" is not null',
      );
      for (const guard of [
        'core.keep_access_membership()',
        'core.check_access_membership_scope()',
        'core.keep_access_team_identity()',
      ]) {
        expect(migration).toContain(guard);
      }
      // R3b-N3a: the grant the witness points at is identified by capability, scope *and* mode.
      expect(migration).toContain(
        'CREATE UNIQUE INDEX "access_grants_scope_uk" ON "core"."access_grant_incarnations" ("tenant_id","grant_incarnation_id","scope_id","capability_key","mode")',
      );
      expect(migration).toContain(
        'CONSTRAINT "access_mandate_grants_grant_fk" FOREIGN KEY ("tenant_id","grant_incarnation_id","scope_id","capability_key","mode")',
      );
      // M5: the proposal and its one approval record are required of each other at commit time.
      expect(migration).toContain('CREATE CONSTRAINT TRIGGER core_access_proposals_approval');
      expect(migration).toContain('CREATE CONSTRAINT TRIGGER core_access_mandates_proposal');
      expect(migration.match(/DEFERRABLE INITIALLY DEFERRED/gu)).toHaveLength(2);
      expect(migration).toContain('CREATE UNIQUE INDEX "access_proposals_command_uk" ON "core"."access_proposals"');
      expect(migration).toContain('CREATE UNIQUE INDEX "access_proposals_invocation_uk" ON "core"."access_proposals"');
      expect(migration).toContain('GRANT SELECT, INSERT ON core.access_frozen_commands TO ontos_runtime');
      expect(migration).toContain('REVOKE UPDATE, DELETE ON core.access_frozen_commands FROM ontos_runtime');
      expect(migration).toContain('BEFORE UPDATE OR DELETE ON core.access_frozen_commands');
      expect(migration).toContain('core.reject_access_append_only_change()');
    }),
  );

  suite.effect(
    'forces row security on every tenant access table and leaves the release catalog unprotected',
    Effect.fnUntraced(function* forcesTenantRowSecurity() {
      const { migration } = yield* readMigration;
      const forced = [...migration.matchAll(/ALTER TABLE "core"\."(?<table>[a-z_]+)" FORCE ROW LEVEL SECURITY;/gu)].map(
        (match) => match.groups?.['table'] ?? '',
      );
      const tenantTables = ACCESS_TABLE_INVENTORY.filter((table) => !CATALOG_TABLE_NAMES.has(table));
      expect(tenantTables).toHaveLength(21);
      expect(forced.toSorted((left, right) => left.localeCompare(right))).toEqual(
        [...tenantTables].toSorted((left, right) => left.localeCompare(right)),
      );
      expect(migration.match(/ENABLE ROW LEVEL SECURITY/gu)).toHaveLength(21);
      // Invalid control: row security on the global catalog would hide the whole release from every
      // runtime, because a table with row security and no policy grants nothing.
      expect(migration).not.toMatch(
        /ALTER TABLE "core"\."access_catalog_[a-z_]+" (?:ENABLE|FORCE) ROW LEVEL SECURITY;/u,
      );
    }),
  );

  suite.effect(
    'binds every tenant policy to the transaction tenant and the runtime role',
    Effect.fnUntraced(function* pinsTenantPolicies() {
      const { migration } = yield* readMigration;
      const statements = migration
        .split('--> statement-breakpoint')
        .filter((statement) => statement.includes('CREATE POLICY'));
      expect(statements).toHaveLength(95);
      const policies = statements.map((statement) => ({
        command: /FOR (?<command>SELECT|INSERT|UPDATE|DELETE)/u.exec(statement)?.groups?.['command'] ?? '',
        name: /CREATE POLICY "(?<name>[a-z_]+)"/u.exec(statement)?.groups?.['name'] ?? '',
        statement,
        table: /ON "core"\."(?<table>[a-z_]+)"/u.exec(statement)?.groups?.['table'] ?? '',
      }));
      const tenantTables = ACCESS_TABLE_INVENTORY.filter((table) => !CATALOG_TABLE_NAMES.has(table));
      const requestPolicies = policies.filter((policy) => policy.statement.includes('TO "party_registry_runtime"'));
      const runtimePolicies = policies.filter((policy) => !requestPolicies.includes(policy));
      expect(runtimePolicies).toHaveLength(82);
      expect(requestPolicies).toHaveLength(13);
      for (const table of tenantTables) {
        const own = runtimePolicies
          .filter((policy) => policy.table === table)
          .map((policy) => `${policy.name}:${policy.command}`)
          .toSorted((left, right) => left.localeCompare(right));
        expect(own).toEqual(
          table === 'access_frozen_commands'
            ? [`${table}_insert:INSERT`, `${table}_select:SELECT`]
            : [`${table}_delete:DELETE`, `${table}_insert:INSERT`, `${table}_select:SELECT`, `${table}_update:UPDATE`],
        );
      }
      // The shared runtime installs the session setting, never a gateway seal, so its policies must
      // keep reading `ontos.tenant_id`; the request identity reaches the same rows only through the
      // scope it redeemed, so its policies must read the trusted accessor and never a session setting.
      for (const policy of runtimePolicies) {
        expect(policy.statement).toContain('TO "ontos_runtime"');
        expect(policy.statement).toContain(
          `"core"."${policy.table}"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid`,
        );
        expect(policy.statement).not.toContain('trust.current_tenant_id()');
      }
      expect(
        requestPolicies
          .map((policy) => `${policy.table}:${policy.command}`)
          .toSorted((left, right) => left.localeCompare(right)),
      ).toEqual(
        [
          ...[...GATEWAY_REQUEST_READ_TABLES].map((table) => `${table}:SELECT`),
          ...[...GATEWAY_REQUEST_INSERT_TABLES].map((table) => `${table}:INSERT`),
        ].toSorted((left, right) => left.localeCompare(right)),
      );
      for (const policy of requestPolicies) {
        expect(policy.statement).toContain('TO "party_registry_runtime"');
        expect(policy.statement).toContain(`"core"."${policy.table}"."tenant_id" = (select trust.current_tenant_id())`);
        expect(policy.statement).not.toContain('current_setting');
      }
      const update = policies.find((policy) => policy.table === 'access_scopes' && policy.command === 'UPDATE');
      expect(update?.statement).toContain('USING (');
      expect(update?.statement).toContain('WITH CHECK (');
      expect(policies.filter((policy) => policy.table.startsWith('access_catalog'))).toHaveLength(0);
    }),
  );
});
