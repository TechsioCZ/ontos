import { tenantLegalEntityRlsPolicies } from '@app/core-runtime';
import { defineRelations, sql } from 'drizzle-orm';
import {
  boolean,
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgPolicy,
  pgSchema,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * Private persistence schema for Commerce Customer Context. Cross-module code must use the
 * generated module APIs and must never import this schema.
 */
export const COMMERCE_CUSTOMER_CONTEXT_SCHEMA_NAME = 'commerce_customer_context';

export const COMMERCE_CUSTOMER_CONTEXT_TABLE_INVENTORY = [
  'access_mutation_journal',
  'address_book_reconciliation_receipts',
  'counterparty_access_invitations',
  'counterparty_commerce_access_grants',
  'counterparty_invitation_claim_attempts',
  'counterparty_invitation_claim_proofs',
  'counterparty_purchase_limit_defaults',
  'counterparty_purchasing_profiles',
  'customer_address_defaults',
  'customer_group_memberships',
  'customer_group_lifecycle_periods',
  'customer_group_revisions',
  'customer_groups',
  'customer_payment_term_entitlements',
  'customer_payment_term_preferences',
  'payment_term_retirement_reservations',
  'customer_price_group_assignments',
  'customer_profile_aliases',
  'customer_profile_lifecycle_history',
  'customer_profiles',
  'customer_setting_revisions',
  'guest_retail_attributions',
  'party_merge_profile_observations',
  'principal_purchase_limit_overrides',
  'purchase_proposal_revisions',
  'approval_hierarchies',
  'approval_routes',
  'purchase_approval_requests',
  'approval_decisions',
  'approval_revalidations',
  'profile_reconciliation_case_members',
  'profile_reconciliation_cases',
  'profile_reconciliation_owner_outcomes',
  'retail_customer_profiles',
  'retail_portal_profile_binding_permission_mutations',
  'retail_portal_profile_binding_history',
  'retail_portal_profile_bindings',
  'saved_addresses',
] as const;

export const commerceCustomerContextSchema = pgSchema(COMMERCE_CUSTOMER_CONTEXT_SCHEMA_NAME);

const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).defaultNow().notNull();
const recordedAt = () => timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull();
const effectiveFrom = () => timestamp('effective_from', { withTimezone: true }).notNull();
const effectiveTo = () => timestamp('effective_to', { withTimezone: true });

const operationAttribution = () => ({
  actionInvocationId: uuid('action_invocation_id').notNull(),
  actorPrincipalId: uuid('actor_principal_id').notNull(),
  reason: text('reason'),
  recordedAt: recordedAt(),
});

const scopeColumns = () => ({
  tenantId: uuid('tenant_id').notNull(),
  legalEntityId: uuid('legal_entity_id').notNull(),
});

const scopeIdentity = (
  name: string,
  table: Readonly<Record<'tenantId' | 'legalEntityId', AnyPgColumn>>,
  id: AnyPgColumn,
) => unique(name).on(table.tenantId, table.legalEntityId, id);

const scopedPolicies = (
  prefix: string,
  table: Readonly<Record<'tenantId' | 'legalEntityId', AnyPgColumn>>,
) => {
  const predicate = sql`${table.tenantId} = nullif(current_setting('ontos.tenant_id', true), '')::uuid and ${table.legalEntityId} = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid`;
  return [
    ...tenantLegalEntityRlsPolicies(prefix, table.tenantId, table.legalEntityId),
    // SECURITY DEFINER owners remain subject to FORCE RLS. PUBLIC is safe here because the
    // runtime role has no raw table grants; it lets an owner routine honor the installed scope.
    pgPolicy(`${prefix}_owner_routine`, {
      for: 'all',
      to: 'public',
      using: predicate,
      withCheck: predicate,
    }),
  ] as const;
};

const trimmed = (name: string, column: AnyPgColumn) =>
  check(name, sql`${column} = btrim(${column}) and length(${column}) > 0`);

const optionalTrimmed = (name: string, column: AnyPgColumn) =>
  check(name, sql`${column} is null or (${column} = btrim(${column}) and length(${column}) > 0)`);

const positiveRevision = (name: string, revision: AnyPgColumn) => check(name, sql`${revision} > 0`);

const halfOpenPeriod = (
  name: string,
  table: Readonly<Record<'effectiveFrom' | 'effectiveTo', AnyPgColumn>>,
) =>
  check(name, sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`);

/** Internal identity/lifecycle row shared by the two concrete profile resources. */
export const customerProfiles = commerceCustomerContextSchema.table.withRLS(
  'customer_profiles',
  {
    customerProfileId: uuid('customer_profile_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    profileKind: text('profile_kind').notNull(),
    lifecycle: text('lifecycle').default('ACTIVE').notNull(),
    revision: integer('revision').default(1).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    scopeIdentity('ccc_profiles_scope_id_uk', table, table.customerProfileId),
    unique('ccc_profiles_tenant_id_uk').on(table.tenantId, table.customerProfileId),
    check('ccc_profiles_kind_ck', sql`${table.profileKind} in ('RETAIL', 'COUNTERPARTY')`),
    check(
      'ccc_profiles_lifecycle_ck',
      sql`${table.lifecycle} in ('ACTIVE', 'SUSPENDED', 'ARCHIVED')`,
    ),
    positiveRevision('ccc_profiles_revision_ck', table.revision),
    ...scopedPolicies('ccc_profiles_scope', table),
  ],
);

/** Monotonic aggregate revision, including meaningful transitions to absence. */
export const customerSettingRevisions = commerceCustomerContextSchema.table.withRLS(
  'customer_setting_revisions',
  {
    customerSettingRevisionId: uuid('customer_setting_revision_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    customerProfileId: uuid('customer_profile_id').notNull(),
    settingKind: text('setting_kind').notNull(),
    currentRevision: integer('current_revision').default(0).notNull(),
    lastActionInvocationId: uuid('last_action_invocation_id'),
    updatedAt: updatedAt(),
  },
  (table) => [
    scopeIdentity('ccc_setting_revisions_scope_id_uk', table, table.customerSettingRevisionId),
    unique('ccc_setting_revisions_profile_kind_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.customerProfileId,
      table.settingKind,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.customerProfileId],
      foreignColumns: [
        customerProfiles.tenantId,
        customerProfiles.legalEntityId,
        customerProfiles.customerProfileId,
      ],
      name: 'ccc_setting_revisions_profile_fk',
    }).onDelete('restrict'),
    check(
      'ccc_setting_revisions_kind_ck',
      sql`${table.settingKind} in ('ADDRESS_DEFAULTS', 'GROUP_MEMBERSHIP', 'PAYMENT_TERMS', 'PRICE_GROUP')`,
    ),
    check('ccc_setting_revisions_revision_ck', sql`${table.currentRevision} >= 0`),
    ...scopedPolicies('ccc_setting_revisions_scope', table),
  ],
);

export const retailCustomerProfiles = commerceCustomerContextSchema.table.withRLS(
  'retail_customer_profiles',
  {
    retailCustomerProfileId: uuid('retail_customer_profile_id').primaryKey(),
    ...scopeColumns(),
    partyResourceId: text('party_resource_id').notNull(),
    partyResourceRevision: text('party_resource_revision'),
    attributionKind: text('attribution_kind').default('AUTHENTICATED').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    scopeIdentity('ccc_retail_profiles_scope_id_uk', table, table.retailCustomerProfileId),
    unique('ccc_retail_profiles_business_key_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.partyResourceId,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.retailCustomerProfileId],
      foreignColumns: [
        customerProfiles.tenantId,
        customerProfiles.legalEntityId,
        customerProfiles.customerProfileId,
      ],
      name: 'ccc_retail_profiles_parent_fk',
    }).onDelete('restrict'),
    trimmed('ccc_retail_profiles_party_ref_ck', table.partyResourceId),
    optionalTrimmed('ccc_retail_profiles_party_revision_ck', table.partyResourceRevision),
    check(
      'ccc_retail_profiles_attribution_ck',
      sql`${table.attributionKind} in ('AUTHENTICATED', 'GUEST_ACCEPTANCE', 'RECONCILED')`,
    ),
    ...scopedPolicies('ccc_retail_profiles_scope', table),
  ],
);

export const counterpartyPurchasingProfiles = commerceCustomerContextSchema.table.withRLS(
  'counterparty_purchasing_profiles',
  {
    counterpartyPurchasingProfileId: uuid('counterparty_purchasing_profile_id').primaryKey(),
    ...scopeColumns(),
    counterpartyResourceId: text('counterparty_resource_id').notNull(),
    counterpartyResourceRevision: text('counterparty_resource_revision'),
    customerRoleResourceId: text('customer_role_resource_id'),
    customerRoleResourceRevision: text('customer_role_resource_revision'),
    createdAt: createdAt(),
  },
  (table) => [
    scopeIdentity(
      'ccc_counterparty_profiles_scope_id_uk',
      table,
      table.counterpartyPurchasingProfileId,
    ),
    unique('ccc_counterparty_profiles_tenant_id_uk').on(
      table.tenantId,
      table.counterpartyPurchasingProfileId,
    ),
    unique('ccc_counterparty_profiles_business_key_uk').on(
      table.tenantId,
      table.counterpartyResourceId,
    ),
    foreignKey({
      columns: [table.tenantId, table.counterpartyPurchasingProfileId],
      foreignColumns: [customerProfiles.tenantId, customerProfiles.customerProfileId],
      name: 'ccc_counterparty_profiles_parent_fk',
    }).onDelete('restrict'),
    trimmed('ccc_counterparty_profiles_counterparty_ref_ck', table.counterpartyResourceId),
    optionalTrimmed(
      'ccc_counterparty_profiles_counterparty_revision_ck',
      table.counterpartyResourceRevision,
    ),
    optionalTrimmed('ccc_counterparty_profiles_role_ref_ck', table.customerRoleResourceId),
    optionalTrimmed(
      'ccc_counterparty_profiles_role_revision_ck',
      table.customerRoleResourceRevision,
    ),
    ...scopedPolicies('ccc_counterparty_profiles_scope', table),
  ],
);

export const customerProfileLifecycleHistory = commerceCustomerContextSchema.table.withRLS(
  'customer_profile_lifecycle_history',
  {
    lifecycleHistoryId: uuid('lifecycle_history_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    customerProfileId: uuid('customer_profile_id').notNull(),
    revision: integer('revision').notNull(),
    fromLifecycle: text('from_lifecycle'),
    toLifecycle: text('to_lifecycle').notNull(),
    ...operationAttribution(),
  },
  (table) => [
    scopeIdentity('ccc_profile_history_scope_id_uk', table, table.lifecycleHistoryId),
    unique('ccc_profile_history_revision_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.customerProfileId,
      table.revision,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.customerProfileId],
      foreignColumns: [
        customerProfiles.tenantId,
        customerProfiles.legalEntityId,
        customerProfiles.customerProfileId,
      ],
      name: 'ccc_profile_history_profile_fk',
    }).onDelete('restrict'),
    positiveRevision('ccc_profile_history_revision_ck', table.revision),
    check(
      'ccc_profile_history_from_state_ck',
      sql`${table.fromLifecycle} is null or ${table.fromLifecycle} in ('ACTIVE', 'SUSPENDED', 'ARCHIVED')`,
    ),
    check(
      'ccc_profile_history_to_state_ck',
      sql`${table.toLifecycle} in ('ACTIVE', 'SUSPENDED', 'ARCHIVED')`,
    ),
    optionalTrimmed('ccc_profile_history_reason_ck', table.reason),
    ...scopedPolicies('ccc_profile_history_scope', table),
  ],
);

export const retailPortalProfileBindings = commerceCustomerContextSchema.table.withRLS(
  'retail_portal_profile_bindings',
  {
    retailPortalProfileBindingId: uuid('retail_portal_profile_binding_id')
      .defaultRandom()
      .primaryKey(),
    ...scopeColumns(),
    retailCustomerProfileId: uuid('retail_customer_profile_id').notNull(),
    principalId: uuid('principal_id').notNull(),
    authBindingId: uuid('auth_binding_id').notNull(),
    enrollmentEvidenceRef: text('enrollment_evidence_ref').notNull(),
    lifecycle: text('lifecycle').default('ACTIVE').notNull(),
    authorizationOperation: text('authorization_operation').default('grant').notNull(),
    authorizationState: text('authorization_state').default('ACTIVE').notNull(),
    revision: integer('revision').default(1).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ...operationAttribution(),
  },
  (table) => [
    scopeIdentity('ccc_portal_bindings_scope_id_uk', table, table.retailPortalProfileBindingId),
    uniqueIndex('ccc_portal_bindings_current_profile_principal_uk')
      .on(table.tenantId, table.legalEntityId, table.retailCustomerProfileId, table.principalId)
      .where(sql`${table.lifecycle} = 'ACTIVE'`),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.retailCustomerProfileId],
      foreignColumns: [
        retailCustomerProfiles.tenantId,
        retailCustomerProfiles.legalEntityId,
        retailCustomerProfiles.retailCustomerProfileId,
      ],
      name: 'ccc_portal_bindings_profile_fk',
    }).onDelete('restrict'),
    check(
      'ccc_portal_bindings_lifecycle_ck',
      sql`${table.lifecycle} in ('ACTIVE', 'REVOKED') and ((${table.lifecycle} = 'ACTIVE' and ${table.revokedAt} is null) or (${table.lifecycle} = 'REVOKED' and ${table.revokedAt} is not null))`,
    ),
    check(
      'ccc_portal_bindings_authorization_operation_ck',
      sql`${table.authorizationOperation} in ('grant', 'revoke')`,
    ),
    check(
      'ccc_portal_bindings_authorization_state_ck',
      sql`${table.authorizationState} in ('ACTIVE', 'REVOKED', 'PENDING_GRANT', 'PENDING_REVOKE', 'RECONCILIATION_REQUIRED')`,
    ),
    positiveRevision('ccc_portal_bindings_revision_ck', table.revision),
    trimmed('ccc_portal_bindings_enrollment_evidence_ck', table.enrollmentEvidenceRef),
    optionalTrimmed('ccc_portal_bindings_reason_ck', table.reason),
    ...scopedPolicies('ccc_portal_bindings_scope', table),
  ],
);

/** One immutable, idempotent authorization intent per binding Permission transition. */
export const retailPortalProfileBindingPermissionMutations =
  commerceCustomerContextSchema.table.withRLS(
    'retail_portal_profile_binding_permission_mutations',
    {
      retailPortalProfileBindingPermissionMutationId: uuid(
        'retail_portal_profile_binding_permission_mutation_id',
      )
        .defaultRandom()
        .primaryKey(),
      ...scopeColumns(),
      retailPortalProfileBindingId: uuid('retail_portal_profile_binding_id').notNull(),
      retailCustomerProfileId: uuid('retail_customer_profile_id').notNull(),
      principalId: uuid('principal_id').notNull(),
      permissionCode: text('permission_code').notNull(),
      operation: text('operation').notNull(),
      state: text('state').notNull(),
      revision: integer('revision').default(1).notNull(),
      finalizedAt: timestamp('finalized_at', { withTimezone: true }),
      ...operationAttribution(),
    },
    (table) => [
      scopeIdentity(
        'ccc_portal_binding_permission_mutations_scope_id_uk',
        table,
        table.retailPortalProfileBindingPermissionMutationId,
      ),
      unique('ccc_portal_binding_permission_mutations_idempotency_uk').on(
        table.tenantId,
        table.legalEntityId,
        table.retailPortalProfileBindingId,
        table.actionInvocationId,
        table.operation,
        table.permissionCode,
      ),
      foreignKey({
        columns: [table.tenantId, table.legalEntityId, table.retailPortalProfileBindingId],
        foreignColumns: [
          retailPortalProfileBindings.tenantId,
          retailPortalProfileBindings.legalEntityId,
          retailPortalProfileBindings.retailPortalProfileBindingId,
        ],
        name: 'ccc_portal_binding_permission_mutations_binding_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [table.tenantId, table.legalEntityId, table.retailCustomerProfileId],
        foreignColumns: [
          retailCustomerProfiles.tenantId,
          retailCustomerProfiles.legalEntityId,
          retailCustomerProfiles.retailCustomerProfileId,
        ],
        name: 'ccc_portal_binding_permission_mutations_profile_fk',
      }).onDelete('restrict'),
      check(
        'ccc_portal_binding_permission_mutations_operation_ck',
        sql`${table.operation} in ('grant', 'revoke')`,
      ),
      check(
        'ccc_portal_binding_permission_mutations_state_ck',
        sql`${table.state} in ('PENDING_GRANT', 'PENDING_REVOKE', 'ACTIVE', 'REVOKED', 'RECONCILIATION_REQUIRED') and ((${table.operation} = 'grant' and ${table.state} in ('PENDING_GRANT', 'ACTIVE', 'RECONCILIATION_REQUIRED')) or (${table.operation} = 'revoke' and ${table.state} in ('PENDING_REVOKE', 'REVOKED', 'RECONCILIATION_REQUIRED')))`,
      ),
      positiveRevision('ccc_portal_binding_permission_mutations_revision_ck', table.revision),
      check(
        'ccc_portal_binding_permission_mutations_finalized_ck',
        sql`(${table.state} in ('ACTIVE', 'REVOKED') and ${table.finalizedAt} is not null) or (${table.state} not in ('ACTIVE', 'REVOKED') and ${table.finalizedAt} is null)`,
      ),
      trimmed('ccc_portal_binding_permission_mutations_permission_ck', table.permissionCode),
      optionalTrimmed('ccc_portal_binding_permission_mutations_reason_ck', table.reason),
      ...scopedPolicies('ccc_portal_binding_permission_mutations_scope', table),
    ],
  );

/** Immutable evidence for every enrollment, revocation, and recovery transition. */
export const retailPortalProfileBindingHistory = commerceCustomerContextSchema.table.withRLS(
  'retail_portal_profile_binding_history',
  {
    retailPortalProfileBindingHistoryId: uuid('retail_portal_profile_binding_history_id')
      .defaultRandom()
      .primaryKey(),
    ...scopeColumns(),
    retailPortalProfileBindingId: uuid('retail_portal_profile_binding_id').notNull(),
    revision: integer('revision').notNull(),
    fromLifecycle: text('from_lifecycle'),
    toLifecycle: text('to_lifecycle').notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    enrollmentEvidenceRef: text('enrollment_evidence_ref').notNull(),
    ...operationAttribution(),
  },
  (table) => [
    scopeIdentity(
      'ccc_portal_binding_history_scope_id_uk',
      table,
      table.retailPortalProfileBindingHistoryId,
    ),
    unique('ccc_portal_binding_history_revision_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.retailPortalProfileBindingId,
      table.revision,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.retailPortalProfileBindingId],
      foreignColumns: [
        retailPortalProfileBindings.tenantId,
        retailPortalProfileBindings.legalEntityId,
        retailPortalProfileBindings.retailPortalProfileBindingId,
      ],
      name: 'ccc_portal_binding_history_binding_fk',
    }).onDelete('restrict'),
    positiveRevision('ccc_portal_binding_history_revision_ck', table.revision),
    check(
      'ccc_portal_binding_history_from_ck',
      sql`${table.fromLifecycle} is null or ${table.fromLifecycle} in ('ACTIVE', 'REVOKED')`,
    ),
    check('ccc_portal_binding_history_to_ck', sql`${table.toLifecycle} in ('ACTIVE', 'REVOKED')`),
    trimmed('ccc_portal_binding_history_evidence_ck', table.enrollmentEvidenceRef),
    optionalTrimmed('ccc_portal_binding_history_reason_ck', table.reason),
    ...scopedPolicies('ccc_portal_binding_history_scope', table),
  ],
);

export const profileReconciliationCases = commerceCustomerContextSchema.table.withRLS(
  'profile_reconciliation_cases',
  {
    profileReconciliationCaseId: uuid('profile_reconciliation_case_id')
      .defaultRandom()
      .primaryKey(),
    ...scopeColumns(),
    profileKind: text('profile_kind').notNull(),
    sourceProfileId: uuid('source_profile_id').notNull(),
    collidingProfileId: uuid('colliding_profile_id').notNull(),
    canonicalPartyResourceId: text('canonical_party_resource_id').notNull(),
    mergeResourceId: text('merge_resource_id').notNull(),
    sourceCorrelationRef: text('source_correlation_ref').notNull(),
    trigger: text('trigger').notNull(),
    targetSubject: jsonb('target_subject').$type<Readonly<Record<string, unknown>>>().notNull(),
    canonicalizationEvidence: jsonb('canonicalization_evidence')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    ownerOutcomes: jsonb('owner_outcomes')
      .$type<readonly Readonly<Record<string, unknown>>[]>()
      .default([])
      .notNull(),
    lastProcessedEventVersion: bigint('last_processed_event_version', { mode: 'bigint' })
      .default(0n)
      .notNull(),
    lifecycle: text('lifecycle').default('OPEN').notNull(),
    resolutionKind: text('resolution_kind'),
    canonicalProfileId: uuid('canonical_profile_id'),
    resultingState: text('resulting_state'),
    revision: integer('revision').default(1).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    actionInvocationId: uuid('action_invocation_id'),
    sourceDomainEventId: uuid('source_domain_event_id'),
    sourceMessageId: uuid('source_message_id'),
    actorPrincipalId: uuid('actor_principal_id').notNull(),
    reason: text('reason'),
    recordedAt: recordedAt(),
  },
  (table) => [
    scopeIdentity('ccc_reconciliation_scope_id_uk', table, table.profileReconciliationCaseId),
    uniqueIndex('ccc_reconciliation_open_pair_uk')
      .on(
        table.tenantId,
        table.legalEntityId,
        table.sourceProfileId,
        table.collidingProfileId,
        table.mergeResourceId,
      )
      .where(sql`${table.lifecycle} in ('OPEN', 'BLOCKED', 'READY_TO_COMPLETE')`),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.sourceProfileId],
      foreignColumns: [
        customerProfiles.tenantId,
        customerProfiles.legalEntityId,
        customerProfiles.customerProfileId,
      ],
      name: 'ccc_reconciliation_source_profile_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.collidingProfileId],
      foreignColumns: [
        customerProfiles.tenantId,
        customerProfiles.legalEntityId,
        customerProfiles.customerProfileId,
      ],
      name: 'ccc_reconciliation_collision_profile_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.canonicalProfileId],
      foreignColumns: [
        customerProfiles.tenantId,
        customerProfiles.legalEntityId,
        customerProfiles.customerProfileId,
      ],
      name: 'ccc_reconciliation_canonical_profile_fk',
    }).onDelete('restrict'),
    check(
      'ccc_reconciliation_distinct_profiles_ck',
      sql`${table.sourceProfileId} <> ${table.collidingProfileId}`,
    ),
    check('ccc_reconciliation_kind_ck', sql`${table.profileKind} in ('RETAIL', 'COUNTERPARTY')`),
    check(
      'ccc_reconciliation_lifecycle_ck',
      sql`${table.lifecycle} in ('OPEN', 'BLOCKED', 'READY_TO_COMPLETE', 'COMPLETED')`,
    ),
    check(
      'ccc_reconciliation_resolution_ck',
      sql`(${table.lifecycle} in ('OPEN', 'BLOCKED', 'READY_TO_COMPLETE') and ${table.resolutionKind} is null and ${table.canonicalProfileId} is null and ${table.resultingState} is null and ${table.resolvedAt} is null) or (${table.lifecycle} = 'COMPLETED' and ${table.resolutionKind} = 'SELECT_CANONICAL' and ${table.canonicalProfileId} is not null and ${table.resultingState} in ('ACTIVE', 'SUSPENDED', 'ARCHIVED') and ${table.resolvedAt} is not null)`,
    ),
    trimmed('ccc_reconciliation_party_ref_ck', table.canonicalPartyResourceId),
    trimmed('ccc_reconciliation_merge_ref_ck', table.mergeResourceId),
    trimmed('ccc_reconciliation_correlation_ck', table.sourceCorrelationRef),
    check(
      'ccc_reconciliation_trigger_ck',
      sql`${table.trigger} in ('PARTY_ALIAS', 'COUNTERPARTY_ALIAS', 'CREATE_COLLISION', 'IMPORT_CORRELATION')`,
    ),
    check(
      'ccc_reconciliation_target_subject_ck',
      sql`jsonb_typeof(${table.targetSubject}) = 'object'`,
    ),
    check(
      'ccc_reconciliation_canonicalization_evidence_ck',
      sql`jsonb_typeof(${table.canonicalizationEvidence}) = 'object'`,
    ),
    check(
      'ccc_reconciliation_owner_outcomes_ck',
      sql`jsonb_typeof(${table.ownerOutcomes}) = 'array'`,
    ),
    check('ccc_reconciliation_event_version_ck', sql`${table.lastProcessedEventVersion} >= 0`),
    check(
      'ccc_reconciliation_causation_ck',
      sql`(${table.actionInvocationId} is not null and ${table.sourceDomainEventId} is null and ${table.sourceMessageId} is null) or (${table.actionInvocationId} is null and ${table.sourceDomainEventId} is not null and ${table.sourceMessageId} is not null)`,
    ),
    positiveRevision('ccc_reconciliation_revision_ck', table.revision),
    optionalTrimmed('ccc_reconciliation_reason_ck', table.reason),
    ...scopedPolicies('ccc_reconciliation_scope', table),
  ],
);

/** Ordered membership preserves every conflicting profile; source/collision columns on the case
 * remain the compatibility pair used by the initial schema. */
export const profileReconciliationCaseMembers = commerceCustomerContextSchema.table.withRLS(
  'profile_reconciliation_case_members',
  {
    profileReconciliationCaseMemberId: uuid('profile_reconciliation_case_member_id')
      .defaultRandom()
      .primaryKey(),
    ...scopeColumns(),
    profileReconciliationCaseId: uuid('profile_reconciliation_case_id').notNull(),
    customerProfileId: uuid('customer_profile_id').notNull(),
    memberPosition: integer('member_position').notNull(),
    observedLifecycle: text('observed_lifecycle').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    scopeIdentity(
      'ccc_reconciliation_members_scope_id_uk',
      table,
      table.profileReconciliationCaseMemberId,
    ),
    unique('ccc_reconciliation_members_profile_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.profileReconciliationCaseId,
      table.customerProfileId,
    ),
    unique('ccc_reconciliation_members_position_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.profileReconciliationCaseId,
      table.memberPosition,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.profileReconciliationCaseId],
      foreignColumns: [
        profileReconciliationCases.tenantId,
        profileReconciliationCases.legalEntityId,
        profileReconciliationCases.profileReconciliationCaseId,
      ],
      name: 'ccc_reconciliation_members_case_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.customerProfileId],
      foreignColumns: [
        customerProfiles.tenantId,
        customerProfiles.legalEntityId,
        customerProfiles.customerProfileId,
      ],
      name: 'ccc_reconciliation_members_profile_fk',
    }).onDelete('restrict'),
    check('ccc_reconciliation_members_position_ck', sql`${table.memberPosition} >= 0`),
    check(
      'ccc_reconciliation_members_lifecycle_ck',
      sql`${table.observedLifecycle} in ('ACTIVE', 'SUSPENDED', 'ARCHIVED')`,
    ),
    ...scopedPolicies('ccc_reconciliation_members_scope', table),
  ],
);

/** Append-only, owner-derived proof that the exact Address Book state is safe to reconcile. */
export const addressBookReconciliationReceipts = commerceCustomerContextSchema.table.withRLS(
  'address_book_reconciliation_receipts',
  {
    addressBookReconciliationReceiptId: uuid('address_book_reconciliation_receipt_id')
      .defaultRandom()
      .primaryKey(),
    ...scopeColumns(),
    profileReconciliationCaseId: uuid('profile_reconciliation_case_id').notNull(),
    survivorProfileId: uuid('survivor_profile_id').notNull(),
    disposition: text('disposition').notNull(),
    terminalStatus: text('terminal_status').notNull(),
    memberProfileIds: uuid('member_profile_ids').array().notNull(),
    caseRevisionAtReceipt: integer('case_revision_at_receipt').notNull(),
    eventVersion: bigint('event_version', { mode: 'bigint' }).notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    policyVersion: text('policy_version').notNull(),
    resultingState: text('resulting_state').notNull(),
    beforeFactsSha256: text('before_facts_sha256').notNull(),
    afterFactsSha256: text('after_facts_sha256').notNull(),
    postconditionSha256: text('postcondition_sha256').notNull(),
    ownerDecisionRef: text('owner_decision_ref'),
    evidenceRef: text('evidence_ref').notNull(),
    correlationRef: text('correlation_ref').notNull(),
    ...operationAttribution(),
  },
  (table) => [
    scopeIdentity(
      'ccc_address_reconciliation_receipts_scope_id_uk',
      table,
      table.addressBookReconciliationReceiptId,
    ),
    unique('ccc_address_reconciliation_receipts_action_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.profileReconciliationCaseId,
      table.actionInvocationId,
    ),
    unique('ccc_address_reconciliation_receipts_evidence_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.evidenceRef,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.profileReconciliationCaseId],
      foreignColumns: [
        profileReconciliationCases.tenantId,
        profileReconciliationCases.legalEntityId,
        profileReconciliationCases.profileReconciliationCaseId,
      ],
      name: 'ccc_address_reconciliation_receipts_case_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.survivorProfileId],
      foreignColumns: [
        customerProfiles.tenantId,
        customerProfiles.legalEntityId,
        customerProfiles.customerProfileId,
      ],
      name: 'ccc_address_reconciliation_receipts_survivor_fk',
    }).onDelete('restrict'),
    check(
      'ccc_address_reconciliation_receipts_disposition_ck',
      sql`${table.disposition} in ('EXPLICIT_RECONCILIATION', 'ALREADY_SATISFIED', 'NOT_APPLICABLE')`,
    ),
    check(
      'ccc_address_reconciliation_receipts_status_ck',
      sql`(${table.disposition} = 'NOT_APPLICABLE' and ${table.terminalStatus} = 'NOT_APPLICABLE') or (${table.disposition} <> 'NOT_APPLICABLE' and ${table.terminalStatus} = 'RESOLVED')`,
    ),
    check(
      'ccc_address_reconciliation_receipts_members_ck',
      sql`cardinality(${table.memberProfileIds}) >= 2 and array_position(${table.memberProfileIds}, null) is null and ${table.survivorProfileId} = any(${table.memberProfileIds})`,
    ),
    positiveRevision(
      'ccc_address_reconciliation_receipts_revision_ck',
      table.caseRevisionAtReceipt,
    ),
    check('ccc_address_reconciliation_receipts_event_ck', sql`${table.eventVersion} >= 0`),
    check(
      'ccc_address_reconciliation_receipts_hashes_ck',
      sql`${table.beforeFactsSha256} ~ '^[0-9a-f]{64}$' and ${table.afterFactsSha256} ~ '^[0-9a-f]{64}$' and ${table.postconditionSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ccc_address_reconciliation_receipts_decision_ck',
      sql`(${table.disposition} = 'EXPLICIT_RECONCILIATION' and length(btrim(${table.ownerDecisionRef})) > 0) or (${table.disposition} <> 'EXPLICIT_RECONCILIATION' and ${table.ownerDecisionRef} is null)`,
    ),
    check(
      'ccc_address_reconciliation_receipts_state_ck',
      sql`${table.resultingState} in ('ACTIVE', 'SUSPENDED', 'ARCHIVED')`,
    ),
    trimmed('ccc_address_reconciliation_receipts_policy_ck', table.policyVersion),
    trimmed('ccc_address_reconciliation_receipts_evidence_ck', table.evidenceRef),
    trimmed('ccc_address_reconciliation_receipts_correlation_ck', table.correlationRef),
    optionalTrimmed('ccc_address_reconciliation_receipts_reason_ck', table.reason),
    ...scopedPolicies('ccc_address_reconciliation_receipts_scope', table),
  ],
);

/** Current navigation alias only. Historical facts retain the original profile ResourceRef. */
export const customerProfileAliases = commerceCustomerContextSchema.table.withRLS(
  'customer_profile_aliases',
  {
    customerProfileAliasId: uuid('customer_profile_alias_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    aliasProfileId: uuid('alias_profile_id').notNull(),
    canonicalProfileId: uuid('canonical_profile_id').notNull(),
    profileReconciliationCaseId: uuid('profile_reconciliation_case_id').notNull(),
    ...operationAttribution(),
  },
  (table) => [
    scopeIdentity('ccc_profile_aliases_scope_id_uk', table, table.customerProfileAliasId),
    unique('ccc_profile_aliases_alias_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.aliasProfileId,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.aliasProfileId],
      foreignColumns: [
        customerProfiles.tenantId,
        customerProfiles.legalEntityId,
        customerProfiles.customerProfileId,
      ],
      name: 'ccc_profile_aliases_alias_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.canonicalProfileId],
      foreignColumns: [
        customerProfiles.tenantId,
        customerProfiles.legalEntityId,
        customerProfiles.customerProfileId,
      ],
      name: 'ccc_profile_aliases_canonical_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.profileReconciliationCaseId],
      foreignColumns: [
        profileReconciliationCases.tenantId,
        profileReconciliationCases.legalEntityId,
        profileReconciliationCases.profileReconciliationCaseId,
      ],
      name: 'ccc_profile_aliases_case_fk',
    }).onDelete('restrict'),
    check(
      'ccc_profile_aliases_distinct_ck',
      sql`${table.aliasProfileId} <> ${table.canonicalProfileId}`,
    ),
    trimmed('ccc_profile_aliases_reason_ck', table.reason),
    ...scopedPolicies('ccc_profile_aliases_scope', table),
  ],
);

/** Append-only evidence supplied by one trusted reconciliation owner. */
export const profileReconciliationOwnerOutcomes = commerceCustomerContextSchema.table.withRLS(
  'profile_reconciliation_owner_outcomes',
  {
    profileReconciliationOwnerOutcomeId: uuid('profile_reconciliation_owner_outcome_id')
      .defaultRandom()
      .primaryKey(),
    ...scopeColumns(),
    profileReconciliationCaseId: uuid('profile_reconciliation_case_id').notNull(),
    survivorProfileId: uuid('survivor_profile_id').notNull(),
    resultingState: text('resulting_state').notNull(),
    owner: text('owner').notNull(),
    status: text('status').notNull(),
    evidenceRef: text('evidence_ref'),
    caseRevision: integer('case_revision').notNull(),
    eventVersion: bigint('event_version', { mode: 'bigint' }).notNull(),
    correlationRef: text('correlation_ref').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    ...operationAttribution(),
  },
  (table) => [
    scopeIdentity(
      'ccc_reconciliation_owner_outcomes_scope_id_uk',
      table,
      table.profileReconciliationOwnerOutcomeId,
    ),
    unique('ccc_reconciliation_owner_outcomes_revision_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.profileReconciliationCaseId,
      table.owner,
      table.caseRevision,
    ),
    unique('ccc_reconciliation_owner_outcomes_correlation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.profileReconciliationCaseId,
      table.owner,
      table.correlationRef,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.profileReconciliationCaseId],
      foreignColumns: [
        profileReconciliationCases.tenantId,
        profileReconciliationCases.legalEntityId,
        profileReconciliationCases.profileReconciliationCaseId,
      ],
      name: 'ccc_reconciliation_owner_outcomes_case_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.survivorProfileId],
      foreignColumns: [
        customerProfiles.tenantId,
        customerProfiles.legalEntityId,
        customerProfiles.customerProfileId,
      ],
      name: 'ccc_reconciliation_owner_outcomes_survivor_fk',
    }).onDelete('restrict'),
    check(
      'ccc_reconciliation_owner_outcomes_owner_ck',
      sql`${table.owner} in ('PROFILE_LIFECYCLE', 'CUSTOMER_GROUP_MEMBERSHIP', 'PRICE_GROUP_ASSIGNMENT', 'PAYMENT_TERMS', 'ADDRESS_BOOK', 'RETAIL_PORTAL_BINDING', 'COUNTERPARTY_ACCESS', 'PURCHASE_LIMITS', 'APPROVAL', 'CONNECTOR_CORRELATION')`,
    ),
    check(
      'ccc_reconciliation_owner_outcomes_status_ck',
      sql`${table.status} in ('BLOCKED', 'RESOLVED', 'NOT_APPLICABLE')`,
    ),
    check(
      'ccc_reconciliation_owner_outcomes_resulting_state_ck',
      sql`${table.resultingState} in ('ACTIVE', 'SUSPENDED', 'ARCHIVED')`,
    ),
    check(
      'ccc_reconciliation_owner_outcomes_evidence_ck',
      sql`(${table.status} = 'BLOCKED' and (${table.evidenceRef} is null or length(btrim(${table.evidenceRef})) > 0)) or (${table.status} in ('RESOLVED', 'NOT_APPLICABLE') and length(btrim(${table.evidenceRef})) > 0)`,
    ),
    positiveRevision('ccc_reconciliation_owner_outcomes_revision_ck', table.caseRevision),
    check('ccc_reconciliation_owner_outcomes_event_ck', sql`${table.eventVersion} >= 0`),
    trimmed('ccc_reconciliation_owner_outcomes_correlation_ck', table.correlationRef),
    optionalTrimmed('ccc_reconciliation_owner_outcomes_reason_ck', table.reason),
    ...scopedPolicies('ccc_reconciliation_owner_outcomes_scope', table),
  ],
);

/** Append-only, scoped delivery/currentness evidence for Party merge profile reconciliation. */
export const partyMergeProfileObservations = commerceCustomerContextSchema.table.withRLS(
  'party_merge_profile_observations',
  {
    partyMergeProfileObservationId: uuid('party_merge_profile_observation_id')
      .defaultRandom()
      .primaryKey(),
    ...scopeColumns(),
    mergeResourceId: text('merge_resource_id').notNull(),
    sourceDomainEventId: uuid('source_domain_event_id').notNull(),
    sourceMessageId: uuid('source_message_id').notNull(),
    eventVersion: bigint('event_version', { mode: 'bigint' }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    policyVersion: text('policy_version').notNull(),
    survivorPartyResourceId: text('survivor_party_resource_id').notNull(),
    absorbedPartyResourceIds: text('absorbed_party_resource_ids').array().notNull(),
    outcome: text('outcome').notNull(),
    canonicalizedProfileId: uuid('canonicalized_profile_id'),
    actorPrincipalId: uuid('actor_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    scopeIdentity(
      'ccc_party_merge_observations_scope_id_uk',
      table,
      table.partyMergeProfileObservationId,
    ),
    unique('ccc_party_merge_observations_version_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.mergeResourceId,
      table.eventVersion,
    ),
    unique('ccc_party_merge_observations_event_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.sourceDomainEventId,
    ),
    unique('ccc_party_merge_observations_message_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.sourceMessageId,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.canonicalizedProfileId],
      foreignColumns: [
        retailCustomerProfiles.tenantId,
        retailCustomerProfiles.legalEntityId,
        retailCustomerProfiles.retailCustomerProfileId,
      ],
      name: 'ccc_party_merge_observations_profile_fk',
    }).onDelete('restrict'),
    positiveRevision('ccc_party_merge_observations_version_ck', table.eventVersion),
    trimmed('ccc_party_merge_observations_merge_ck', table.mergeResourceId),
    trimmed('ccc_party_merge_observations_policy_ck', table.policyVersion),
    trimmed('ccc_party_merge_observations_survivor_ck', table.survivorPartyResourceId),
    check(
      'ccc_party_merge_observations_absorbed_ck',
      sql`cardinality(${table.absorbedPartyResourceIds}) > 0 and array_position(${table.absorbedPartyResourceIds}, null) is null`,
    ),
    check(
      'ccc_party_merge_observations_outcome_ck',
      sql`${table.outcome} in ('NO_CONFLICTING_PROFILES', 'RECONCILIATIONS_OBSERVED', 'COMPLETED_NO_CHANGE')`,
    ),
    ...scopedPolicies('ccc_party_merge_observations_scope', table),
  ],
);

/** Purpose-minimized durable result of one Guest purchase attribution correlation. */
export const guestRetailAttributions = commerceCustomerContextSchema.table.withRLS(
  'guest_retail_attributions',
  {
    guestRetailAttributionId: uuid('guest_retail_attribution_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    correlationRoot: text('correlation_root').notNull(),
    guestEvidenceRef: text('guest_evidence_ref').notNull(),
    outcome: text('outcome').notNull(),
    partyResourceId: text('party_resource_id'),
    retailCustomerProfileId: uuid('retail_customer_profile_id'),
    reconciliationRef: text('reconciliation_ref'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    ...operationAttribution(),
  },
  (table) => [
    scopeIdentity('ccc_guest_attributions_scope_id_uk', table, table.guestRetailAttributionId),
    unique('ccc_guest_attributions_correlation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.correlationRoot,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.retailCustomerProfileId],
      foreignColumns: [
        retailCustomerProfiles.tenantId,
        retailCustomerProfiles.legalEntityId,
        retailCustomerProfiles.retailCustomerProfileId,
      ],
      name: 'ccc_guest_attributions_profile_fk',
    }).onDelete('restrict'),
    trimmed('ccc_guest_attributions_correlation_ck', table.correlationRoot),
    trimmed('ccc_guest_attributions_evidence_ck', table.guestEvidenceRef),
    optionalTrimmed('ccc_guest_attributions_party_ck', table.partyResourceId),
    optionalTrimmed('ccc_guest_attributions_reconciliation_ck', table.reconciliationRef),
    check(
      'ccc_guest_attributions_outcome_ck',
      sql`${table.outcome} in ('ATTRIBUTED', 'PARTY_UNRESOLVED', 'PARTY_AMBIGUOUS', 'PARTY_INVALID', 'PROFILE_NOT_ACTIVE')`,
    ),
    check(
      'ccc_guest_attributions_result_ck',
      sql`(${table.outcome} = 'ATTRIBUTED' and ${table.partyResourceId} is not null and ${table.retailCustomerProfileId} is not null and ${table.reconciliationRef} is null) or (${table.outcome} = 'PARTY_AMBIGUOUS' and ${table.partyResourceId} is null and ${table.retailCustomerProfileId} is null and ${table.reconciliationRef} is not null) or (${table.outcome} in ('PARTY_UNRESOLVED', 'PARTY_INVALID', 'PROFILE_NOT_ACTIVE') and ${table.partyResourceId} is null and ${table.retailCustomerProfileId} is null and ${table.reconciliationRef} is null)`,
    ),
    ...scopedPolicies('ccc_guest_attributions_scope', table),
  ],
);

export const customerGroups = commerceCustomerContextSchema.table.withRLS(
  'customer_groups',
  {
    customerGroupId: uuid('customer_group_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    stableCode: text('stable_code').notNull(),
    meaningKey: text('meaning_key').notNull(),
    lifecycle: text('lifecycle').default('ACTIVE').notNull(),
    currentRevision: integer('current_revision').default(1).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    scopeIdentity('ccc_groups_scope_id_uk', table, table.customerGroupId),
    unique('ccc_groups_code_uk').on(table.tenantId, table.legalEntityId, table.stableCode),
    trimmed('ccc_groups_code_ck', table.stableCode),
    check('ccc_groups_code_format_ck', sql`${table.stableCode} ~ '^[A-Z][A-Z0-9_]{1,63}$'`),
    check(
      'ccc_groups_meaning_key_ck',
      sql`${table.meaningKey} ~ '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$'`,
    ),
    check(
      'ccc_groups_lifecycle_ck',
      sql`${table.lifecycle} in ('ACTIVE', 'ARCHIVED') and ((${table.lifecycle} = 'ACTIVE' and ${table.archivedAt} is null) or (${table.lifecycle} = 'ARCHIVED' and ${table.archivedAt} is not null))`,
    ),
    positiveRevision('ccc_groups_revision_ck', table.currentRevision),
    ...scopedPolicies('ccc_groups_scope', table),
  ],
);

export const customerGroupRevisions = commerceCustomerContextSchema.table.withRLS(
  'customer_group_revisions',
  {
    customerGroupRevisionId: uuid('customer_group_revision_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    changeKind: text('change_kind').notNull(),
    customerGroupId: uuid('customer_group_id').notNull(),
    description: text('description').notNull(),
    displayName: text('display_name').notNull(),
    membershipCriteria: text('membership_criteria').notNull(),
    purpose: text('purpose').notNull(),
    revision: integer('revision').notNull(),
    semanticFingerprint: text('semantic_fingerprint').notNull(),
    ...operationAttribution(),
  },
  (table) => [
    scopeIdentity('ccc_group_revisions_scope_id_uk', table, table.customerGroupRevisionId),
    unique('ccc_group_revisions_group_revision_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.customerGroupId,
      table.revision,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.customerGroupId],
      foreignColumns: [
        customerGroups.tenantId,
        customerGroups.legalEntityId,
        customerGroups.customerGroupId,
      ],
      name: 'ccc_group_revisions_group_fk',
    }).onDelete('restrict'),
    positiveRevision('ccc_group_revisions_revision_ck', table.revision),
    trimmed('ccc_group_revisions_name_ck', table.displayName),
    trimmed('ccc_group_revisions_description_ck', table.description),
    trimmed('ccc_group_revisions_purpose_ck', table.purpose),
    trimmed('ccc_group_revisions_criteria_ck', table.membershipCriteria),
    check(
      'ccc_group_revisions_change_kind_ck',
      sql`${table.changeKind} in ('CREATED', 'COSMETIC_RENAME', 'TYPO_CORRECTION', 'DESCRIPTION_CLARIFICATION')`,
    ),
    check(
      'ccc_group_revisions_fingerprint_ck',
      sql`${table.semanticFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    optionalTrimmed('ccc_group_revisions_reason_ck', table.reason),
    ...scopedPolicies('ccc_group_revisions_scope', table),
  ],
);

export const customerGroupLifecyclePeriods = commerceCustomerContextSchema.table.withRLS(
  'customer_group_lifecycle_periods',
  {
    customerGroupLifecyclePeriodId: uuid('customer_group_lifecycle_period_id')
      .defaultRandom()
      .primaryKey(),
    ...scopeColumns(),
    customerGroupId: uuid('customer_group_id').notNull(),
    activeFrom: timestamp('active_from', { withTimezone: true }).notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    revision: integer('revision').notNull(),
    ...operationAttribution(),
  },
  (table) => [
    scopeIdentity('ccc_group_lifecycle_scope_id_uk', table, table.customerGroupLifecyclePeriodId),
    unique('ccc_group_lifecycle_revision_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.customerGroupId,
      table.revision,
    ),
    uniqueIndex('ccc_group_lifecycle_open_uk')
      .on(table.tenantId, table.legalEntityId, table.customerGroupId)
      .where(sql`${table.archivedAt} is null`),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.customerGroupId],
      foreignColumns: [
        customerGroups.tenantId,
        customerGroups.legalEntityId,
        customerGroups.customerGroupId,
      ],
      name: 'ccc_group_lifecycle_group_fk',
    }).onDelete('restrict'),
    check(
      'ccc_group_lifecycle_period_ck',
      sql`${table.archivedAt} is null or ${table.archivedAt} > ${table.activeFrom}`,
    ),
    positiveRevision('ccc_group_lifecycle_revision_ck', table.revision),
    trimmed('ccc_group_lifecycle_reason_ck', table.reason),
    ...scopedPolicies('ccc_group_lifecycle_scope', table),
  ],
);

export const customerGroupMemberships = commerceCustomerContextSchema.table.withRLS(
  'customer_group_memberships',
  {
    customerGroupMembershipId: uuid('customer_group_membership_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    customerProfileId: uuid('customer_profile_id').notNull(),
    customerGroupId: uuid('customer_group_id').notNull(),
    effectiveFrom: effectiveFrom(),
    effectiveTo: effectiveTo(),
    lifecycle: text('lifecycle').default('ACTIVE').notNull(),
    revision: integer('revision').default(1).notNull(),
    ...operationAttribution(),
  },
  (table) => [
    scopeIdentity('ccc_memberships_scope_id_uk', table, table.customerGroupMembershipId),
    index('ccc_memberships_effective_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.customerProfileId,
      table.effectiveFrom,
      table.effectiveTo,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.customerProfileId],
      foreignColumns: [
        customerProfiles.tenantId,
        customerProfiles.legalEntityId,
        customerProfiles.customerProfileId,
      ],
      name: 'ccc_memberships_profile_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.customerGroupId],
      foreignColumns: [
        customerGroups.tenantId,
        customerGroups.legalEntityId,
        customerGroups.customerGroupId,
      ],
      name: 'ccc_memberships_group_fk',
    }).onDelete('restrict'),
    halfOpenPeriod('ccc_memberships_period_ck', table),
    check(
      'ccc_memberships_lifecycle_ck',
      sql`${table.lifecycle} in ('ACTIVE', 'ENDED', 'CANCELLED') and (${table.lifecycle} <> 'ENDED' or ${table.effectiveTo} is not null)`,
    ),
    positiveRevision('ccc_memberships_revision_ck', table.revision),
    optionalTrimmed('ccc_memberships_reason_ck', table.reason),
    ...scopedPolicies('ccc_memberships_scope', table),
  ],
);

export const customerPriceGroupAssignments = commerceCustomerContextSchema.table.withRLS(
  'customer_price_group_assignments',
  {
    customerPriceGroupAssignmentId: uuid('customer_price_group_assignment_id')
      .defaultRandom()
      .primaryKey(),
    ...scopeColumns(),
    customerProfileId: uuid('customer_profile_id').notNull(),
    priceGroupModuleId: text('price_group_module_id').notNull(),
    priceGroupResourceType: text('price_group_resource_type').notNull(),
    priceGroupResourceId: text('price_group_resource_id').notNull(),
    catalogRevision: integer('catalog_revision').notNull(),
    compatibilityContractId: text('compatibility_contract_id').notNull(),
    compatibilityContractRevision: integer('compatibility_contract_revision').notNull(),
    definitionRevision: integer('definition_revision').notNull(),
    effectiveFrom: effectiveFrom(),
    effectiveTo: effectiveTo(),
    lifecycle: text('lifecycle').default('ACTIVE').notNull(),
    revision: integer('revision').default(1).notNull(),
    ...operationAttribution(),
  },
  (table) => [
    scopeIdentity('ccc_price_assignments_scope_id_uk', table, table.customerPriceGroupAssignmentId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.customerProfileId],
      foreignColumns: [
        customerProfiles.tenantId,
        customerProfiles.legalEntityId,
        customerProfiles.customerProfileId,
      ],
      name: 'ccc_price_assignments_profile_fk',
    }).onDelete('restrict'),
    trimmed('ccc_price_assignments_group_ref_ck', table.priceGroupResourceId),
    trimmed('ccc_price_assignments_module_ref_ck', table.priceGroupModuleId),
    trimmed('ccc_price_assignments_type_ref_ck', table.priceGroupResourceType),
    trimmed('ccc_price_assignments_compatibility_ck', table.compatibilityContractId),
    positiveRevision('ccc_price_assignments_catalog_revision_ck', table.catalogRevision),
    positiveRevision(
      'ccc_price_assignments_contract_revision_ck',
      table.compatibilityContractRevision,
    ),
    positiveRevision('ccc_price_assignments_definition_revision_ck', table.definitionRevision),
    halfOpenPeriod('ccc_price_assignments_period_ck', table),
    check(
      'ccc_price_assignments_lifecycle_ck',
      sql`${table.lifecycle} in ('ACTIVE', 'ENDED', 'CANCELLED') and (${table.lifecycle} <> 'ENDED' or ${table.effectiveTo} is not null)`,
    ),
    positiveRevision('ccc_price_assignments_revision_ck', table.revision),
    optionalTrimmed('ccc_price_assignments_reason_ck', table.reason),
    ...scopedPolicies('ccc_price_assignments_scope', table),
  ],
);

export const customerPaymentTermPreferences = commerceCustomerContextSchema.table.withRLS(
  'customer_payment_term_preferences',
  {
    customerPaymentTermPreferenceId: uuid('customer_payment_term_preference_id')
      .defaultRandom()
      .primaryKey(),
    ...scopeColumns(),
    customerProfileId: uuid('customer_profile_id').notNull(),
    paymentTermResourceId: text('payment_term_resource_id').notNull(),
    effectiveFrom: effectiveFrom(),
    effectiveTo: effectiveTo(),
    lifecycle: text('lifecycle').default('ACTIVE').notNull(),
    revision: integer('revision').notNull(),
    ...operationAttribution(),
  },
  (table) => [
    scopeIdentity(
      'ccc_payment_preferences_scope_id_uk',
      table,
      table.customerPaymentTermPreferenceId,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.customerProfileId],
      foreignColumns: [
        customerProfiles.tenantId,
        customerProfiles.legalEntityId,
        customerProfiles.customerProfileId,
      ],
      name: 'ccc_payment_preferences_profile_fk',
    }).onDelete('restrict'),
    trimmed('ccc_payment_preferences_term_ref_ck', table.paymentTermResourceId),
    halfOpenPeriod('ccc_payment_preferences_period_ck', table),
    check(
      'ccc_payment_preferences_lifecycle_ck',
      sql`${table.lifecycle} in ('ACTIVE', 'ENDED', 'CANCELLED') and (${table.lifecycle} <> 'ENDED' or ${table.effectiveTo} is not null)`,
    ),
    positiveRevision('ccc_payment_preferences_revision_ck', table.revision),
    optionalTrimmed('ccc_payment_preferences_reason_ck', table.reason),
    ...scopedPolicies('ccc_payment_preferences_scope', table),
  ],
);

export const customerPaymentTermEntitlements = commerceCustomerContextSchema.table.withRLS(
  'customer_payment_term_entitlements',
  {
    customerPaymentTermEntitlementId: uuid('customer_payment_term_entitlement_id')
      .defaultRandom()
      .primaryKey(),
    ...scopeColumns(),
    customerProfileId: uuid('customer_profile_id').notNull(),
    paymentTermResourceId: text('payment_term_resource_id').notNull(),
    paymentTermSemanticRevision: text('payment_term_semantic_revision').notNull(),
    effectiveFrom: effectiveFrom(),
    effectiveTo: effectiveTo(),
    lifecycle: text('lifecycle').default('ACTIVE').notNull(),
    revision: integer('revision').notNull(),
    ...operationAttribution(),
  },
  (table) => [
    scopeIdentity(
      'ccc_payment_entitlements_scope_id_uk',
      table,
      table.customerPaymentTermEntitlementId,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.customerProfileId],
      foreignColumns: [
        customerProfiles.tenantId,
        customerProfiles.legalEntityId,
        customerProfiles.customerProfileId,
      ],
      name: 'ccc_payment_entitlements_profile_fk',
    }).onDelete('restrict'),
    trimmed('ccc_payment_entitlements_term_ref_ck', table.paymentTermResourceId),
    trimmed('ccc_payment_entitlements_semantic_revision_ck', table.paymentTermSemanticRevision),
    halfOpenPeriod('ccc_payment_entitlements_period_ck', table),
    check(
      'ccc_payment_entitlements_lifecycle_ck',
      sql`${table.lifecycle} in ('ACTIVE', 'ENDED', 'CANCELLED') and (${table.lifecycle} <> 'ENDED' or ${table.effectiveTo} is not null)`,
    ),
    positiveRevision('ccc_payment_entitlements_revision_ck', table.revision),
    optionalTrimmed('ccc_payment_entitlements_reason_ck', table.reason),
    ...scopedPolicies('ccc_payment_entitlements_scope', table),
  ],
);

/** Durable Customer-owned barrier used while Payment retires a canonical term and its aliases. */
export const paymentTermRetirementReservations = commerceCustomerContextSchema.table.withRLS(
  'payment_term_retirement_reservations',
  {
    paymentTermRetirementReservationId: uuid('payment_term_retirement_reservation_id')
      .defaultRandom()
      .primaryKey(),
    ...scopeColumns(),
    paymentTermResourceIds: text('payment_term_resource_ids').array().notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    lifecycle: text('lifecycle').default('RESERVED').notNull(),
    ...operationAttribution(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    scopeIdentity(
      'ccc_payment_term_retirement_reservations_scope_id_uk',
      table,
      table.paymentTermRetirementReservationId,
    ),
    unique('ccc_payment_term_retirement_reservations_action_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.actionInvocationId,
    ),
    check(
      'ccc_payment_term_retirement_reservations_ids_ck',
      sql`cardinality(${table.paymentTermResourceIds}) between 1 and 200 and array_position(${table.paymentTermResourceIds}, null) is null`,
    ),
    check(
      'ccc_payment_term_retirement_reservations_lifecycle_ck',
      sql`${table.lifecycle} in ('RESERVED', 'COMMITTED', 'RELEASED')`,
    ),
    optionalTrimmed('ccc_payment_term_retirement_reservations_reason_ck', table.reason),
    ...scopedPolicies('ccc_payment_term_retirement_reservations_scope', table),
  ],
);

export const savedAddresses = commerceCustomerContextSchema.table.withRLS(
  'saved_addresses',
  {
    savedAddressId: uuid('saved_address_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    customerProfileId: uuid('customer_profile_id').notNull(),
    sourceKind: text('source_kind').notNull(),
    label: text('label'),
    purposes: jsonb('purposes').$type<readonly ('BILLING' | 'DELIVERY')[]>().notNull(),
    partyResourceId: text('party_resource_id'),
    partyContactPointResourceId: text('party_contact_point_resource_id'),
    partyContactPointRevision: integer('party_contact_point_revision'),
    recipientName: text('recipient_name'),
    organizationName: text('organization_name'),
    addressLine1: text('address_line_1'),
    addressLine2: text('address_line_2'),
    locality: text('locality'),
    administrativeArea: text('administrative_area'),
    postalCode: text('postal_code'),
    countryCode: text('country_code'),
    phoneNumber: text('phone_number'),
    lifecycle: text('lifecycle').default('ACTIVE').notNull(),
    revision: integer('revision').default(1).notNull(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastActionInvocationId: uuid('last_action_invocation_id').notNull(),
    lastActorPrincipalId: uuid('last_actor_principal_id').notNull(),
    lastReason: text('last_reason'),
  },
  (table) => [
    scopeIdentity('ccc_saved_addresses_scope_id_uk', table, table.savedAddressId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.customerProfileId],
      foreignColumns: [
        customerProfiles.tenantId,
        customerProfiles.legalEntityId,
        customerProfiles.customerProfileId,
      ],
      name: 'ccc_saved_addresses_profile_fk',
    }).onDelete('restrict'),
    check(
      'ccc_saved_addresses_source_kind_ck',
      sql`${table.sourceKind} in ('PARTY_BACKED', 'COMMERCE_ONLY')`,
    ),
    check(
      'ccc_saved_addresses_source_shape_ck',
      sql`(${table.sourceKind} = 'PARTY_BACKED' and ${table.partyResourceId} is not null and ${table.partyContactPointResourceId} is not null and ${table.partyContactPointRevision} > 0 and ${table.addressLine1} is null and ${table.locality} is null and ${table.postalCode} is null and ${table.countryCode} is null) or (${table.sourceKind} = 'COMMERCE_ONLY' and ${table.partyResourceId} is null and ${table.partyContactPointResourceId} is null and ${table.partyContactPointRevision} is null and ${table.addressLine1} is not null and ${table.locality} is not null and ${table.postalCode} is not null and ${table.countryCode} is not null)`,
    ),
    check(
      'ccc_saved_addresses_purposes_ck',
      sql`jsonb_typeof(${table.purposes}) = 'array' and jsonb_array_length(${table.purposes}) between 1 and 2 and ${table.purposes} <@ '["BILLING", "DELIVERY"]'::jsonb`,
    ),
    check(
      'ccc_saved_addresses_country_ck',
      sql`${table.countryCode} is null or ${table.countryCode} ~ '^[A-Z]{2}$'`,
    ),
    check(
      'ccc_saved_addresses_lifecycle_ck',
      sql`${table.lifecycle} in ('ACTIVE', 'REMOVED') and ((${table.lifecycle} = 'ACTIVE' and ${table.removedAt} is null) or (${table.lifecycle} = 'REMOVED' and ${table.removedAt} is not null))`,
    ),
    positiveRevision('ccc_saved_addresses_revision_ck', table.revision),
    optionalTrimmed('ccc_saved_addresses_label_ck', table.label),
    optionalTrimmed('ccc_saved_addresses_party_owner_ref_ck', table.partyResourceId),
    optionalTrimmed('ccc_saved_addresses_party_ref_ck', table.partyContactPointResourceId),
    optionalTrimmed('ccc_saved_addresses_recipient_ck', table.recipientName),
    optionalTrimmed('ccc_saved_addresses_organization_ck', table.organizationName),
    optionalTrimmed('ccc_saved_addresses_line1_ck', table.addressLine1),
    optionalTrimmed('ccc_saved_addresses_line2_ck', table.addressLine2),
    optionalTrimmed('ccc_saved_addresses_locality_ck', table.locality),
    optionalTrimmed('ccc_saved_addresses_area_ck', table.administrativeArea),
    optionalTrimmed('ccc_saved_addresses_postal_ck', table.postalCode),
    optionalTrimmed('ccc_saved_addresses_phone_ck', table.phoneNumber),
    optionalTrimmed('ccc_saved_addresses_reason_ck', table.lastReason),
    ...scopedPolicies('ccc_saved_addresses_scope', table),
  ],
);

export const customerAddressDefaults = commerceCustomerContextSchema.table.withRLS(
  'customer_address_defaults',
  {
    customerAddressDefaultId: uuid('customer_address_default_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    customerProfileId: uuid('customer_profile_id').notNull(),
    defaultKind: text('default_kind').notNull(),
    savedAddressId: uuid('saved_address_id').notNull(),
    effectiveFrom: effectiveFrom(),
    effectiveTo: effectiveTo(),
    lifecycle: text('lifecycle').default('ACTIVE').notNull(),
    revision: integer('revision').notNull(),
    ...operationAttribution(),
  },
  (table) => [
    scopeIdentity('ccc_address_defaults_scope_id_uk', table, table.customerAddressDefaultId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.customerProfileId],
      foreignColumns: [
        customerProfiles.tenantId,
        customerProfiles.legalEntityId,
        customerProfiles.customerProfileId,
      ],
      name: 'ccc_address_defaults_profile_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.savedAddressId],
      foreignColumns: [
        savedAddresses.tenantId,
        savedAddresses.legalEntityId,
        savedAddresses.savedAddressId,
      ],
      name: 'ccc_address_defaults_address_fk',
    }).onDelete('restrict'),
    check('ccc_address_defaults_kind_ck', sql`${table.defaultKind} in ('BILLING', 'DELIVERY')`),
    halfOpenPeriod('ccc_address_defaults_period_ck', table),
    check(
      'ccc_address_defaults_lifecycle_ck',
      sql`${table.lifecycle} in ('ACTIVE', 'ENDED') and (${table.lifecycle} <> 'ENDED' or ${table.effectiveTo} is not null)`,
    ),
    positiveRevision('ccc_address_defaults_revision_ck', table.revision),
    optionalTrimmed('ccc_address_defaults_reason_ck', table.reason),
    ...scopedPolicies('ccc_address_defaults_scope', table),
  ],
);

export const counterpartyCommerceAccessGrants = commerceCustomerContextSchema.table.withRLS(
  'counterparty_commerce_access_grants',
  {
    counterpartyCommerceAccessGrantId: uuid('counterparty_commerce_access_grant_id')
      .defaultRandom()
      .primaryKey(),
    ...scopeColumns(),
    counterpartyPurchasingProfileId: uuid('counterparty_purchasing_profile_id').notNull(),
    principalId: uuid('principal_id').notNull(),
    permissionCode: text('permission_code').notNull(),
    storefrontResourceId: text('storefront_resource_id'),
    lifecycle: text('lifecycle').default('ACTIVE').notNull(),
    revision: integer('revision').default(1).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...operationAttribution(),
  },
  (table) => [
    scopeIdentity('ccc_access_grants_scope_id_uk', table, table.counterpartyCommerceAccessGrantId),
    uniqueIndex('ccc_access_grants_current_uk')
      .on(
        table.tenantId,
        table.legalEntityId,
        table.counterpartyPurchasingProfileId,
        table.principalId,
        table.permissionCode,
        sql`coalesce(${table.storefrontResourceId}, '')`,
      )
      .where(
        sql`${table.lifecycle} in ('PENDING_GRANT', 'ACTIVE', 'PENDING_REVOKE', 'RECONCILIATION_REQUIRED')`,
      ),
    foreignKey({
      columns: [table.tenantId, table.counterpartyPurchasingProfileId],
      foreignColumns: [
        counterpartyPurchasingProfiles.tenantId,
        counterpartyPurchasingProfiles.counterpartyPurchasingProfileId,
      ],
      name: 'ccc_access_grants_profile_fk',
    }).onDelete('restrict'),
    trimmed('ccc_access_grants_permission_ck', table.permissionCode),
    optionalTrimmed('ccc_access_grants_storefront_ck', table.storefrontResourceId),
    check(
      'ccc_access_grants_lifecycle_ck',
      sql`${table.lifecycle} in ('PENDING_GRANT', 'ACTIVE', 'PENDING_REVOKE', 'REVOKED', 'RECONCILIATION_REQUIRED') and ((${table.lifecycle} = 'REVOKED' and ${table.revokedAt} is not null) or (${table.lifecycle} <> 'REVOKED' and ${table.revokedAt} is null))`,
    ),
    positiveRevision('ccc_access_grants_revision_ck', table.revision),
    optionalTrimmed('ccc_access_grants_reason_ck', table.reason),
    ...scopedPolicies('ccc_access_grants_scope', table),
  ],
);

export const counterpartyAccessInvitations = commerceCustomerContextSchema.table.withRLS(
  'counterparty_access_invitations',
  {
    counterpartyAccessInvitationId: uuid('counterparty_access_invitation_id')
      .defaultRandom()
      .primaryKey(),
    ...scopeColumns(),
    counterpartyPurchasingProfileId: uuid('counterparty_purchasing_profile_id').notNull(),
    deliveryMethod: text('delivery_method').notNull(),
    deliveryReference: text('delivery_reference').notNull(),
    claimProofReference: text('claim_proof_reference'),
    claimOriginPrincipalId: uuid('claim_origin_principal_id'),
    claimOriginActionInvocationId: uuid('claim_origin_action_invocation_id'),
    claimOriginProofReference: text('claim_origin_proof_reference'),
    requestedPermissionCodes: jsonb('requested_permission_codes')
      .$type<readonly string[]>()
      .notNull(),
    storefrontResourceId: text('storefront_resource_id'),
    lifecycle: text('lifecycle').default('PENDING').notNull(),
    revision: integer('revision').default(1).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    claimedByPrincipalId: uuid('claimed_by_principal_id'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...operationAttribution(),
  },
  (table) => [
    scopeIdentity(
      'ccc_access_invitations_scope_id_uk',
      table,
      table.counterpartyAccessInvitationId,
    ),
    uniqueIndex('ccc_access_invitations_pending_delivery_uk')
      .on(
        table.tenantId,
        table.legalEntityId,
        table.counterpartyPurchasingProfileId,
        table.deliveryReference,
      )
      .where(sql`${table.lifecycle} = 'PENDING'`),
    foreignKey({
      columns: [table.tenantId, table.counterpartyPurchasingProfileId],
      foreignColumns: [
        counterpartyPurchasingProfiles.tenantId,
        counterpartyPurchasingProfiles.counterpartyPurchasingProfileId,
      ],
      name: 'ccc_access_invitations_profile_fk',
    }).onDelete('restrict'),
    trimmed('ccc_access_invitations_delivery_ref_ck', table.deliveryReference),
    check(
      'ccc_access_invitations_delivery_method_ck',
      sql`${table.deliveryMethod} in ('VERIFIED_CONTACT_POINT', 'APPROVED_RECIPIENT_DISCOVERY')`,
    ),
    optionalTrimmed('ccc_access_invitations_claim_proof_ck', table.claimProofReference),
    optionalTrimmed(
      'ccc_access_invitations_claim_origin_proof_ck',
      table.claimOriginProofReference,
    ),
    check(
      'ccc_access_invitations_claim_origin_ck',
      sql`(${table.claimOriginPrincipalId} is null and ${table.claimOriginActionInvocationId} is null and ${table.claimOriginProofReference} is null) or (${table.claimOriginPrincipalId} is not null and ${table.claimOriginActionInvocationId} is not null and ${table.claimOriginProofReference} is not null)`,
    ),
    check(
      'ccc_access_invitations_permissions_ck',
      sql`jsonb_typeof(${table.requestedPermissionCodes}) = 'array' and jsonb_array_length(${table.requestedPermissionCodes}) between 1 and 64`,
    ),
    check(
      'ccc_access_invitations_lifecycle_ck',
      sql`${table.lifecycle} in ('PENDING', 'CLAIMING', 'CLAIMED', 'REVOKED', 'EXPIRED', 'RECONCILIATION_REQUIRED')`,
    ),
    check(
      'ccc_access_invitations_claim_ck',
      sql`(${table.lifecycle} = 'CLAIMED' and ${table.claimedByPrincipalId} is not null and ${table.claimedAt} is not null) or (${table.lifecycle} in ('CLAIMING', 'RECONCILIATION_REQUIRED') and ${table.claimedByPrincipalId} is not null and ${table.claimedAt} is null) or (${table.lifecycle} in ('PENDING', 'EXPIRED') and ${table.claimedByPrincipalId} is null and ${table.claimedAt} is null) or (${table.lifecycle} = 'REVOKED' and ${table.claimedAt} is null)`,
    ),
    check(
      'ccc_access_invitations_revocation_ck',
      sql`(${table.lifecycle} = 'REVOKED' and ${table.revokedAt} is not null) or (${table.lifecycle} <> 'REVOKED' and ${table.revokedAt} is null)`,
    ),
    positiveRevision('ccc_access_invitations_revision_ck', table.revision),
    optionalTrimmed('ccc_access_invitations_storefront_ck', table.storefrontResourceId),
    optionalTrimmed('ccc_access_invitations_reason_ck', table.reason),
    ...scopedPolicies('ccc_access_invitations_scope', table),
  ],
);

/** Secret-free invitation credential state. Raw proof material exists only at delivery/redeem. */
export const counterpartyInvitationClaimProofs = commerceCustomerContextSchema.table.withRLS(
  'counterparty_invitation_claim_proofs',
  {
    counterpartyInvitationClaimProofId: uuid('counterparty_invitation_claim_proof_id')
      .defaultRandom()
      .primaryKey(),
    ...scopeColumns(),
    invitationId: uuid('invitation_id').notNull(),
    counterpartyResourceId: text('counterparty_resource_id').notNull(),
    storefrontResourceId: text('storefront_resource_id'),
    proofReference: text('proof_reference').notNull(),
    secretDigest: text('secret_digest').notNull(),
    proofVersion: text('proof_version').default('commerce-invitation-proof.v1').notNull(),
    lifecycle: text('lifecycle').default('ISSUED').notNull(),
    deliveryState: text('delivery_state').default('PENDING').notNull(),
    deliveryMethod: text('delivery_method').notNull(),
    deliveryReference: text('delivery_reference').notNull(),
    deliveryAttemptCount: smallint('delivery_attempt_count').default(0).notNull(),
    intendedPermissionCodes: jsonb('intended_permission_codes')
      .$type<readonly string[]>()
      .notNull(),
    inviterPrincipalId: uuid('inviter_principal_id').notNull(),
    claimantPrincipalId: uuid('claimant_principal_id'),
    issueActionInvocationId: uuid('issue_action_invocation_id').notNull(),
    consumeActionInvocationId: uuid('consume_action_invocation_id'),
    attestationReference: text('attestation_reference'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    deliveryStagedAt: timestamp('delivery_staged_at', { withTimezone: true }),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    scopeIdentity(
      'ccc_invitation_claim_proofs_scope_id_uk',
      table,
      table.counterpartyInvitationClaimProofId,
    ),
    unique('ccc_invitation_claim_proofs_reference_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.proofReference,
    ),
    unique('ccc_invitation_claim_proofs_attestation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.attestationReference,
    ),
    unique('ccc_invitation_claim_proofs_issue_action_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.invitationId,
      table.issueActionInvocationId,
    ),
    uniqueIndex('ccc_invitation_claim_proofs_current_uk')
      .on(table.tenantId, table.legalEntityId, table.invitationId)
      .where(sql`${table.lifecycle} in ('ISSUED', 'VERIFIED')`),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.invitationId],
      foreignColumns: [
        counterpartyAccessInvitations.tenantId,
        counterpartyAccessInvitations.legalEntityId,
        counterpartyAccessInvitations.counterpartyAccessInvitationId,
      ],
      name: 'ccc_invitation_claim_proofs_invitation_fk',
    }).onDelete('restrict'),
    trimmed('ccc_invitation_claim_proofs_counterparty_ck', table.counterpartyResourceId),
    optionalTrimmed('ccc_invitation_claim_proofs_storefront_ck', table.storefrontResourceId),
    trimmed('ccc_invitation_claim_proofs_reference_ck', table.proofReference),
    check('ccc_invitation_claim_proofs_digest_ck', sql`${table.secretDigest} ~ '^[0-9a-f]{64}$'`),
    check(
      'ccc_invitation_claim_proofs_version_ck',
      sql`${table.proofVersion} = 'commerce-invitation-proof.v1'`,
    ),
    check(
      'ccc_invitation_claim_proofs_lifecycle_ck',
      sql`${table.lifecycle} in ('ISSUED', 'VERIFIED', 'CONSUMED', 'REVOKED', 'EXPIRED')`,
    ),
    check(
      'ccc_invitation_claim_proofs_delivery_ck',
      sql`${table.deliveryState} in ('PENDING', 'STAGED', 'FAILED') and ${table.deliveryAttemptCount} between 0 and 32767 and ((${table.deliveryState} = 'PENDING' and ${table.deliveryStagedAt} is null) or (${table.deliveryState} = 'STAGED' and ${table.deliveryStagedAt} is not null) or (${table.deliveryState} = 'FAILED' and ${table.deliveryStagedAt} is null))`,
    ),
    check(
      'ccc_invitation_claim_proofs_delivery_method_ck',
      sql`${table.deliveryMethod} in ('VERIFIED_CONTACT_POINT', 'APPROVED_RECIPIENT_DISCOVERY')`,
    ),
    trimmed('ccc_invitation_claim_proofs_delivery_ref_ck', table.deliveryReference),
    check(
      'ccc_invitation_claim_proofs_permissions_ck',
      sql`jsonb_typeof(${table.intendedPermissionCodes}) = 'array' and jsonb_array_length(${table.intendedPermissionCodes}) between 1 and 64`,
    ),
    check(
      'ccc_invitation_claim_proofs_claimant_ck',
      sql`(${table.lifecycle} = 'ISSUED' and ${table.claimantPrincipalId} is null and ${table.redeemedAt} is null) or (${table.lifecycle} in ('VERIFIED', 'CONSUMED') and ${table.claimantPrincipalId} is not null and ${table.redeemedAt} is not null) or (${table.lifecycle} in ('REVOKED', 'EXPIRED'))`,
    ),
    check(
      'ccc_invitation_claim_proofs_consumption_ck',
      sql`(${table.lifecycle} = 'CONSUMED' and ${table.consumeActionInvocationId} is not null and ${table.attestationReference} is not null and ${table.consumedAt} is not null and ${table.invalidatedAt} is null) or (${table.lifecycle} <> 'CONSUMED' and ${table.consumeActionInvocationId} is null and ${table.attestationReference} is null and ${table.consumedAt} is null)`,
    ),
    check(
      'ccc_invitation_claim_proofs_invalidation_ck',
      sql`(${table.lifecycle} in ('REVOKED', 'EXPIRED') and ${table.invalidatedAt} is not null) or (${table.lifecycle} not in ('REVOKED', 'EXPIRED') and ${table.invalidatedAt} is null)`,
    ),
    check('ccc_invitation_claim_proofs_expiry_ck', sql`${table.expiresAt} > ${table.createdAt}`),
    optionalTrimmed('ccc_invitation_claim_proofs_attestation_ck', table.attestationReference),
    ...scopedPolicies('ccc_invitation_claim_proofs_scope', table),
  ],
);

/** Durable claimant-specific throttling for both secret redemption and claim consumption. */
export const counterpartyInvitationClaimAttempts = commerceCustomerContextSchema.table.withRLS(
  'counterparty_invitation_claim_attempts',
  {
    counterpartyInvitationClaimAttemptId: uuid('counterparty_invitation_claim_attempt_id')
      .defaultRandom()
      .primaryKey(),
    ...scopeColumns(),
    invitationId: uuid('invitation_id').notNull(),
    claimantPrincipalId: uuid('claimant_principal_id').notNull(),
    attemptCount: smallint('attempt_count').default(0).notNull(),
    windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
    blockedUntil: timestamp('blocked_until', { withTimezone: true }),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }).notNull(),
    lastOutcome: text('last_outcome').notNull(),
  },
  (table) => [
    scopeIdentity(
      'ccc_invitation_claim_attempts_scope_id_uk',
      table,
      table.counterpartyInvitationClaimAttemptId,
    ),
    unique('ccc_invitation_claim_attempts_claimant_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.invitationId,
      table.claimantPrincipalId,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.invitationId],
      foreignColumns: [
        counterpartyAccessInvitations.tenantId,
        counterpartyAccessInvitations.legalEntityId,
        counterpartyAccessInvitations.counterpartyAccessInvitationId,
      ],
      name: 'ccc_invitation_claim_attempts_invitation_fk',
    }).onDelete('restrict'),
    check('ccc_invitation_claim_attempts_count_ck', sql`${table.attemptCount} between 0 and 32767`),
    check(
      'ccc_invitation_claim_attempts_window_ck',
      sql`${table.lastAttemptAt} >= ${table.windowStartedAt} and (${table.blockedUntil} is null or ${table.blockedUntil} >= ${table.lastAttemptAt})`,
    ),
    check(
      'ccc_invitation_claim_attempts_outcome_ck',
      sql`${table.lastOutcome} in ('INVALID', 'RATE_LIMITED', 'REDEEMED', 'CONSUMED')`,
    ),
    ...scopedPolicies('ccc_invitation_claim_attempts_scope', table),
  ],
);

export const accessMutationJournal = commerceCustomerContextSchema.table.withRLS(
  'access_mutation_journal',
  {
    accessMutationId: uuid('access_mutation_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    counterpartyPurchasingProfileId: uuid('counterparty_purchasing_profile_id').notNull(),
    subjectPrincipalId: uuid('subject_principal_id'),
    mutationKind: text('mutation_kind').notNull(),
    resourceId: uuid('resource_id').notNull(),
    revision: integer('revision').notNull(),
    safeFacts: jsonb('safe_facts').$type<Readonly<Record<string, unknown>>>().notNull(),
    ...operationAttribution(),
  },
  (table) => [
    scopeIdentity('ccc_access_journal_scope_id_uk', table, table.accessMutationId),
    unique('ccc_access_journal_action_uk').on(
      table.tenantId,
      table.actionInvocationId,
      table.mutationKind,
      table.resourceId,
    ),
    foreignKey({
      columns: [table.tenantId, table.counterpartyPurchasingProfileId],
      foreignColumns: [
        counterpartyPurchasingProfiles.tenantId,
        counterpartyPurchasingProfiles.counterpartyPurchasingProfileId,
      ],
      name: 'ccc_access_journal_profile_fk',
    }).onDelete('restrict'),
    check(
      'ccc_access_journal_kind_ck',
      sql`${table.mutationKind} in ('BOOTSTRAP_ADMIN', 'GRANT', 'REVOKE', 'INVITE', 'RESEND_INVITE', 'CLAIM_INVITE', 'CLAIM_REJECTED', 'CLAIM_EXPIRED', 'REVOKE_INVITE')`,
    ),
    check(
      'ccc_access_journal_facts_ck',
      sql`jsonb_typeof(${table.safeFacts}) = 'object' and octet_length(${table.safeFacts}::text) <= 8192`,
    ),
    positiveRevision('ccc_access_journal_revision_ck', table.revision),
    optionalTrimmed('ccc_access_journal_reason_ck', table.reason),
    ...scopedPolicies('ccc_access_journal_scope', table),
  ],
);

const purchaseLimitColumns = () => ({
  policyKind: text('policy_kind').notNull(),
  amount: numeric('amount', { precision: 38, scale: 9 }),
  currencyCode: text('currency_code'),
});

const purchaseLimitConstraint = (
  name: string,
  table: Readonly<Record<'amount' | 'currencyCode' | 'policyKind', AnyPgColumn>>,
) =>
  check(
    name,
    sql`(${table.policyKind} in ('UNLIMITED', 'CLEARED') and ${table.amount} is null and ${table.currencyCode} is null) or (${table.policyKind} = 'MONETARY_LIMIT' and ${table.amount} is not null and ${table.amount} >= 0 and ${table.currencyCode} ~ '^[A-Z]{3}$')`,
  );

export const counterpartyPurchaseLimitDefaults = commerceCustomerContextSchema.table.withRLS(
  'counterparty_purchase_limit_defaults',
  {
    counterpartyPurchaseLimitDefaultId: uuid('counterparty_purchase_limit_default_id')
      .defaultRandom()
      .primaryKey(),
    ...scopeColumns(),
    counterpartyPurchasingProfileId: uuid('counterparty_purchasing_profile_id').notNull(),
    ...purchaseLimitColumns(),
    revision: integer('revision').notNull(),
    isCurrent: boolean('is_current').default(true).notNull(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    ...operationAttribution(),
  },
  (table) => [
    scopeIdentity(
      'ccc_limit_defaults_scope_id_uk',
      table,
      table.counterpartyPurchaseLimitDefaultId,
    ),
    unique('ccc_limit_defaults_profile_revision_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.counterpartyPurchasingProfileId,
      table.revision,
    ),
    uniqueIndex('ccc_limit_defaults_current_uk')
      .on(table.tenantId, table.legalEntityId, table.counterpartyPurchasingProfileId)
      .where(sql`${table.isCurrent}`),
    foreignKey({
      columns: [table.tenantId, table.counterpartyPurchasingProfileId],
      foreignColumns: [
        counterpartyPurchasingProfiles.tenantId,
        counterpartyPurchasingProfiles.counterpartyPurchasingProfileId,
      ],
      name: 'ccc_limit_defaults_profile_fk',
    }).onDelete('restrict'),
    purchaseLimitConstraint('ccc_limit_defaults_value_ck', table),
    check(
      'ccc_limit_defaults_current_ck',
      sql`(${table.isCurrent} and ${table.supersededAt} is null) or (not ${table.isCurrent} and ${table.supersededAt} is not null)`,
    ),
    positiveRevision('ccc_limit_defaults_revision_ck', table.revision),
    optionalTrimmed('ccc_limit_defaults_reason_ck', table.reason),
    ...scopedPolicies('ccc_limit_defaults_scope', table),
  ],
);

export const principalPurchaseLimitOverrides = commerceCustomerContextSchema.table.withRLS(
  'principal_purchase_limit_overrides',
  {
    principalPurchaseLimitOverrideId: uuid('principal_purchase_limit_override_id')
      .defaultRandom()
      .primaryKey(),
    ...scopeColumns(),
    counterpartyPurchasingProfileId: uuid('counterparty_purchasing_profile_id').notNull(),
    principalId: uuid('principal_id').notNull(),
    ...purchaseLimitColumns(),
    revision: integer('revision').notNull(),
    isCurrent: boolean('is_current').default(true).notNull(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    ...operationAttribution(),
  },
  (table) => [
    scopeIdentity('ccc_limit_overrides_scope_id_uk', table, table.principalPurchaseLimitOverrideId),
    unique('ccc_limit_overrides_pair_revision_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.counterpartyPurchasingProfileId,
      table.principalId,
      table.revision,
    ),
    uniqueIndex('ccc_limit_overrides_current_uk')
      .on(
        table.tenantId,
        table.legalEntityId,
        table.counterpartyPurchasingProfileId,
        table.principalId,
      )
      .where(sql`${table.isCurrent}`),
    foreignKey({
      columns: [table.tenantId, table.counterpartyPurchasingProfileId],
      foreignColumns: [
        counterpartyPurchasingProfiles.tenantId,
        counterpartyPurchasingProfiles.counterpartyPurchasingProfileId,
      ],
      name: 'ccc_limit_overrides_profile_fk',
    }).onDelete('restrict'),
    purchaseLimitConstraint('ccc_limit_overrides_value_ck', table),
    check(
      'ccc_limit_overrides_current_ck',
      sql`(${table.isCurrent} and ${table.supersededAt} is null) or (not ${table.isCurrent} and ${table.supersededAt} is not null)`,
    ),
    positiveRevision('ccc_limit_overrides_revision_ck', table.revision),
    optionalTrimmed('ccc_limit_overrides_reason_ck', table.reason),
    ...scopedPolicies('ccc_limit_overrides_scope', table),
  ],
);

/** Immutable, hash-addressed Purchase Proposal Revision snapshots. */
export const purchaseProposalRevisions = commerceCustomerContextSchema.table.withRLS(
  'purchase_proposal_revisions',
  {
    purchaseProposalRevisionId: uuid('purchase_proposal_revision_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    proposalRevisionResourceId: text('proposal_revision_resource_id').notNull(),
    revision: integer('revision').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    proposalSequence: integer('proposal_sequence').notNull(),
    buyerPrincipalId: uuid('buyer_principal_id').notNull(),
    counterpartyResourceRef: text('counterparty_resource_ref').notNull(),
    profileResourceRef: text('profile_resource_ref').notNull(),
    storefrontId: text('storefront_id').notNull(),
    proposalSnapshot: jsonb('proposal_snapshot')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    sourceRevisionVector: jsonb('source_revision_vector')
      .$type<readonly Readonly<Record<string, unknown>>[]>()
      .notNull(),
    canonicalizationVersion: text('canonicalization_version').notNull(),
    canonicalHash: text('canonical_hash').notNull(),
    state: text('state').default('CURRENT').notNull(),
    approvalEvaluation: text('approval_evaluation').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...operationAttribution(),
  },
  (table) => [
    scopeIdentity('ccc_purchase_proposals_scope_id_uk', table, table.purchaseProposalRevisionId),
    unique('ccc_purchase_proposals_resource_revision_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.proposalRevisionResourceId,
      table.revision,
    ),
    unique('ccc_purchase_proposals_hash_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.proposalRevisionResourceId,
      table.canonicalHash,
    ),
    unique('ccc_purchase_proposals_idempotency_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.idempotencyKey,
    ),
    uniqueIndex('ccc_purchase_proposals_current_resource_uk')
      .on(table.tenantId, table.legalEntityId, table.proposalRevisionResourceId)
      .where(sql`${table.state} = 'CURRENT'`),
    uniqueIndex('ccc_purchase_proposals_current_cart_revision_uk')
      .on(
        table.tenantId,
        table.legalEntityId,
        sql`(${table.proposalSnapshot}->'sourceCart'->'cartRef'->>'moduleId')`,
        sql`(${table.proposalSnapshot}->'sourceCart'->'cartRef'->>'resourceType')`,
        sql`(${table.proposalSnapshot}->'sourceCart'->'cartRef'->>'resourceId')`,
        sql`(${table.proposalSnapshot}->'sourceCart'->'cartRef'->>'tenantId')`,
        sql`(${table.proposalSnapshot}->'sourceCart'->>'revision')`,
      )
      .where(sql`${table.state} = 'CURRENT'`),
    check(
      'ccc_purchase_proposals_revision_ck',
      sql`${table.revision} > 0 and ${table.proposalSequence} > 0`,
    ),
    check(
      'ccc_purchase_proposals_snapshot_ck',
      sql`jsonb_typeof(${table.proposalSnapshot}) = 'object' and jsonb_typeof(${table.sourceRevisionVector}) = 'array'`,
    ),
    check('ccc_purchase_proposals_hash_ck', sql`${table.canonicalHash} ~ '^[a-f0-9]{64}$'`),
    check(
      'ccc_purchase_proposals_state_ck',
      sql`${table.state} in ('CURRENT', 'SUPERSEDED', 'CONSUMED', 'CANCELLED')`,
    ),
    check(
      'ccc_purchase_proposals_approval_ck',
      sql`${table.approvalEvaluation} in ('APPROVAL_REQUIRED', 'WITHIN_LIMIT')`,
    ),
    trimmed('ccc_purchase_proposals_resource_ck', table.proposalRevisionResourceId),
    trimmed('ccc_purchase_proposals_counterparty_ref_ck', table.counterpartyResourceRef),
    trimmed('ccc_purchase_proposals_profile_ref_ck', table.profileResourceRef),
    trimmed('ccc_purchase_proposals_storefront_ck', table.storefrontId),
    trimmed('ccc_purchase_proposals_idempotency_ck', table.idempotencyKey),
    ...scopedPolicies('ccc_purchase_proposals_scope', table),
  ],
);

/** Versioned hierarchy policy snapshots. Rows are never updated after route capture. */
export const approvalHierarchies = commerceCustomerContextSchema.table.withRLS(
  'approval_hierarchies',
  {
    approvalHierarchyId: uuid('approval_hierarchy_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    hierarchyResourceId: text('hierarchy_resource_id').notNull(),
    revision: integer('revision').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    counterpartyResourceRef: text('counterparty_resource_ref').notNull(),
    storefrontId: text('storefront_id'),
    minimumAmount: numeric('minimum_amount', { precision: 38, scale: 9 }).notNull(),
    minimumCurrencyCode: text('minimum_currency_code').notNull(),
    maximumAmount: numeric('maximum_amount', { precision: 38, scale: 9 }),
    maximumCurrencyCode: text('maximum_currency_code'),
    hierarchySnapshot: jsonb('hierarchy_snapshot')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    selfApprovalPolicy: text('self_approval_policy').notNull(),
    effectiveFrom: effectiveFrom(),
    effectiveTo: effectiveTo(),
    ownerPrincipalId: uuid('owner_principal_id').notNull(),
    ...operationAttribution(),
  },
  (table) => [
    scopeIdentity('ccc_approval_hierarchies_scope_id_uk', table, table.approvalHierarchyId),
    unique('ccc_approval_hierarchies_resource_revision_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.hierarchyResourceId,
      table.revision,
    ),
    unique('ccc_approval_hierarchies_idempotency_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.idempotencyKey,
    ),
    check('ccc_approval_hierarchies_revision_ck', sql`${table.revision} > 0`),
    check(
      'ccc_approval_hierarchies_snapshot_ck',
      sql`jsonb_typeof(${table.hierarchySnapshot}) = 'object'`,
    ),
    check(
      'ccc_approval_hierarchies_self_policy_ck',
      sql`${table.selfApprovalPolicy} in ('DENY', 'ALLOW')`,
    ),
    check(
      'ccc_approval_hierarchies_currency_ck',
      sql`${table.minimumCurrencyCode} ~ '^[A-Z]{3}$' and (${table.maximumCurrencyCode} is null or ${table.maximumCurrencyCode} ~ '^[A-Z]{3}$')`,
    ),
    check(
      'ccc_approval_hierarchies_range_ck',
      sql`${table.maximumAmount} is null or (${table.maximumCurrencyCode} = ${table.minimumCurrencyCode} and ${table.maximumAmount} >= ${table.minimumAmount})`,
    ),
    halfOpenPeriod('ccc_approval_hierarchies_period_ck', table),
    trimmed('ccc_approval_hierarchies_resource_ck', table.hierarchyResourceId),
    trimmed('ccc_approval_hierarchies_counterparty_ref_ck', table.counterpartyResourceRef),
    trimmed('ccc_approval_hierarchies_idempotency_ck', table.idempotencyKey),
    optionalTrimmed('ccc_approval_hierarchies_storefront_ck', table.storefrontId),
    ...scopedPolicies('ccc_approval_hierarchies_scope', table),
  ],
);

/** Captured route and level evidence; reroutes append a new immutable route row. */
export const approvalRoutes = commerceCustomerContextSchema.table.withRLS(
  'approval_routes',
  {
    approvalRouteId: uuid('approval_route_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    routeResourceId: text('route_resource_id').notNull(),
    requestResourceId: text('request_resource_id').notNull(),
    proposalRevisionResourceId: text('proposal_revision_resource_id').notNull(),
    hierarchyResourceId: text('hierarchy_resource_id').notNull(),
    hierarchyRevision: integer('hierarchy_revision').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    routeSnapshot: jsonb('route_snapshot').$type<Readonly<Record<string, unknown>>>().notNull(),
    currentLevelOrder: integer('current_level_order').notNull(),
    status: text('status').default('PENDING').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    rerouteReason: text('reroute_reason'),
    ...operationAttribution(),
  },
  (table) => [
    scopeIdentity('ccc_approval_routes_scope_id_uk', table, table.approvalRouteId),
    unique('ccc_approval_routes_resource_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.routeResourceId,
    ),
    unique('ccc_approval_routes_idempotency_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.idempotencyKey,
    ),
    check('ccc_approval_routes_snapshot_ck', sql`jsonb_typeof(${table.routeSnapshot}) = 'object'`),
    check(
      'ccc_approval_routes_level_ck',
      sql`${table.hierarchyRevision} > 0 and ${table.currentLevelOrder} > 0`,
    ),
    check(
      'ccc_approval_routes_status_ck',
      sql`${table.status} in ('PENDING', 'APPROVED', 'REROUTE_REQUIRED', 'SUPERSEDED')`,
    ),
    trimmed('ccc_approval_routes_resource_ck', table.routeResourceId),
    trimmed('ccc_approval_routes_request_ck', table.requestResourceId),
    trimmed('ccc_approval_routes_proposal_ck', table.proposalRevisionResourceId),
    trimmed('ccc_approval_routes_hierarchy_ck', table.hierarchyResourceId),
    trimmed('ccc_approval_routes_idempotency_ck', table.idempotencyKey),
    optionalTrimmed('ccc_approval_routes_reason_ck', table.rerouteReason),
    ...scopedPolicies('ccc_approval_routes_scope', table),
  ],
);

/** Durable request aggregate with CAS revision and idempotency key. */
export const purchaseApprovalRequests = commerceCustomerContextSchema.table.withRLS(
  'purchase_approval_requests',
  {
    purchaseApprovalRequestId: uuid('purchase_approval_request_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    requestResourceId: text('request_resource_id').notNull(),
    proposalRevisionResourceId: text('proposal_revision_resource_id').notNull(),
    routeResourceId: text('route_resource_id').notNull(),
    requestRevision: integer('request_revision').default(1).notNull(),
    requestSnapshot: jsonb('request_snapshot').$type<Readonly<Record<string, unknown>>>().notNull(),
    status: text('status').default('PENDING').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    committedOrderRef: jsonb('committed_order_ref').$type<Readonly<Record<string, unknown>>>(),
    consumptionCommitmentId: text('consumption_commitment_id'),
    lastDecisionResourceId: text('last_decision_resource_id'),
    ...operationAttribution(),
  },
  (table) => [
    scopeIdentity('ccc_approval_requests_scope_id_uk', table, table.purchaseApprovalRequestId),
    unique('ccc_approval_requests_resource_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.requestResourceId,
    ),
    unique('ccc_approval_requests_idempotency_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.idempotencyKey,
    ),
    uniqueIndex('ccc_approval_requests_active_proposal_uk')
      .on(table.tenantId, table.legalEntityId, table.proposalRevisionResourceId)
      .where(sql`${table.status} in ('PENDING', 'APPROVED')`),
    check('ccc_approval_requests_revision_ck', sql`${table.requestRevision} > 0`),
    check(
      'ccc_approval_requests_snapshot_ck',
      sql`jsonb_typeof(${table.requestSnapshot}) = 'object'`,
    ),
    check(
      'ccc_approval_requests_status_ck',
      sql`${table.status} in ('PENDING', 'APPROVED', 'RETURNED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'SUPERSEDED', 'CONSUMED')`,
    ),
    check(
      'ccc_approval_requests_consumed_ck',
      sql`(${table.status} = 'CONSUMED' and ${table.consumedAt} is not null and ${table.committedOrderRef} is not null and ${table.consumptionCommitmentId} is not null) or (${table.status} <> 'CONSUMED' and ${table.consumedAt} is null and ${table.committedOrderRef} is null and ${table.consumptionCommitmentId} is null)`,
    ),
    trimmed('ccc_approval_requests_resource_ck', table.requestResourceId),
    trimmed('ccc_approval_requests_proposal_ck', table.proposalRevisionResourceId),
    trimmed('ccc_approval_requests_route_ck', table.routeResourceId),
    trimmed('ccc_approval_requests_idempotency_ck', table.idempotencyKey),
    ...scopedPolicies('ccc_approval_requests_scope', table),
  ],
);

/** Append-only decision evidence; request CAS is enforced by the owner routine. */
export const approvalDecisions = commerceCustomerContextSchema.table.withRLS(
  'approval_decisions',
  {
    approvalDecisionId: uuid('approval_decision_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    decisionResourceId: text('decision_resource_id').notNull(),
    requestResourceId: text('request_resource_id').notNull(),
    proposalRevisionResourceId: text('proposal_revision_resource_id').notNull(),
    decision: text('decision').notNull(),
    levelOrder: integer('level_order').notNull(),
    requestRevision: integer('request_revision').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    decisionSnapshot: jsonb('decision_snapshot')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    ...operationAttribution(),
  },
  (table) => [
    scopeIdentity('ccc_approval_decisions_scope_id_uk', table, table.approvalDecisionId),
    unique('ccc_approval_decisions_resource_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.decisionResourceId,
    ),
    unique('ccc_approval_decisions_idempotency_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.idempotencyKey,
    ),
    check(
      'ccc_approval_decisions_kind_ck',
      sql`${table.decision} in ('APPROVE', 'RETURN', 'REJECT')`,
    ),
    check(
      'ccc_approval_decisions_level_ck',
      sql`${table.levelOrder} > 0 and ${table.requestRevision} > 0`,
    ),
    check(
      'ccc_approval_decisions_snapshot_ck',
      sql`jsonb_typeof(${table.decisionSnapshot}) = 'object'`,
    ),
    optionalTrimmed('ccc_approval_decisions_reason_ck', table.reason),
    trimmed('ccc_approval_decisions_resource_ck', table.decisionResourceId),
    trimmed('ccc_approval_decisions_request_ck', table.requestResourceId),
    trimmed('ccc_approval_decisions_proposal_ck', table.proposalRevisionResourceId),
    trimmed('ccc_approval_decisions_idempotency_ck', table.idempotencyKey),
    ...scopedPolicies('ccc_approval_decisions_scope', table),
  ],
);

/** Durable, bounded owner confirmations handed to the order handoff gate. */
export const approvalRevalidations = commerceCustomerContextSchema.table.withRLS(
  'approval_revalidations',
  {
    approvalRevalidationId: uuid('approval_revalidation_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    revalidationResourceId: text('revalidation_resource_id').notNull(),
    requestResourceId: text('request_resource_id').notNull(),
    proposalRevisionResourceId: text('proposal_revision_resource_id').notNull(),
    status: text('status').notNull(),
    proposalHash: text('proposal_hash').notNull(),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
    evidence: jsonb('evidence').$type<Readonly<Record<string, unknown>>>().notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    ...operationAttribution(),
  },
  (table) => [
    scopeIdentity('ccc_approval_revalidations_scope_id_uk', table, table.approvalRevalidationId),
    unique('ccc_approval_revalidations_resource_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.revalidationResourceId,
    ),
    unique('ccc_approval_revalidations_idempotency_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.idempotencyKey,
    ),
    check(
      'ccc_approval_revalidations_status_ck',
      sql`${table.status} in ('APPROVAL_VALID', 'ALREADY_CONSUMED', 'INVALID')`,
    ),
    check('ccc_approval_revalidations_hash_ck', sql`${table.proposalHash} ~ '^[a-f0-9]{64}$'`),
    check(
      'ccc_approval_revalidations_evidence_ck',
      sql`jsonb_typeof(${table.evidence}) = 'object'`,
    ),
    check('ccc_approval_revalidations_period_ck', sql`${table.validUntil} > ${table.checkedAt}`),
    trimmed('ccc_approval_revalidations_resource_ck', table.revalidationResourceId),
    trimmed('ccc_approval_revalidations_request_ck', table.requestResourceId),
    trimmed('ccc_approval_revalidations_proposal_ck', table.proposalRevisionResourceId),
    trimmed('ccc_approval_revalidations_idempotency_ck', table.idempotencyKey),
    ...scopedPolicies('ccc_approval_revalidations_scope', table),
  ],
);

export const commerceCustomerContextDatabaseSchema = {
  accessMutationJournal,
  addressBookReconciliationReceipts,
  counterpartyAccessInvitations,
  counterpartyCommerceAccessGrants,
  counterpartyInvitationClaimAttempts,
  counterpartyInvitationClaimProofs,
  counterpartyPurchaseLimitDefaults,
  counterpartyPurchasingProfiles,
  customerAddressDefaults,
  customerGroupMemberships,
  customerGroupLifecyclePeriods,
  customerGroupRevisions,
  customerGroups,
  customerPaymentTermEntitlements,
  customerPaymentTermPreferences,
  paymentTermRetirementReservations,
  customerPriceGroupAssignments,
  customerProfileAliases,
  customerProfileLifecycleHistory,
  customerProfiles,
  customerSettingRevisions,
  guestRetailAttributions,
  partyMergeProfileObservations,
  principalPurchaseLimitOverrides,
  purchaseProposalRevisions,
  approvalHierarchies,
  approvalRoutes,
  purchaseApprovalRequests,
  approvalDecisions,
  approvalRevalidations,
  profileReconciliationCaseMembers,
  profileReconciliationCases,
  profileReconciliationOwnerOutcomes,
  retailCustomerProfiles,
  retailPortalProfileBindingPermissionMutations,
  retailPortalProfileBindingHistory,
  retailPortalProfileBindings,
  savedAddresses,
} as const;

export const COMMERCE_CUSTOMER_CONTEXT_TABLES = [
  accessMutationJournal,
  addressBookReconciliationReceipts,
  counterpartyAccessInvitations,
  counterpartyCommerceAccessGrants,
  counterpartyInvitationClaimAttempts,
  counterpartyInvitationClaimProofs,
  counterpartyPurchaseLimitDefaults,
  counterpartyPurchasingProfiles,
  customerAddressDefaults,
  customerGroupMemberships,
  customerGroupLifecyclePeriods,
  customerGroupRevisions,
  customerGroups,
  customerPaymentTermEntitlements,
  customerPaymentTermPreferences,
  paymentTermRetirementReservations,
  customerPriceGroupAssignments,
  customerProfileAliases,
  customerProfileLifecycleHistory,
  customerProfiles,
  customerSettingRevisions,
  guestRetailAttributions,
  partyMergeProfileObservations,
  principalPurchaseLimitOverrides,
  purchaseProposalRevisions,
  approvalHierarchies,
  approvalRoutes,
  purchaseApprovalRequests,
  approvalDecisions,
  approvalRevalidations,
  profileReconciliationCaseMembers,
  profileReconciliationCases,
  profileReconciliationOwnerOutcomes,
  retailCustomerProfiles,
  retailPortalProfileBindingPermissionMutations,
  retailPortalProfileBindingHistory,
  retailPortalProfileBindings,
  savedAddresses,
] as const;

/** Relational Queries v2 entry point for the owner-local database. */
export const commerceCustomerContextRelations = defineRelations(
  commerceCustomerContextDatabaseSchema,
);

export type CustomerProfileRecord = typeof customerProfiles.$inferSelect;
export type NewCustomerProfileRecord = typeof customerProfiles.$inferInsert;
export type CustomerGroupRecord = typeof customerGroups.$inferSelect;
export type CustomerGroupMembershipRecord = typeof customerGroupMemberships.$inferSelect;
export type CustomerPaymentTermEntitlementRecord =
  typeof customerPaymentTermEntitlements.$inferSelect;
export type SavedAddressRecord = typeof savedAddresses.$inferSelect;
export type CounterpartyCommerceAccessGrantRecord =
  typeof counterpartyCommerceAccessGrants.$inferSelect;
export type CounterpartyPurchaseLimitDefaultRecord =
  typeof counterpartyPurchaseLimitDefaults.$inferSelect;
export type PrincipalPurchaseLimitOverrideRecord =
  typeof principalPurchaseLimitOverrides.$inferSelect;
