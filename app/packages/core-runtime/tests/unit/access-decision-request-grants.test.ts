import { expect, it } from 'effect-rstest';

import { ACCESS_DECISION_REQUEST_GRANTS } from '../../src/db/database-identity-manifest.ts';

/*
 * The gate reads its intent and appends its evidence inside the request's own database identity, so
 * that identity must be granted exactly the Core tables and columns the request path touches. This
 * test pins that list against the code that issues every statement, so a new read or write cannot
 * silently reach a table the request identity was never granted (it would answer 503, never an
 * allow). The list is derived from:
 *
 *   access/enforcement/actor.ts            `core.principals` (kind, principal_id, tenant_id)
 *   access/enforcement/legal-entities.ts   `core.legal_entities` (legal_entity_id, tenant_id)
 *   access/enforcement/decision-log.ts     `core.access_decision_logs` (insert)
 *   access/workloads/bindings.ts           `core.access_workload_bindings` (the actor's active keys)
 *   access/intent/tenant-intent-loader.ts  the ten `core.access_*` read tables below, each with the
 *                                          columns its scope, membership, cell, connection and team
 *                                          queries name (`loadScope`, `loadAuthorityCells`,
 *                                          `loadConnection`, `loadTeamIds`)
 *
 * The projection writer's catalog reads (`access_catalog_*`) and the approval store's proposal,
 * mandate and journal writes are worker and admin paths, never the request path, so the constant
 * must not name them.
 */
interface ExpectedGrant {
  readonly columns: readonly string[];
  readonly privilege: 'insert' | 'select';
  readonly table: string;
}

const EXPECTED: readonly ExpectedGrant[] = [
  { columns: ['kind', 'principal_id', 'tenant_id'], privilege: 'select', table: 'core.principals' },
  { columns: ['legal_entity_id', 'tenant_id'], privilege: 'select', table: 'core.legal_entities' },
  {
    columns: ['legal_entity_id', 'scope_id', 'tenant_context_id', 'tenant_id'],
    privilege: 'select',
    table: 'core.access_scopes',
  },
  {
    columns: [
      'agent_id',
      'created_at',
      'kind',
      'membership_id',
      'principal_id',
      'recorded_by',
      'scope_id',
      'status',
      'tenant_id',
      'valid_from',
      'valid_until',
    ],
    privilege: 'select',
    table: 'core.access_memberships',
  },
  {
    columns: [
      'agent_id',
      'assigned_by',
      'delegated_by',
      'delegation_envelope_json',
      'incarnation_id',
      'principal_id',
      'role_id',
      'role_revision_id',
      'scope_id',
      'status',
      'tenant_id',
      'valid_from',
      'valid_until',
    ],
    privilege: 'select',
    table: 'core.access_assignments',
  },
  {
    columns: [
      'catalog_snapshot_id',
      'cells_json',
      'created_at',
      'created_by',
      'provenance',
      'revision',
      'role_id',
      'role_revision_id',
      'template_key',
      'tenant_id',
    ],
    privilege: 'select',
    table: 'core.access_role_revisions',
  },
  {
    columns: ['capability_key', 'grant_incarnation_id', 'mode', 'role_id', 'scope_id', 'slot', 'status', 'tenant_id'],
    privilege: 'select',
    table: 'core.access_grant_incarnations',
  },
  {
    columns: [
      'amount_ceiling_json',
      'capability_keys',
      'delegation_id',
      'granted_by',
      'manager_id',
      'people',
      'role_ids',
      'scope_id',
      'status',
      'tenant_id',
      'until',
      'valid_from',
    ],
    privilege: 'select',
    table: 'core.access_delegations',
  },
  {
    columns: [
      'agent_id',
      'connection_id',
      'principal_id',
      'revision',
      'scope_id',
      'status',
      'tenant_id',
      'valid_from',
      'valid_until',
    ],
    privilege: 'select',
    table: 'core.access_agent_connections',
  },
  {
    columns: ['ceiling_json', 'connection_id', 'revision', 'tenant_id'],
    privilege: 'select',
    table: 'core.access_consent_snapshots',
  },
  {
    columns: ['agent_id', 'principal_id', 'team_id', 'tenant_id'],
    privilege: 'select',
    table: 'core.access_team_members',
  },
  { columns: ['scope_id', 'team_id', 'tenant_id'], privilege: 'select', table: 'core.access_teams' },
  {
    columns: [
      'action_key',
      'capability_key',
      'command_digest',
      'command_json',
      'created_at',
      'proposal_id',
      'scope_id',
      'tenant_id',
    ],
    privilege: 'select',
    table: 'core.access_frozen_commands',
  },
  {
    columns: ['binding_id', 'incarnation', 'principal_id', 'status', 'tenant_id', 'workload_key'],
    privilege: 'select',
    table: 'core.access_workload_bindings',
  },
  {
    columns: [
      'actor_json',
      'actor_principal_id',
      'admission_deadline',
      'capability_key',
      'correlation_id',
      'decided_at',
      'decision_log_id',
      'delegate_app_id',
      'delegate_principal_id',
      'mode',
      'on_behalf_of_principal_id',
      'operation_id',
      'outcome',
      'reasons_json',
      'scope_id',
      'target',
      'tenant_id',
    ],
    privilege: 'insert',
    table: 'core.access_decision_logs',
  },
];

/** One grant's privilege/column pairs, in the shape the pinned list spells them. */
const grantColumnsOf = (grant: (typeof ACCESS_DECISION_REQUEST_GRANTS)[number]): readonly string[] => {
  const privileges = grant.privileges.filter(
    (privilege): privilege is 'insert' | 'select' => privilege === 'insert' || privilege === 'select',
  );
  return privileges.flatMap((privilege) => [...(grant.columns?.[privilege] ?? [])].toSorted());
};

it('grants exactly the Core tables and columns the gate request path touches', () => {
  const actual = ACCESS_DECISION_REQUEST_GRANTS.map((grant) => ({
    columns: grantColumnsOf(grant),
    privileges: [...grant.privileges].toSorted(),
    table: grant.table,
  })).toSorted((left, right) => left.table.localeCompare(right.table));
  const expected = EXPECTED.map((grant) => ({
    columns: [...grant.columns].toSorted(),
    privileges: [grant.privilege],
    table: grant.table,
  })).toSorted((left, right) => left.table.localeCompare(right.table));
  expect(actual).toEqual(expected);
});

it('keeps every grant explained, qualified, unique and least-privilege', () => {
  const tables = ACCESS_DECISION_REQUEST_GRANTS.map((grant) => grant.table);
  expect(new Set(tables).size).toBe(tables.length);
  for (const grant of ACCESS_DECISION_REQUEST_GRANTS) {
    expect(grant.table.startsWith('core.')).toBe(true);
    expect(grant.reason.trim().length).toBeGreaterThan(0);
    expect(grant.privileges.length).toBeGreaterThan(0);
    // A column list narrows exactly the privileges it names and never DELETE (which is table-wide).
    for (const privilege of Object.keys(grant.columns ?? {})) {
      expect(grant.privileges).toContain(privilege);
      expect(privilege).not.toBe('delete');
    }
  }
});

it('never names the projection writer or approval store tables the request path does not touch', () => {
  const tables = new Set(ACCESS_DECISION_REQUEST_GRANTS.map((grant) => grant.table));
  for (const table of [
    'core.access_catalog_snapshots',
    'core.access_catalog_entries',
    'core.access_roles',
    'core.access_change_items',
    'core.access_change_decisions',
    'core.access_proposals',
    'core.access_mandates',
    'core.access_mandate_grants',
    'core.access_operation_journals',
    'core.access_scope_fences',
  ]) {
    expect([table, tables.has(table)]).toEqual([table, false]);
  }
});
