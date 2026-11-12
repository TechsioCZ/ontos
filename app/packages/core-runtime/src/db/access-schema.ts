import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { CapabilitySlot } from '../access/compiler/object-id.ts';
import type { MembershipKind, MembershipStatus } from '../access/intent/memberships.ts';
import type { WorkloadBindingStatus } from '../access/workloads/store.ts';
import type { ActionAuthorityProofV2 } from '../access/approvals/action-authority-v2-schema.ts';
import type {
  AccessChangeDecisionKind,
  AccessChangeItemStatus,
  AccessChangeKind,
  AccessMode,
  AccessRisk,
  ActorContext,
  AuthorityWitness,
  CatalogSnapshotEntry,
  Cell,
  ConsentCeiling,
  DecisionOutcome,
  DecisionReason,
  LifecycleStatus,
  OperationPhase,
  ProposalStatus,
  RoleProvenance,
  ScopeFenceState,
} from '../access/model.ts';
import type { legalEntities, principals, tenants } from './schema.ts';
import { tenantRlsPolicies } from './scoped-transaction.ts';

/** Core identity tables the access intent tables reference; passed in to keep both schema modules acyclic. */
export interface AccessIdentityTables {
  readonly legalEntities: typeof legalEntities;
  readonly principals: typeof principals;
  /**
   * Explicit request identities that read the gate's intent and append its evidence row. They reach
   * these tables only through the trusted scope they redeemed (gateway grant, D6), so each gets one
   * gateway-scoped policy per operation it may use, never a session-setting one: a request role must
   * not be able to choose its own tenant. The shared runtime keeps its own session-setting policies.
   */
  readonly requestRoles?: readonly string[];
  readonly tenants: typeof tenants;
}

const core = pgSchema('core');
const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const scopeId = () => uuid('scope_id').notNull();
const sameTenant = (
  name: string,
  tenant: AnyPgColumn,
  id: AnyPgColumn,
  targetTenant: AnyPgColumn,
  target: AnyPgColumn,
) => foreignKey({ columns: [tenant, id], foreignColumns: [targetTenant, target], name }).onDelete('restrict');
const digest = (name: string, column: AnyPgColumn) => check(name, sql`${column} ~ '^[a-f0-9]{64}$'`);

/** A redeemed trusted scope is the only tenant a request identity may reach (D6). */
const gatewayTenantPredicate = (tenantColumn: AnyPgColumn) => sql`${tenantColumn} = (select trust.current_tenant_id())`;

/**
 * Materialized by `db/schema.ts` against its own Core identity tables. Defining the tables in a factory
 * instead of importing `./schema.ts` keeps the two schema modules acyclic in one direction only.
 */
export const defineAccessTables = ({ legalEntities, principals, requestRoles, tenants }: AccessIdentityTables) => {
  const gatewayRequestRoles = [...new Set(requestRoles)].filter((role) => role.length > 0).toSorted();
  /** One read policy per request table, so the gate reads its intent in the request's own tenant. */
  const gatewayRequestReadPolicies = (prefix: string, tenantColumn: AnyPgColumn) =>
    gatewayRequestRoles.length === 0
      ? []
      : [
          pgPolicy(`${prefix}_gateway_request_select`, {
            for: 'select',
            to: [...gatewayRequestRoles],
            using: gatewayTenantPredicate(tenantColumn),
          }),
        ];
  /** The evidence row the gate appends is the one request-path write, and it stays tenant-scoped. */
  const gatewayRequestInsertPolicies = (prefix: string, tenantColumn: AnyPgColumn) =>
    gatewayRequestRoles.length === 0
      ? []
      : [
          pgPolicy(`${prefix}_gateway_request_insert`, {
            for: 'insert',
            to: [...gatewayRequestRoles],
            withCheck: gatewayTenantPredicate(tenantColumn),
          }),
        ];
  const tenantId = () =>
    uuid('tenant_id')
      .notNull()
      .references(() => tenants.tenantId, { onDelete: 'restrict' });
  const personFk = (name: string, tenant: AnyPgColumn, person: AnyPgColumn) =>
    sameTenant(name, tenant, person, principals.tenantId, principals.principalId);

  /** Global immutable release catalog; only the Core publication path writes it. */
  const accessCatalogSnapshots = core.table(
    'access_catalog_snapshots',
    {
      catalogSnapshotId: uuid('catalog_snapshot_id').primaryKey(),
      createdAt: createdAt(),
      digest: text('digest').notNull(),
      publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    },
    (t) => [
      uniqueIndex('access_catalog_snapshot_digest_uk').on(t.digest),
      digest('access_catalog_snapshot_digest_ck', t.digest),
    ],
  );
  const accessCatalogEntries = core.table(
    'access_catalog_entries',
    {
      capabilityKey: text('capability_key').notNull(),
      catalogSnapshotId: uuid('catalog_snapshot_id')
        .notNull()
        .references(() => accessCatalogSnapshots.catalogSnapshotId, { onDelete: 'restrict' }),
      entryJson: jsonb('entry_json').$type<CatalogSnapshotEntry>().notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.catalogSnapshotId, t.capabilityKey], name: 'access_catalog_entries_pk' }),
      check(
        'access_catalog_entry_key_ck',
        sql`${t.capabilityKey} ~ '^[a-z][a-z0-9]*([-_][a-z0-9]+)*(\\.[a-z][a-z0-9]*([-_][a-z0-9]+)*){2,}$' and length(${t.capabilityKey}) <= 200`,
      ),
      check(
        'access_catalog_entry_json_ck',
        sql`jsonb_typeof(${t.entryJson}) = 'object' and ${t.entryJson}->>'key' is not distinct from ${t.capabilityKey}`,
      ),
    ],
  );

  /**
   * Canonical XOR scope identity. NULL legal entity never means every legal entity. Every tenant
   * table below carries the same four `ontos_runtime` policies, bound to the transaction's
   * `ontos.tenant_id`, and the migration forces row security on all 19 of them, which Drizzle cannot
   * emit and so states in SQL beside the policies. The two release-catalog tables above stay without
   * row security: a release is global, never one tenant's data (O50).
   */
  const accessScopes = core.table.withRLS(
    'access_scopes',
    {
      legalEntityId: uuid('legal_entity_id'),
      scopeId: uuid('scope_id').primaryKey(),
      tenantContextId: uuid('tenant_context_id'),
      tenantId: tenantId(),
    },
    (t) => [
      uniqueIndex('access_scopes_tenant_id_uk').on(t.tenantId, t.scopeId),
      uniqueIndex('access_scopes_tenant_context_uk').on(t.tenantContextId),
      uniqueIndex('access_scopes_legal_entity_uk').on(t.tenantId, t.legalEntityId),
      check('access_scopes_xor_ck', sql`(${t.tenantContextId} is null) <> (${t.legalEntityId} is null)`),
      check(
        'access_scopes_tenant_context_ck',
        sql`${t.tenantContextId} is null or ${t.tenantContextId} = ${t.tenantId}`,
      ),
      sameTenant(
        'access_scopes_legal_entity_fk',
        t.tenantId,
        t.legalEntityId,
        legalEntities.tenantId,
        legalEntities.legalEntityId,
      ),
      ...tenantRlsPolicies('access_scopes', t.tenantId),
      ...gatewayRequestReadPolicies('access_scopes', t.tenantId),
    ],
  );
  const scoped = (name: string, tenant: AnyPgColumn, scope: AnyPgColumn) =>
    sameTenant(name, tenant, scope, accessScopes.tenantId, accessScopes.scopeId);
  const accessRoles = core.table.withRLS(
    'access_roles',
    {
      createdAt: createdAt(),
      createdBy: uuid('created_by').notNull(),
      legalEntityId: uuid('legal_entity_id'),
      name: text('name').notNull(),
      roleId: uuid('role_id').primaryKey(),
      tenantId: tenantId(),
    },
    (t) => [
      uniqueIndex('access_roles_tenant_id_uk').on(t.tenantId, t.roleId),
      check('access_roles_name_ck', sql`length(${t.name}) between 1 and 200`),
      sameTenant(
        'access_roles_entity_fk',
        t.tenantId,
        t.legalEntityId,
        legalEntities.tenantId,
        legalEntities.legalEntityId,
      ),
      personFk('access_roles_creator_fk', t.tenantId, t.createdBy),
      ...tenantRlsPolicies('access_roles', t.tenantId),
    ],
  );
  const accessRoleRevisions = core.table.withRLS(
    'access_role_revisions',
    {
      catalogSnapshotId: uuid('catalog_snapshot_id')
        .notNull()
        .references(() => accessCatalogSnapshots.catalogSnapshotId, { onDelete: 'restrict' }),
      cellsJson: jsonb('cells_json').$type<readonly Cell[]>().notNull(),
      createdAt: createdAt(),
      createdBy: uuid('created_by').notNull(),
      provenance: text('provenance').$type<RoleProvenance>().notNull(),
      revision: integer('revision').notNull(),
      roleId: uuid('role_id').notNull(),
      roleRevisionId: uuid('role_revision_id').primaryKey(),
      templateKey: text('template_key'),
      tenantId: tenantId(),
    },
    (t) => [
      uniqueIndex('access_role_revisions_tenant_id_uk').on(t.tenantId, t.roleRevisionId),
      uniqueIndex('access_role_revisions_number_uk').on(t.tenantId, t.roleId, t.revision),
      // The assignment pins a revision of one role; this key is what makes that pair enforceable.
      uniqueIndex('access_role_revisions_role_uk').on(t.tenantId, t.roleId, t.roleRevisionId),
      sameTenant('access_role_revisions_role_fk', t.tenantId, t.roleId, accessRoles.tenantId, accessRoles.roleId),
      personFk('access_role_revisions_creator_fk', t.tenantId, t.createdBy),
      check('access_role_revisions_number_ck', sql`${t.revision} > 0`),
      check(
        'access_role_revisions_provenance_ck',
        sql`${t.provenance} in ('template', 'customer_changed', 'manual', 'imported')`,
      ),
      check(
        'access_role_revisions_template_ck',
        sql`(${t.provenance} in ('template', 'customer_changed')) = (${t.templateKey} is not null)`,
      ),
      check('access_role_revisions_cells_ck', sql`jsonb_typeof(${t.cellsJson}) = 'array'`),
      ...tenantRlsPolicies('access_role_revisions', t.tenantId),
      ...gatewayRequestReadPolicies('access_role_revisions', t.tenantId),
    ],
  );
  const accessDelegations = core.table.withRLS(
    'access_delegations',
    {
      amountCeilingJson: jsonb('amount_ceiling_json').$type<Cell['amountCeiling']>(),
      canRedelegate: boolean('can_redelegate').default(false).notNull(),
      capabilityKeys: text('capability_keys').array().notNull(),
      delegationId: uuid('delegation_id').primaryKey(),
      grantedBy: uuid('granted_by').notNull(),
      managerId: uuid('manager_id').notNull(),
      people: uuid('people').array().notNull(),
      roleIds: uuid('role_ids').array().notNull(),
      scopeId: scopeId(),
      status: text('status').$type<LifecycleStatus>().notNull(),
      tenantId: tenantId(),
      until: timestamp('until', { withTimezone: true }).notNull(),
      validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    },
    (t) => [
      uniqueIndex('access_delegations_tenant_id_uk').on(t.tenantId, t.delegationId),
      scoped('access_delegations_scope_fk', t.tenantId, t.scopeId),
      personFk('access_delegations_granter_fk', t.tenantId, t.grantedBy),
      personFk('access_delegations_manager_fk', t.tenantId, t.managerId),
      check(
        'access_delegations_self_ck',
        sql`${t.grantedBy} <> ${t.managerId} and not (${t.managerId} = any(${t.people}))`,
      ),
      check(
        'access_delegations_envelope_ck',
        sql`cardinality(${t.capabilityKeys}) > 0 and cardinality(${t.roleIds}) > 0 and cardinality(${t.people}) > 0 and array_position(${t.capabilityKeys}, null) is null and array_position(${t.roleIds}, null) is null and array_position(${t.people}, null) is null`,
      ),
      check('access_delegations_redelegate_ck', sql`not ${t.canRedelegate}`),
      check('access_delegations_period_ck', sql`${t.validFrom} < ${t.until}`),
      check('access_delegations_status_ck', sql`${t.status} in ('active', 'revoked', 'expired')`),
      ...tenantRlsPolicies('access_delegations', t.tenantId),
      ...gatewayRequestReadPolicies('access_delegations', t.tenantId),
    ],
  );
  const accessAssignments = core.table.withRLS(
    'access_assignments',
    {
      agentId: uuid('agent_id'),
      assignedBy: uuid('assigned_by').notNull(),
      delegatedBy: uuid('delegated_by'),
      delegationEnvelopeJson: jsonb('delegation_envelope_json'),
      incarnationId: uuid('incarnation_id').primaryKey(),
      principalId: uuid('principal_id'),
      roleId: uuid('role_id').notNull(),
      roleRevisionId: uuid('role_revision_id').notNull(),
      scopeId: scopeId(),
      status: text('status').$type<LifecycleStatus>().notNull(),
      tenantId: tenantId(),
      validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
      validUntil: timestamp('valid_until', { withTimezone: true }),
    },
    (t) => [
      uniqueIndex('access_assignments_tenant_id_uk').on(t.tenantId, t.incarnationId),
      uniqueIndex('access_assignments_scope_uk').on(t.tenantId, t.incarnationId, t.scopeId),
      scoped('access_assignments_scope_fk', t.tenantId, t.scopeId),
      personFk('access_assignments_principal_fk', t.tenantId, t.principalId),
      personFk('access_assignments_agent_fk', t.tenantId, t.agentId),
      personFk('access_assignments_assigner_fk', t.tenantId, t.assignedBy),
      // A live assignment follows one role: the revision it pins always belongs to `role_id`.
      foreignKey({
        columns: [t.tenantId, t.roleId, t.roleRevisionId],
        foreignColumns: [accessRoleRevisions.tenantId, accessRoleRevisions.roleId, accessRoleRevisions.roleRevisionId],
        name: 'access_assignments_role_fk',
      }).onDelete('restrict'),
      sameTenant(
        'access_assignments_delegation_fk',
        t.tenantId,
        t.delegatedBy,
        accessDelegations.tenantId,
        accessDelegations.delegationId,
      ),
      check('access_assignments_holder_xor_ck', sql`(${t.principalId} is null) <> (${t.agentId} is null)`),
      check('access_assignments_period_ck', sql`${t.validUntil} is null or ${t.validFrom} < ${t.validUntil}`),
      check('access_assignments_status_ck', sql`${t.status} in ('active', 'revoked', 'expired')`),
      check(
        'access_assignments_envelope_ck',
        sql`(${t.delegatedBy} is null and ${t.delegationEnvelopeJson} is null) or (${t.delegatedBy} is not null and ${t.delegationEnvelopeJson} is not null and ${t.validUntil} is not null and jsonb_typeof(${t.delegationEnvelopeJson}) = 'object')`,
      ),
      ...tenantRlsPolicies('access_assignments', t.tenantId),
      ...gatewayRequestReadPolicies('access_assignments', t.tenantId),
    ],
  );
  /**
   * Persisted projection identities allow mandates to bind a complete, never-reused cell witness.
   * The identity is (role, scope, capability, mode, slot) and deliberately omits the role revision
   * (O52, O51(2)): an equal-or-broader role edit keeps the same grant incarnation, so a mandate
   * witness stays valid, while a removed or narrowed cell retires it and a later re-add is a new
   * incarnation with a new id that no old approval can reach.
   */
  const accessGrantIncarnations = core.table.withRLS(
    'access_grant_incarnations',
    {
      capabilityKey: text('capability_key').notNull(),
      cellJson: jsonb('cell_json').$type<Cell>().notNull(),
      createdAt: createdAt(),
      grantIncarnationId: uuid('grant_incarnation_id').primaryKey(),
      mode: text('mode').$type<AccessMode>().notNull(),
      roleId: uuid('role_id').notNull(),
      scopeId: scopeId(),
      slot: text('slot').$type<CapabilitySlot>().notNull(),
      status: text('status').$type<'active' | 'retired'>().notNull(),
      tenantId: tenantId(),
    },
    (t) => [
      uniqueIndex('access_grants_tenant_id_uk').on(t.tenantId, t.grantIncarnationId),
      // The mode is part of the identity a witness points at, so SQL proves a witness row was held
      // in the mode its grant really has (R3b-N3a).
      uniqueIndex('access_grants_scope_uk').on(t.tenantId, t.grantIncarnationId, t.scopeId, t.capabilityKey, t.mode),
      // At most one live incarnation per exact cell; a retired one never blocks a fresh re-add.
      uniqueIndex('access_grants_cell_uk')
        .on(t.tenantId, t.scopeId, t.roleId, t.capabilityKey, t.mode, t.slot)
        .where(sql`${t.status} = 'active'`),
      scoped('access_grants_scope_fk', t.tenantId, t.scopeId),
      sameTenant('access_grants_role_fk', t.tenantId, t.roleId, accessRoles.tenantId, accessRoles.roleId),
      check('access_grants_status_ck', sql`${t.status} in ('active', 'retired')`),
      check('access_grants_mode_ck', sql`${t.mode} in ('run', 'propose', 'approve')`),
      check('access_grants_slot_ck', sql`${t.slot} in ('all', 'assigned', 'entrusted', 'team')`),
      check('access_grants_cell_ck', sql`jsonb_typeof(${t.cellJson}) = 'object'`),
      // The denormalized identity is the frozen cell, never a caller's claim about it.
      check(
        'access_grants_cell_identity_ck',
        sql`${t.cellJson}->>'capabilityKey' = ${t.capabilityKey} and ${t.cellJson}->>'mode' = ${t.mode} and ((${t.slot} = 'all' and ${t.cellJson}->'selector'->>'_tag' in ('all', 'targets')) or ${t.slot} = ${t.cellJson}->'selector'->>'_tag')`,
      ),
      ...tenantRlsPolicies('access_grant_incarnations', t.tenantId),
      ...gatewayRequestReadPolicies('access_grant_incarnations', t.tenantId),
    ],
  );
  const accessChangeItems = core.table.withRLS(
    'access_change_items',
    {
      capabilityKey: text('capability_key').notNull(),
      catalogSnapshotId: uuid('catalog_snapshot_id')
        .notNull()
        .references(() => accessCatalogSnapshots.catalogSnapshotId, { onDelete: 'restrict' }),
      createdAt: createdAt(),
      itemId: uuid('item_id').primaryKey(),
      kind: text('kind').$type<AccessChangeKind>().notNull(),
      lineageFrom: text('lineage_from').array().notNull(),
      risk: text('risk').$type<AccessRisk>().notNull(),
      status: text('status').$type<AccessChangeItemStatus>().notNull(),
      suggestedRoleIds: uuid('suggested_role_ids').array().notNull(),
      tenantId: tenantId(),
    },
    (t) => [
      uniqueIndex('access_change_items_tenant_id_uk').on(t.tenantId, t.itemId),
      uniqueIndex('access_change_items_catalog_key_uk').on(t.tenantId, t.catalogSnapshotId, t.capabilityKey, t.kind),
      check('access_change_items_kind_ck', sql`${t.kind} in ('new', 'renamed', 'split', 'removed', 'risk_changed')`),
      check('access_change_items_status_ck', sql`${t.status} in ('pending', 'adopted', 'declined', 'undone')`),
      check('access_change_items_risk_ck', sql`${t.risk} in ('routine', 'sensitive', 'critical')`),
      check(
        'access_change_items_lineage_ck',
        sql`array_position(${t.lineageFrom}, null) is null and case when ${t.kind} in ('renamed', 'split') then cardinality(${t.lineageFrom}) > 0 else cardinality(${t.lineageFrom}) = 0 end`,
      ),
      ...tenantRlsPolicies('access_change_items', t.tenantId),
    ],
  );
  const accessChangeDecisions = core.table.withRLS(
    'access_change_decisions',
    {
      batchId: uuid('batch_id').notNull(),
      decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
      decidedBy: uuid('decided_by').notNull(),
      decision: text('decision').$type<AccessChangeDecisionKind>().notNull(),
      decisionId: uuid('decision_id').primaryKey(),
      itemId: uuid('item_id').notNull(),
      roleRevisionIds: uuid('role_revision_ids').array().notNull(),
      tenantId: tenantId(),
      undoesDecisionId: uuid('undoes_decision_id'),
    },
    (t) => [
      uniqueIndex('access_change_decisions_tenant_id_uk').on(t.tenantId, t.decisionId),
      uniqueIndex('access_change_decisions_batch_item_uk').on(t.tenantId, t.batchId, t.itemId),
      sameTenant(
        'access_change_decisions_item_fk',
        t.tenantId,
        t.itemId,
        accessChangeItems.tenantId,
        accessChangeItems.itemId,
      ),
      // An undo names an earlier decision of this same tenant; the reference stays inside the table.
      foreignKey({
        columns: [t.tenantId, t.undoesDecisionId],
        foreignColumns: [t.tenantId, t.decisionId],
        name: 'access_change_decisions_undo_fk',
      }).onDelete('restrict'),
      personFk('access_change_decisions_person_fk', t.tenantId, t.decidedBy),
      check('access_change_decisions_kind_ck', sql`${t.decision} in ('adopt', 'decline', 'undo')`),
      check(
        'access_change_decisions_revisions_ck',
        sql`array_position(${t.roleRevisionIds}, null) is null and (${t.decision} <> 'decline' or cardinality(${t.roleRevisionIds}) = 0)`,
      ),
      check(
        'access_change_decisions_undo_ck',
        sql`(${t.decision} = 'undo' and ${t.undoesDecisionId} is not null and ${t.undoesDecisionId} <> ${t.decisionId}) or (${t.decision} <> 'undo' and ${t.undoesDecisionId} is null)`,
      ),
      ...tenantRlsPolicies('access_change_decisions', t.tenantId),
    ],
  );
  const accessAgentConnections = core.table.withRLS(
    'access_agent_connections',
    {
      agentId: uuid('agent_id').notNull(),
      ceilingJson: jsonb('ceiling_json').$type<ConsentCeiling>().notNull(),
      connectionId: uuid('connection_id').primaryKey(),
      principalId: uuid('principal_id').notNull(),
      revision: integer('revision').notNull(),
      scopeId: scopeId(),
      status: text('status').$type<LifecycleStatus>().notNull(),
      tenantId: tenantId(),
      validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
      validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
    },
    (t) => [
      uniqueIndex('access_connections_tenant_id_uk').on(t.tenantId, t.connectionId),
      scoped('access_connections_scope_fk', t.tenantId, t.scopeId),
      personFk('access_connections_agent_fk', t.tenantId, t.agentId),
      personFk('access_connections_person_fk', t.tenantId, t.principalId),
      check('access_connections_revision_ck', sql`${t.revision} > 0`),
      check('access_connections_period_ck', sql`${t.validFrom} < ${t.validUntil}`),
      check('access_connections_ceiling_ck', sql`jsonb_typeof(${t.ceilingJson}) = 'object'`),
      check('access_connections_status_ck', sql`${t.status} in ('active', 'revoked', 'expired')`),
      ...tenantRlsPolicies('access_agent_connections', t.tenantId),
      ...gatewayRequestReadPolicies('access_agent_connections', t.tenantId),
    ],
  );
  const accessConsentSnapshots = core.table.withRLS(
    'access_consent_snapshots',
    {
      ceilingJson: jsonb('ceiling_json').$type<ConsentCeiling>().notNull(),
      connectionId: uuid('connection_id').notNull(),
      grantedAt: timestamp('granted_at', { withTimezone: true }).notNull(),
      grantedBy: uuid('granted_by').notNull(),
      revision: integer('revision').notNull(),
      tenantId: tenantId(),
    },
    (t) => [
      primaryKey({ columns: [t.tenantId, t.connectionId, t.revision], name: 'access_consent_snapshots_pk' }),
      sameTenant(
        'access_consent_snapshots_connection_fk',
        t.tenantId,
        t.connectionId,
        accessAgentConnections.tenantId,
        accessAgentConnections.connectionId,
      ),
      personFk('access_consent_snapshots_granter_fk', t.tenantId, t.grantedBy),
      check('access_consent_snapshots_revision_ck', sql`${t.revision} > 0`),
      check('access_consent_snapshots_ceiling_ck', sql`jsonb_typeof(${t.ceilingJson}) = 'object'`),
      ...tenantRlsPolicies('access_consent_snapshots', t.tenantId),
      ...gatewayRequestReadPolicies('access_consent_snapshots', t.tenantId),
    ],
  );
  const commandColumns = () => ({
    capabilityKey: text('capability_key').notNull(),
    commandDigest: text('command_digest').notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    requesterJson: jsonb('requester_json').$type<ActorContext>().notNull(),
    requesterPrincipalId: uuid('requester_principal_id').notNull(),
    scopeId: scopeId(),
    status: text('status').$type<ProposalStatus>().notNull(),
    tenantId: tenantId(),
  });
  /**
   * The proposal row owns the whole lifecycle (O52) and freezes the request. It holds no approval
   * fact at all: the approval is stored once, on `access_mandates`, so no second copy can diverge
   * from it (R3b-M5).
   */
  const accessProposals = core.table.withRLS(
    'access_proposals',
    {
      actionInvocationId: uuid('action_invocation_id'),
      endedAt: timestamp('ended_at', { withTimezone: true }),
      executedAt: timestamp('executed_at', { withTimezone: true }),
      executionOperationId: uuid('execution_operation_id'),
      proposalId: uuid('proposal_id').primaryKey(),
      ...commandColumns(),
      rejectedBy: uuid('rejected_by'),
      requesterAuthorityJson: jsonb('requester_authority_json').$type<readonly AuthorityWitness[]>().notNull(),
      requesterActionAuthorityJson: jsonb('requester_action_authority_json').$type<ActionAuthorityProofV2>(),
      target: text('target'),
    },
    (t) => [
      uniqueIndex('access_proposals_tenant_id_uk').on(t.tenantId, t.proposalId),
      uniqueIndex('access_proposals_invocation_uk').on(t.tenantId, t.actionInvocationId),
      // What the approval record points at: one frozen command, so a mandate can never claim
      // another capability or digest than the proposal it approves (R3b-N3c).
      uniqueIndex('access_proposals_command_uk').on(
        t.tenantId,
        t.proposalId,
        t.scopeId,
        t.capabilityKey,
        t.commandDigest,
      ),
      uniqueIndex('access_proposals_execution_uk').on(t.executionOperationId),
      scoped('access_proposals_scope_fk', t.tenantId, t.scopeId),
      personFk('access_proposals_requester_fk', t.tenantId, t.requesterPrincipalId),
      personFk('access_proposals_rejecter_fk', t.tenantId, t.rejectedBy),
      digest('access_proposals_digest_ck', t.commandDigest),
      check('access_proposals_period_ck', sql`${t.createdAt} < ${t.expiresAt}`),
      check(
        'access_proposals_status_ck',
        sql`${t.status} in ('pending', 'approved', 'executed', 'lapsed', 'rejected', 'expired')`,
      ),
      check(
        'access_proposals_end_ck',
        sql`((${t.status} = 'rejected') = (${t.rejectedBy} is not null)) and ((${t.status} in ('rejected', 'lapsed', 'expired')) = (${t.endedAt} is not null))`,
      ),
      // One execution receipt, and only on an executed proposal. That it happens inside the
      // approval window is proved against the approval record by the transition trigger.
      check(
        'access_proposals_execution_ck',
        sql`(${t.status} = 'executed') = (${t.executedAt} is not null and ${t.executionOperationId} is not null)`,
      ),
      check(
        'access_proposals_requester_ck',
        sql`jsonb_typeof(${t.requesterJson}) = 'object' and ${t.requesterJson}->>'principalId' is not distinct from ${t.requesterPrincipalId}::text and jsonb_typeof(${t.requesterAuthorityJson}) = 'array' and (
          (${t.requesterActionAuthorityJson} is null and jsonb_array_length(${t.requesterAuthorityJson}) > 0)
          or (${t.requesterActionAuthorityJson} is not null and jsonb_array_length(${t.requesterAuthorityJson}) = 0 and ${t.target} is null
            and ${t.requesterActionAuthorityJson}->>'format' is not distinct from 'core.action-authority/2'
            and ${t.requesterActionAuthorityJson}->>'phase' is not distinct from 'requester'
            and ${t.requesterActionAuthorityJson}->>'principalId' is not distinct from ${t.requesterPrincipalId}::text
            and ${t.requesterActionAuthorityJson}->>'scopeId' is not distinct from ${t.scopeId}::text
            and ${t.requesterActionAuthorityJson}->>'commandDigest' is not distinct from ${t.commandDigest}))`,
      ),
      ...tenantRlsPolicies('access_proposals', t.tenantId),
    ],
  );
  /** The immutable command and its owner Action binding are appended in the proposal's transaction. */
  const accessFrozenCommands = core.table.withRLS(
    'access_frozen_commands',
    {
      actionKey: text('action_key').notNull(),
      capabilityKey: text('capability_key').notNull(),
      commandDigest: text('command_digest').notNull(),
      commandJson: jsonb('command_json').$type<unknown>().notNull(),
      createdAt: createdAt(),
      proposalId: uuid('proposal_id').notNull(),
      scopeId: scopeId(),
      tenantId: tenantId(),
    },
    (t) => [
      primaryKey({ columns: [t.tenantId, t.proposalId], name: 'access_frozen_commands_pk' }),
      foreignKey({
        columns: [t.tenantId, t.proposalId, t.scopeId, t.capabilityKey, t.commandDigest],
        foreignColumns: [
          accessProposals.tenantId,
          accessProposals.proposalId,
          accessProposals.scopeId,
          accessProposals.capabilityKey,
          accessProposals.commandDigest,
        ],
        name: 'access_frozen_commands_proposal_fk',
      }).onDelete('restrict'),
      digest('access_frozen_commands_digest_ck', t.commandDigest),
      check('access_frozen_commands_command_ck', sql`jsonb_typeof(${t.commandJson}) = 'object'`),
      ...tenantRlsPolicies('access_frozen_commands', t.tenantId).filter(
        (policy) => policy.for === 'select' || policy.for === 'insert',
      ),
      ...gatewayRequestReadPolicies('access_frozen_commands', t.tenantId),
    ],
  );
  /**
   * The approval record and nothing else: who approved which frozen command, when, with which of
   * their own assignments, and until when it may run (O52). The witnesses an approval binds are the
   * rows of `access_mandate_grants`, so the same authority is never stored twice. It carries no
   * status: the proposal row owns the lifecycle.
   */
  const accessMandates = core.table.withRLS(
    'access_mandates',
    {
      approvalExpiresAt: timestamp('approval_expires_at', { withTimezone: true }).notNull(),
      actionAuthorityJson: jsonb('action_authority_json').$type<ActionAuthorityProofV2>(),
      approvedAt: timestamp('approved_at', { withTimezone: true }).notNull(),
      approverAssignmentIncarnationId: uuid('approver_assignment_incarnation_id'),
      approverId: uuid('approver_id').notNull(),
      capabilityKey: text('capability_key').notNull(),
      commandDigest: text('command_digest').notNull(),
      executionAssignmentIncarnationId: uuid('execution_assignment_incarnation_id'),
      mandateId: uuid('mandate_id').primaryKey(),
      proposalId: uuid('proposal_id').notNull(),
      scopeId: scopeId(),
      tenantId: tenantId(),
    },
    (t) => [
      uniqueIndex('access_mandates_tenant_id_uk').on(t.tenantId, t.mandateId),
      uniqueIndex('access_mandates_proposal_uk').on(t.tenantId, t.proposalId),
      uniqueIndex('access_mandates_scope_uk').on(t.tenantId, t.mandateId, t.scopeId),
      scoped('access_mandates_scope_fk', t.tenantId, t.scopeId),
      // The approval is the approval of one frozen command of one proposal: the scope, the capability
      // and the digest are the proposal's own, and SQL refuses any other claim (R3b-N3c).
      foreignKey({
        columns: [t.tenantId, t.proposalId, t.scopeId, t.capabilityKey, t.commandDigest],
        foreignColumns: [
          accessProposals.tenantId,
          accessProposals.proposalId,
          accessProposals.scopeId,
          accessProposals.capabilityKey,
          accessProposals.commandDigest,
        ],
        name: 'access_mandates_proposal_fk',
      }).onDelete('restrict'),
      sameTenant(
        'access_mandates_approver_assignment_fk',
        t.tenantId,
        t.approverAssignmentIncarnationId,
        accessAssignments.tenantId,
        accessAssignments.incarnationId,
      ),
      sameTenant(
        'access_mandates_executor_assignment_fk',
        t.tenantId,
        t.executionAssignmentIncarnationId,
        accessAssignments.tenantId,
        accessAssignments.incarnationId,
      ),
      personFk('access_mandates_approver_fk', t.tenantId, t.approverId),
      digest('access_mandates_digest_ck', t.commandDigest),
      check('access_mandates_ttl_ck', sql`${t.approvedAt} < ${t.approvalExpiresAt}`),
      check(
        'access_mandates_authority_format_ck',
        sql`(${t.actionAuthorityJson} is null and ${t.approverAssignmentIncarnationId} is not null and ${t.executionAssignmentIncarnationId} is not null)
          or (${t.actionAuthorityJson} is not null and ${t.approverAssignmentIncarnationId} is null and ${t.executionAssignmentIncarnationId} is null
            and ${t.actionAuthorityJson}->>'format' is not distinct from 'core.action-authority/2'
            and ${t.actionAuthorityJson}->>'phase' is not distinct from 'approver'
            and ${t.actionAuthorityJson}->>'principalId' is not distinct from ${t.approverId}::text
            and ${t.actionAuthorityJson}->>'scopeId' is not distinct from ${t.scopeId}::text
            and ${t.actionAuthorityJson}->>'commandDigest' is not distinct from ${t.commandDigest})`,
      ),
      ...tenantRlsPolicies('access_mandates', t.tenantId),
    ],
  );
  /**
   * Every witness, including parent record reads, is retained and tenant-qualified. The foreign keys
   * carry the mandate's scope, the grant's real capability and its real mode; the migration's witness
   * guard adds what a column check cannot see, namely that the grant is a live incarnation of the role
   * the witness assignment holds and that an approval or execution witness sits on the capability the
   * proposal commands. Together they prove the witness is held in the proposal's scope, on the cell it
   * claims (R2-H1, R3b-N3a, R4-M3).
   */
  const accessMandateGrants = core.table.withRLS(
    'access_mandate_grants',
    {
      assignmentIncarnationId: uuid('assignment_incarnation_id').notNull(),
      capabilityKey: text('capability_key').notNull(),
      grantIncarnationId: uuid('grant_incarnation_id').notNull(),
      mandateId: uuid('mandate_id').notNull(),
      mode: text('mode').$type<AccessMode>().notNull(),
      purpose: text('purpose').$type<AuthorityWitness['purpose']>().notNull(),
      scopeId: scopeId(),
      tenantId: tenantId(),
    },
    (t) => [
      primaryKey({
        columns: [t.tenantId, t.mandateId, t.grantIncarnationId, t.assignmentIncarnationId, t.purpose],
        name: 'access_mandate_grants_pk',
      }),
      foreignKey({
        columns: [t.tenantId, t.mandateId, t.scopeId],
        foreignColumns: [accessMandates.tenantId, accessMandates.mandateId, accessMandates.scopeId],
        name: 'access_mandate_grants_mandate_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [t.tenantId, t.grantIncarnationId, t.scopeId, t.capabilityKey, t.mode],
        foreignColumns: [
          accessGrantIncarnations.tenantId,
          accessGrantIncarnations.grantIncarnationId,
          accessGrantIncarnations.scopeId,
          accessGrantIncarnations.capabilityKey,
          accessGrantIncarnations.mode,
        ],
        name: 'access_mandate_grants_grant_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [t.tenantId, t.assignmentIncarnationId, t.scopeId],
        foreignColumns: [accessAssignments.tenantId, accessAssignments.incarnationId, accessAssignments.scopeId],
        name: 'access_mandate_grants_assignment_fk',
      }).onDelete('restrict'),
      check(
        'access_mandate_grants_purpose_ck',
        sql`${t.purpose} in ('execution', 'approval', 'requester', 'parent_record_read')`,
      ),
      check(
        'access_mandate_grants_mode_ck',
        sql`(${t.purpose} = 'requester' and ${t.mode} = 'propose') or (${t.purpose} = 'approval' and ${t.mode} = 'approve') or (${t.purpose} in ('execution', 'parent_record_read') and ${t.mode} = 'run')`,
      ),
      ...tenantRlsPolicies('access_mandate_grants', t.tenantId),
    ],
  );
  /**
   * Membership intent: who takes part in which scope, and how. `member` is operational membership;
   * `owner` (the tenant context) and `access_admin` (one company) are management authority that still
   * requires membership before it administers anything (O28, O65). The scope kind is a cross-table
   * rule, so the migration's guard refuses an owner outside the tenant context and an access admin
   * outside a company; the column check keeps the management kinds to a person's own authority.
   * A live row is unique per scope, holder and kind, so suspension is a status of the one row and a
   * revoked membership is never reopened: a rejoin is a new membership (D27).
   */
  const accessMemberships = core.table.withRLS(
    'access_memberships',
    {
      agentId: uuid('agent_id'),
      createdAt: createdAt(),
      /** When the revocation that ended the row was recorded; null for every other row and writer. */
      endedAt: timestamp('ended_at', { withTimezone: true }),
      /** The person who ended the row through the people commands; null when another writer revoked it. */
      endedBy: uuid('ended_by'),
      /** Why the people commands ended the row, as the ending person stated it. */
      endedReason: text('ended_reason'),
      kind: text('kind').$type<MembershipKind>().notNull(),
      membershipId: uuid('membership_id').primaryKey(),
      principalId: uuid('principal_id'),
      recordedBy: uuid('recorded_by').notNull(),
      scopeId: scopeId(),
      status: text('status').$type<MembershipStatus>().notNull(),
      tenantId: tenantId(),
      validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
      validUntil: timestamp('valid_until', { withTimezone: true }),
    },
    (t) => [
      uniqueIndex('access_memberships_tenant_id_uk').on(t.tenantId, t.membershipId),
      uniqueIndex('access_memberships_subject_uk')
        .on(t.tenantId, t.scopeId, t.principalId, t.kind)
        .where(sql`${t.status} <> 'revoked' and ${t.principalId} is not null`),
      uniqueIndex('access_memberships_agent_uk')
        .on(t.tenantId, t.scopeId, t.agentId, t.kind)
        .where(sql`${t.status} <> 'revoked' and ${t.agentId} is not null`),
      scoped('access_memberships_scope_fk', t.tenantId, t.scopeId),
      personFk('access_memberships_principal_fk', t.tenantId, t.principalId),
      personFk('access_memberships_agent_fk', t.tenantId, t.agentId),
      personFk('access_memberships_recorder_fk', t.tenantId, t.recordedBy),
      personFk('access_memberships_ender_fk', t.tenantId, t.endedBy),
      // An end is recorded only on a revoked row, by a person and at an instant together; the
      // migration's guard sets it once, on the move to 'revoked', and never changes it afterwards.
      check(
        'access_memberships_end_ck',
        sql`(${t.endedBy} is null and ${t.endedAt} is null and ${t.endedReason} is null) or (${t.status} = 'revoked' and ${t.endedBy} is not null and ${t.endedAt} is not null)`,
      ),
      check(
        'access_memberships_end_reason_ck',
        sql`${t.endedReason} is null or length(${t.endedReason}) between 1 and 500`,
      ),
      check('access_memberships_holder_xor_ck', sql`(${t.principalId} is null) <> (${t.agentId} is null)`),
      check('access_memberships_kind_ck', sql`${t.kind} in ('member', 'owner', 'access_admin')`),
      check('access_memberships_status_ck', sql`${t.status} in ('active', 'suspended', 'revoked')`),
      // `owner` and `access_admin` are relations of a verified human, never of an agent (O46).
      check('access_memberships_manager_ck', sql`${t.kind} = 'member' or ${t.principalId} is not null`),
      check('access_memberships_period_ck', sql`${t.validUntil} is null or ${t.validFrom} < ${t.validUntil}`),
      ...tenantRlsPolicies('access_memberships', t.tenantId),
      ...gatewayRequestReadPolicies('access_memberships', t.tenantId),
    ],
  );
  /**
   * A team is a record-scope within one access scope (`access_team` in the engine schema): the
   * `team` selector of a capability cell reaches the records of its scope whose team this holder
   * takes part in (O24). It is current intent, not evidence: its membership ends and the tuple with
   * it, while the team identity itself never moves scope.
   */
  const accessTeams = core.table.withRLS(
    'access_teams',
    {
      createdAt: createdAt(),
      createdBy: uuid('created_by').notNull(),
      name: text('name').notNull(),
      scopeId: scopeId(),
      teamId: uuid('team_id').primaryKey(),
      tenantId: tenantId(),
    },
    (t) => [
      uniqueIndex('access_teams_tenant_id_uk').on(t.tenantId, t.teamId),
      uniqueIndex('access_teams_name_uk').on(t.tenantId, t.scopeId, t.name),
      scoped('access_teams_scope_fk', t.tenantId, t.scopeId),
      personFk('access_teams_creator_fk', t.tenantId, t.createdBy),
      check('access_teams_name_ck', sql`length(${t.name}) between 1 and 200`),
      ...tenantRlsPolicies('access_teams', t.tenantId),
      ...gatewayRequestReadPolicies('access_teams', t.tenantId),
    ],
  );
  const accessTeamMembers = core.table.withRLS(
    'access_team_members',
    {
      addedAt: timestamp('added_at', { withTimezone: true }).notNull(),
      addedBy: uuid('added_by').notNull(),
      agentId: uuid('agent_id'),
      principalId: uuid('principal_id'),
      teamId: uuid('team_id').notNull(),
      teamMemberId: uuid('team_member_id').primaryKey(),
      tenantId: tenantId(),
    },
    (t) => [
      uniqueIndex('access_team_members_tenant_id_uk').on(t.tenantId, t.teamMemberId),
      uniqueIndex('access_team_members_principal_uk')
        .on(t.tenantId, t.teamId, t.principalId)
        .where(sql`${t.principalId} is not null`),
      uniqueIndex('access_team_members_agent_uk')
        .on(t.tenantId, t.teamId, t.agentId)
        .where(sql`${t.agentId} is not null`),
      sameTenant('access_team_members_team_fk', t.tenantId, t.teamId, accessTeams.tenantId, accessTeams.teamId),
      personFk('access_team_members_principal_fk', t.tenantId, t.principalId),
      personFk('access_team_members_agent_fk', t.tenantId, t.agentId),
      personFk('access_team_members_adder_fk', t.tenantId, t.addedBy),
      check('access_team_members_holder_xor_ck', sql`(${t.principalId} is null) <> (${t.agentId} is null)`),
      ...tenantRlsPolicies('access_team_members', t.tenantId),
      ...gatewayRequestReadPolicies('access_team_members', t.tenantId),
    ],
  );
  const accessOperationJournals = core.table.withRLS(
    'access_operation_journals',
    {
      commandDigest: text('command_digest').notNull(),
      failureCode: text('failure_code'),
      operationId: uuid('operation_id').primaryKey(),
      phase: text('phase').$type<OperationPhase>().notNull(),
      projectionToken: text('projection_token'),
      scopeId: scopeId(),
      startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
      tenantId: tenantId(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    },
    (t) => [
      uniqueIndex('access_operation_journals_tenant_id_uk').on(t.tenantId, t.operationId),
      uniqueIndex('access_operation_journals_scope_id_uk').on(t.tenantId, t.scopeId, t.operationId),
      scoped('access_operation_journals_scope_fk', t.tenantId, t.scopeId),
      digest('access_operation_journals_digest_ck', t.commandDigest),
      check(
        'access_operation_journals_phase_ck',
        sql`${t.phase} in ('validated', 'fenced', 'projected', 'committed', 'failed')`,
      ),
      check('access_operation_journals_time_ck', sql`${t.startedAt} <= ${t.updatedAt}`),
      check(
        'access_operation_journals_projection_ck',
        sql`${t.phase} not in ('projected', 'committed') or ${t.projectionToken} is not null`,
      ),
      ...tenantRlsPolicies('access_operation_journals', t.tenantId),
    ],
  );
  const accessScopeFences = core.table.withRLS(
    'access_scope_fences',
    {
      /**
       * Until when the owning operation's hold is live. The holder sets it when it takes the fence and renews it
       * while it works; once it lapses, a later projection of the tenant may take the fence over (and must finish
       * a full reconcile before it releases it). A `Ready` fence has none.
       */
      leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
      owningOperationId: uuid('owning_operation_id'),
      revision: integer('revision').notNull(),
      scopeId: uuid('scope_id').primaryKey(),
      state: text('state').$type<ScopeFenceState>().notNull(),
      tenantId: tenantId(),
    },
    (t) => [
      scoped('access_scope_fences_scope_fk', t.tenantId, t.scopeId),
      foreignKey({
        columns: [t.tenantId, t.scopeId, t.owningOperationId],
        foreignColumns: [
          accessOperationJournals.tenantId,
          accessOperationJournals.scopeId,
          accessOperationJournals.operationId,
        ],
        name: 'access_scope_fences_operation_fk',
      }).onDelete('restrict'),
      check('access_scope_fences_state_ck', sql`${t.state} in ('Ready', 'Changing', 'Unavailable')`),
      check(
        'access_scope_fences_owner_ck',
        sql`(${t.state} = 'Ready' and ${t.owningOperationId} is null) or (${t.state} <> 'Ready' and ${t.owningOperationId} is not null)`,
      ),
      check('access_scope_fences_revision_ck', sql`${t.revision} > 0`),
      check('access_scope_fences_lease_ck', sql`${t.state} <> 'Ready' or ${t.leaseExpiresAt} is null`),
      // The fence sweeper's one statement a minute reads only held fences, which are few and short-lived.
      index('access_scope_fences_held_ix')
        .on(t.leaseExpiresAt)
        .where(sql`${t.state} = 'Changing'`),
      ...tenantRlsPolicies('access_scope_fences', t.tenantId),
      ...gatewayRequestReadPolicies('access_scope_fences', t.tenantId),
    ],
  );
  const accessDecisionLogs = core.table.withRLS(
    'access_decision_logs',
    {
      actorJson: jsonb('actor_json').$type<ActorContext>().notNull(),
      actorPrincipalId: uuid('actor_principal_id').notNull(),
      admissionDeadline: timestamp('admission_deadline', { withTimezone: true }),
      capabilityKey: text('capability_key').notNull(),
      correlationId: text('correlation_id').notNull(),
      decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
      decisionLogId: uuid('decision_log_id').primaryKey(),
      delegateAppId: text('delegate_app_id'),
      delegatePrincipalId: uuid('delegate_principal_id'),
      mode: text('mode').$type<AccessMode>().notNull(),
      onBehalfOfPrincipalId: uuid('on_behalf_of_principal_id'),
      operationId: uuid('operation_id'),
      outcome: text('outcome').$type<DecisionOutcome>().notNull(),
      reasonsJson: jsonb('reasons_json').$type<readonly DecisionReason[]>().notNull(),
      scopeId: scopeId(),
      scopeTarget: text('target'),
      tenantId: tenantId(),
    },
    (t) => [
      scoped('access_decision_logs_scope_fk', t.tenantId, t.scopeId),
      personFk('access_decision_logs_actor_fk', t.tenantId, t.actorPrincipalId),
      // The asker of a "Proč?" explanation is a person of this tenant too (O86), or nothing at all.
      personFk('access_decision_logs_on_behalf_of_fk', t.tenantId, t.onBehalfOfPrincipalId),
      sameTenant(
        'access_decision_logs_operation_fk',
        t.tenantId,
        t.operationId,
        accessOperationJournals.tenantId,
        accessOperationJournals.operationId,
      ),
      check(
        'access_decision_logs_delegate_ck',
        sql`(${t.delegateAppId} is null) = (${t.delegatePrincipalId} is null) and (${t.delegateAppId} is null or length(${t.delegateAppId}) between 1 and 120)`,
      ),
      check('access_decision_logs_mode_ck', sql`${t.mode} in ('run', 'propose', 'approve')`),
      check('access_decision_logs_correlation_ck', sql`length(${t.correlationId}) between 1 and 200`),
      check(
        'access_decision_logs_outcome_ck',
        sql`${t.outcome} in ('ALLOWED', 'NEEDS_APPROVAL', 'DENIED', 'UNAVAILABLE')`,
      ),
      check(
        'access_decision_logs_reasons_ck',
        sql`jsonb_typeof(${t.reasonsJson}) = 'array' and jsonb_array_length(${t.reasonsJson}) > 0`,
      ),
      check(
        'access_decision_logs_actor_ck',
        sql`jsonb_typeof(${t.actorJson}) = 'object' and ${t.actorJson}->>'principalId' is not distinct from ${t.actorPrincipalId}::text`,
      ),
      ...tenantRlsPolicies('access_decision_logs', t.tenantId),
      ...gatewayRequestInsertPolicies('access_decision_logs', t.tenantId),
    ],
  );

  /**
   * The registered workload identities of one tenant (O73). A `service`/`integration`/`system`
   * principal is admitted on an `accessWorkload` carrier only when this registry holds an active
   * binding for one of the carrier's declared keys; the principal kind alone grants nothing. Core is
   * the only writer. A binding is identity, not a grant: a revoked one is never reopened, so a
   * re-bind is a new row with a new incarnation (D27).
   */
  const accessWorkloadBindings = core.table.withRLS(
    'access_workload_bindings',
    {
      bindingId: uuid('binding_id').primaryKey(),
      createdAt: createdAt(),
      incarnation: uuid('incarnation').notNull(),
      principalId: uuid('principal_id').notNull(),
      revokedAt: timestamp('revoked_at', { withTimezone: true }),
      status: text('status').$type<WorkloadBindingStatus>().notNull(),
      tenantId: tenantId(),
      workloadKey: text('workload_key').notNull(),
    },
    (t) => [
      uniqueIndex('access_workload_bindings_tenant_id_uk').on(t.tenantId, t.bindingId),
      // The incarnation is the binding's identity a later reference may point at, never reused.
      uniqueIndex('access_workload_bindings_incarnation_uk').on(t.tenantId, t.incarnation),
      // At most one live binding per principal and workload key; a revoked one never blocks a re-bind.
      uniqueIndex('access_workload_bindings_active_uk')
        .on(t.tenantId, t.principalId, t.workloadKey)
        .where(sql`${t.status} = 'active'`),
      personFk('access_workload_bindings_principal_fk', t.tenantId, t.principalId),
      check('access_workload_bindings_status_ck', sql`${t.status} in ('active', 'revoked')`),
      // The key grammar of the contract (O73): a module namespace and one kebab name.
      check(
        'access_workload_bindings_key_ck',
        sql`${t.workloadKey} ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*(\\.[a-z][a-z0-9]*(-[a-z0-9]+)*)+$' and length(${t.workloadKey}) <= 200`,
      ),
      check('access_workload_bindings_revoked_ck', sql`(${t.status} = 'revoked') = (${t.revokedAt} is not null)`),
      ...tenantRlsPolicies('access_workload_bindings', t.tenantId),
      ...gatewayRequestReadPolicies('access_workload_bindings', t.tenantId),
    ],
  );

  /**
   * The one company an active workload binding is explicitly registered for (D6). A binding is
   * tenant-wide, so a standalone workload that holds no verified module actor selects no company at
   * all unless its owner declared one here: at most one live registration per binding, written only
   * by the install/bootstrap path. Like the bindings, a registration is identity, not a grant, and a
   * revoked one is never reopened, so a re-registration is a new row with a new incarnation (D27).
   */
  const accessWorkloadCompanyBindings = core.table.withRLS(
    'access_workload_company_bindings',
    {
      companyBindingId: uuid('company_binding_id').primaryKey(),
      createdAt: createdAt(),
      incarnation: uuid('incarnation').notNull(),
      legalEntityId: uuid('legal_entity_id').notNull(),
      revokedAt: timestamp('revoked_at', { withTimezone: true }),
      status: text('status').$type<WorkloadBindingStatus>().notNull(),
      tenantId: tenantId(),
      workloadBindingId: uuid('workload_binding_id').notNull(),
    },
    (t) => [
      uniqueIndex('access_workload_company_bindings_tenant_id_uk').on(t.tenantId, t.companyBindingId),
      // The incarnation is the registration's identity a later reference may point at, never reused.
      uniqueIndex('access_workload_company_bindings_incarnation_uk').on(t.tenantId, t.incarnation),
      // At most one live company per binding: a workload selects exactly the company its owner declared.
      uniqueIndex('access_workload_company_bindings_active_uk')
        .on(t.tenantId, t.workloadBindingId)
        .where(sql`${t.status} = 'active'`),
      // The registration names an active-or-revoked binding of this tenant, never another tenant's.
      sameTenant(
        'access_workload_company_bindings_binding_fk',
        t.tenantId,
        t.workloadBindingId,
        accessWorkloadBindings.tenantId,
        accessWorkloadBindings.bindingId,
      ),
      // The registered company is a company of this tenant, so a cross-tenant company is impossible.
      sameTenant(
        'access_workload_company_bindings_company_fk',
        t.tenantId,
        t.legalEntityId,
        legalEntities.tenantId,
        legalEntities.legalEntityId,
      ),
      check('access_workload_company_bindings_status_ck', sql`${t.status} in ('active', 'revoked')`),
      check(
        'access_workload_company_bindings_revoked_ck',
        sql`(${t.status} = 'revoked') = (${t.revokedAt} is not null)`,
      ),
      ...tenantRlsPolicies('access_workload_company_bindings', t.tenantId),
      ...gatewayRequestReadPolicies('access_workload_company_bindings', t.tenantId),
    ],
  );

  const accessDatabaseSchema = {
    accessAgentConnections,
    accessAssignments,
    accessCatalogEntries,
    accessCatalogSnapshots,
    accessChangeDecisions,
    accessChangeItems,
    accessConsentSnapshots,
    accessDecisionLogs,
    accessDelegations,
    accessFrozenCommands,
    accessGrantIncarnations,
    accessMandateGrants,
    accessMandates,
    accessMemberships,
    accessOperationJournals,
    accessProposals,
    accessRoleRevisions,
    accessRoles,
    accessScopeFences,
    accessScopes,
    accessTeamMembers,
    accessTeams,
    accessWorkloadBindings,
    accessWorkloadCompanyBindings,
  } as const;
  const ACCESS_TABLES = Object.values(accessDatabaseSchema);
  const ACCESS_TABLE_INVENTORY = [
    'access_catalog_snapshots',
    'access_catalog_entries',
    'access_scopes',
    'access_roles',
    'access_role_revisions',
    'access_delegations',
    'access_assignments',
    'access_grant_incarnations',
    'access_change_items',
    'access_change_decisions',
    'access_agent_connections',
    'access_consent_snapshots',
    'access_frozen_commands',
    'access_proposals',
    'access_mandates',
    'access_mandate_grants',
    'access_operation_journals',
    'access_scope_fences',
    'access_decision_logs',
    'access_memberships',
    'access_teams',
    'access_team_members',
    'access_workload_bindings',
    'access_workload_company_bindings',
  ] as const;
  return { all: ACCESS_TABLES, inventory: ACCESS_TABLE_INVENTORY, tables: accessDatabaseSchema };
};
