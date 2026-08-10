/* eslint-disable sort-keys -- Typed columns follow the authoritative physical schema order. */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const CORE_SCHEMA_NAME = 'core';

export const CORE_TABLE_INVENTORY = [
  'tenants',
  'legal_entities',
  'principals',
  'principal_auth_bindings',
  'tenant_module_states',
  'action_invocations',
  'tenant_module_state_changes',
  'audit_events',
  'data_access_events',
  'domain_events',
  'outbox_messages',
  'outbox_deliveries',
  'outbox_attempts',
  'media_assets',
  'media_links',
  'evidence_references',
  'search_index_entries',
  'worker_checkpoints',
] as const;

export const ACTION_INVOCATION_STATUSES = [
  'received',
  'rejected',
  'running',
  'succeeded',
  'failed',
  'indeterminate',
  'replayed',
] as const;

export type ActionInvocationStatus = (typeof ACTION_INVOCATION_STATUSES)[number];

export const ACTION_AUTH_METHODS = [
  'session',
  'api_key',
  'system',
  'support_impersonation',
] as const;

export type ActionAuthMethod = (typeof ACTION_AUTH_METHODS)[number];

export const PRINCIPAL_KINDS = ['human', 'service', 'integration', 'agent', 'system'] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

export const PRINCIPAL_STATUSES = ['active', 'disabled', 'archived'] as const;
export type PrincipalStatus = (typeof PRINCIPAL_STATUSES)[number];

export const BINDING_SUBJECT_TYPES = ['user', 'api_key'] as const;
export type BindingSubjectType = (typeof BINDING_SUBJECT_TYPES)[number];

export const BINDING_STATUSES = ['active', 'disabled', 'revoked'] as const;
export type BindingStatus = (typeof BINDING_STATUSES)[number];

export const coreSchema = pgSchema(CORE_SCHEMA_NAME);
export const domainEventTenantSequence = coreSchema.sequence('domain_event_tenant_sequence_no_seq');

const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).defaultNow().notNull();
const occurredAt = () => timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull();

export const tenants = coreSchema.table(
  'tenants',
  {
    tenantId: uuid('tenant_id').defaultRandom().primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull(),
    defaultLocale: text('default_locale').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('core_tenants_slug_uk').on(table.slug),
    check('core_tenants_status_ck', sql`${table.status} in ('active', 'suspended', 'archived')`),
  ],
);

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.tenantId, { onDelete: 'restrict' });

export const legalEntities = coreSchema.table(
  'legal_entities',
  {
    legalEntityId: uuid('legal_entity_id').defaultRandom().primaryKey(),
    tenantId: tenantId(),
    legalName: text('legal_name').notNull(),
    registrationCountry: text('registration_country').notNull(),
    registrationNumber: text('registration_number').notNull(),
    vatId: text('vat_id'),
    status: text('status').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('core_legal_entities_tenant_id_uk').on(table.tenantId, table.legalEntityId),
    uniqueIndex('core_legal_entities_registration_uk').on(
      table.tenantId,
      table.registrationCountry,
      table.registrationNumber,
    ),
    index('core_legal_entities_tenant_idx').on(table.tenantId),
    check(
      'core_legal_entities_status_ck',
      sql`${table.status} in ('active', 'suspended', 'archived')`,
    ),
  ],
);

export const principals = coreSchema.table(
  'principals',
  {
    principalId: uuid('principal_id').defaultRandom().primaryKey(),
    tenantId: tenantId(),
    kind: text('kind').$type<PrincipalKind>().notNull(),
    displayName: text('display_name').notNull(),
    status: text('status').$type<PrincipalStatus>().notNull(),
    createdAt: createdAt(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('core_principals_tenant_id_uk').on(table.tenantId, table.principalId),
    index('core_principals_tenant_kind_idx').on(table.tenantId, table.kind),
    check(
      'core_principals_kind_ck',
      sql`${table.kind} in ('human', 'service', 'integration', 'agent', 'system')`,
    ),
    check('core_principals_status_ck', sql`${table.status} in ('active', 'disabled', 'archived')`),
  ],
);

const principalId = (columnName = 'principal_id') => uuid(columnName).notNull();

const optionalPrincipalId = (columnName = 'principal_id') => uuid(columnName);

export const principalAuthBindings = coreSchema.table(
  'principal_auth_bindings',
  {
    principalAuthBindingId: uuid('principal_auth_binding_id').defaultRandom().primaryKey(),
    tenantId: tenantId(),
    principalId: principalId(),
    provider: text('provider').notNull(),
    subjectType: text('subject_type').$type<BindingSubjectType>().notNull(),
    providerSubjectId: text('provider_subject_id').notNull(),
    status: text('status').$type<BindingStatus>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('core_auth_bindings_tenant_id_uk').on(table.tenantId, table.principalAuthBindingId),
    uniqueIndex('core_auth_bindings_subject_uk').on(
      table.tenantId,
      table.provider,
      table.subjectType,
      table.providerSubjectId,
    ),
    uniqueIndex('core_auth_bindings_api_key_subject_global_uk')
      .on(table.provider, table.subjectType, table.providerSubjectId)
      .where(sql`${table.subjectType} = 'api_key'`),
    index('core_auth_bindings_principal_idx').on(table.principalId),
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [principals.tenantId, principals.principalId],
      name: 'core_auth_bindings_tenant_principal_fk',
    }).onDelete('restrict'),
    check('core_auth_bindings_provider_ck', sql`${table.provider} in ('better_auth')`),
    check('core_auth_bindings_subject_type_ck', sql`${table.subjectType} in ('user', 'api_key')`),
    check(
      'core_auth_bindings_status_ck',
      sql`${table.status} in ('active', 'revoked', 'disabled')`,
    ),
    check(
      'core_auth_bindings_lifecycle_ck',
      sql`(${table.status} = 'revoked' and ${table.revokedAt} is not null) or (${table.status} in ('active', 'disabled') and ${table.revokedAt} is null)`,
    ),
  ],
);

const legalEntityId = () => uuid('legal_entity_id');

const authBindingId = () => uuid('auth_binding_id');

const authContextRefColumns = () => ({
  authBindingId: authBindingId(),
  authContextRef: text('auth_context_ref'),
  impersonatedByPrincipalId: optionalPrincipalId('impersonated_by_principal_id'),
});

export const tenantModuleStates = coreSchema.table(
  'tenant_module_states',
  {
    tenantModuleStateId: uuid('tenant_module_state_id').defaultRandom().primaryKey(),
    tenantId: tenantId(),
    moduleKey: text('module_key').notNull(),
    state: text('state').notNull(),
    lastChangeId: uuid('last_change_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('core_module_states_tenant_module_uk').on(table.tenantId, table.moduleKey),
    check(
      'core_module_states_state_ck',
      sql`${table.state} in ('inactive', 'active', 'read_only', 'suspended', 'quarantined', 'deprecated', 'archived')`,
    ),
  ],
);

export const actionInvocations = coreSchema.table(
  'action_invocations',
  {
    actionInvocationId: uuid('action_invocation_id').defaultRandom().primaryKey(),
    tenantId: tenantId(),
    legalEntityId: legalEntityId(),
    principalId: optionalPrincipalId(),
    ...authContextRefColumns(),
    authMethod: text('auth_method').$type<ActionAuthMethod>(),
    anonymousSessionRef: text('anonymous_session_ref'),
    traceId: text('trace_id'),
    correlationId: text('correlation_id'),
    actionKey: text('action_key').notNull(),
    idempotencyKey: text('idempotency_key'),
    targetModuleKey: text('target_module_key'),
    targetResourceType: text('target_resource_type'),
    targetResourceId: text('target_resource_id'),
    status: text('status').$type<ActionInvocationStatus>().notNull(),
    requestHash: text('request_hash').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('core_action_invocations_tenant_id_uk').on(
      table.tenantId,
      table.actionInvocationId,
    ),
    uniqueIndex('core_action_invocations_idempotency_uk')
      .on(table.tenantId, table.actionKey, table.principalId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    index('core_action_invocations_tenant_started_idx').on(table.tenantId, table.startedAt),
    index('core_action_invocations_target_idx').on(
      table.tenantId,
      table.targetModuleKey,
      table.targetResourceType,
      table.targetResourceId,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.legalEntityId],
      name: 'core_action_invocations_tenant_legal_entity_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [principals.tenantId, principals.principalId],
      name: 'core_action_invocations_tenant_principal_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.authBindingId],
      foreignColumns: [
        principalAuthBindings.tenantId,
        principalAuthBindings.principalAuthBindingId,
      ],
      name: 'core_action_invocations_tenant_auth_binding_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.impersonatedByPrincipalId],
      foreignColumns: [principals.tenantId, principals.principalId],
      name: 'core_action_invocations_tenant_impersonator_fk',
    }).onDelete('restrict'),
    check(
      'core_action_invocations_auth_method_ck',
      sql`${table.authMethod} is null or ${table.authMethod} in ('session', 'api_key', 'system', 'support_impersonation')`,
    ),
    check(
      'core_action_invocations_status_ck',
      sql`${table.status} in ('received', 'rejected', 'running', 'succeeded', 'failed', 'indeterminate', 'replayed')`,
    ),
  ],
);

const actionInvocationId = () => uuid('action_invocation_id');

export const tenantModuleStateChanges = coreSchema.table(
  'tenant_module_state_changes',
  {
    moduleStateChangeId: uuid('module_state_change_id').defaultRandom().primaryKey(),
    tenantId: tenantId(),
    moduleKey: text('module_key').notNull(),
    previousState: text('previous_state'),
    newState: text('new_state').notNull(),
    changedByPrincipalId: optionalPrincipalId('changed_by_principal_id'),
    actionInvocationId: actionInvocationId(),
    changeSource: text('change_source').notNull(),
    reason: text('reason'),
    occurredAt: occurredAt(),
  },
  (table) => [
    index('core_module_state_changes_tenant_module_idx').on(
      table.tenantId,
      table.moduleKey,
      table.occurredAt,
    ),
    foreignKey({
      columns: [table.tenantId, table.changedByPrincipalId],
      foreignColumns: [principals.tenantId, principals.principalId],
      name: 'core_module_state_changes_tenant_principal_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.actionInvocationId],
      foreignColumns: [actionInvocations.tenantId, actionInvocations.actionInvocationId],
      name: 'core_module_state_changes_tenant_invocation_fk',
    }).onDelete('restrict'),
    check(
      'core_module_state_changes_source_ck',
      sql`${table.changeSource} in ('user', 'support', 'system')`,
    ),
    check(
      'core_module_state_changes_new_state_ck',
      sql`${table.newState} in ('inactive', 'active', 'read_only', 'suspended', 'quarantined', 'deprecated', 'archived')`,
    ),
  ],
);

export const auditEvents = coreSchema.table(
  'audit_events',
  {
    auditEventId: uuid('audit_event_id').defaultRandom().primaryKey(),
    tenantId: tenantId(),
    legalEntityId: legalEntityId(),
    actionInvocationId: actionInvocationId(),
    principalId: optionalPrincipalId(),
    ...authContextRefColumns(),
    authMethod: text('auth_method').notNull(),
    eventType: text('event_type').notNull(),
    outcome: text('outcome').notNull(),
    outcomeStage: text('outcome_stage').notNull(),
    outcomeCode: text('outcome_code').notNull(),
    auditProfile: text('audit_profile').notNull(),
    targetModuleKey: text('target_module_key'),
    targetResourceType: text('target_resource_type'),
    targetResourceId: text('target_resource_id'),
    evidenceJson: jsonb('evidence_json')
      .notNull()
      .default(sql`'{}'::jsonb`),
    occurredAt: occurredAt(),
  },
  (table) => [
    uniqueIndex('core_audit_events_tenant_id_uk').on(table.tenantId, table.auditEventId),
    index('core_audit_events_tenant_occurred_idx').on(table.tenantId, table.occurredAt),
    index('core_audit_events_action_idx').on(table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.legalEntityId],
      name: 'core_audit_events_tenant_legal_entity_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.actionInvocationId],
      foreignColumns: [actionInvocations.tenantId, actionInvocations.actionInvocationId],
      name: 'core_audit_events_tenant_invocation_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [principals.tenantId, principals.principalId],
      name: 'core_audit_events_tenant_principal_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.authBindingId],
      foreignColumns: [
        principalAuthBindings.tenantId,
        principalAuthBindings.principalAuthBindingId,
      ],
      name: 'core_audit_events_tenant_auth_binding_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.impersonatedByPrincipalId],
      foreignColumns: [principals.tenantId, principals.principalId],
      name: 'core_audit_events_tenant_impersonator_fk',
    }).onDelete('restrict'),
    check(
      'core_audit_events_outcome_ck',
      sql`${table.outcome} in ('allowed', 'denied', 'succeeded', 'failed')`,
    ),
    check(
      'core_audit_events_stage_ck',
      sql`${table.outcomeStage} in ('system', 'authn', 'authz', 'policy', 'validation', 'execution')`,
    ),
    check(
      'core_audit_events_profile_ck',
      sql`${table.auditProfile} in ('standard', 'sensitive', 'minimal')`,
    ),
  ],
);

const auditEventId = () => uuid('audit_event_id');

export const dataAccessEvents = coreSchema.table(
  'data_access_events',
  {
    dataAccessEventId: uuid('data_access_event_id').defaultRandom().primaryKey(),
    tenantId: tenantId(),
    legalEntityId: legalEntityId(),
    actionInvocationId: actionInvocationId(),
    principalId: principalId(),
    ...authContextRefColumns(),
    authMethod: text('auth_method').notNull(),
    outcome: text('outcome').notNull(),
    outcomeStage: text('outcome_stage').notNull(),
    outcomeCode: text('outcome_code').notNull(),
    accessKind: text('access_kind').notNull(),
    servingModuleKey: text('serving_module_key').notNull(),
    targetModuleKey: text('target_module_key'),
    targetResourceType: text('target_resource_type'),
    targetResourceId: text('target_resource_id'),
    queryHash: text('query_hash'),
    resultCount: integer('result_count').notNull(),
    resultFingerprintSchema: text('result_fingerprint_schema'),
    resultFingerprintHash: text('result_fingerprint_hash'),
    evidencePolicyKey: text('evidence_policy_key').notNull(),
    evidenceCaptureMode: text('evidence_capture_mode').notNull(),
    evidencePayloadJson: jsonb('evidence_payload_json'),
    redactionProfile: text('redaction_profile'),
    occurredAt: occurredAt(),
  },
  (table) => [
    uniqueIndex('core_data_access_events_tenant_id_uk').on(table.tenantId, table.dataAccessEventId),
    index('core_data_access_events_tenant_occurred_idx').on(table.tenantId, table.occurredAt),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.legalEntityId],
      name: 'core_data_access_events_tenant_legal_entity_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.actionInvocationId],
      foreignColumns: [actionInvocations.tenantId, actionInvocations.actionInvocationId],
      name: 'core_data_access_events_tenant_invocation_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [principals.tenantId, principals.principalId],
      name: 'core_data_access_events_tenant_principal_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.authBindingId],
      foreignColumns: [
        principalAuthBindings.tenantId,
        principalAuthBindings.principalAuthBindingId,
      ],
      name: 'core_data_access_events_tenant_auth_binding_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.impersonatedByPrincipalId],
      foreignColumns: [principals.tenantId, principals.principalId],
      name: 'core_data_access_events_tenant_impersonator_fk',
    }).onDelete('restrict'),
    check(
      'core_data_access_events_outcome_ck',
      sql`${table.outcome} in ('allowed', 'denied', 'failed')`,
    ),
    check(
      'core_data_access_events_stage_ck',
      sql`${table.outcomeStage} in ('authn', 'context', 'module_state', 'authz', 'policy', 'execution', 'evidence')`,
    ),
    check(
      'core_data_access_events_access_kind_ck',
      sql`${table.accessKind} in ('read', 'list', 'search', 'export', 'download')`,
    ),
    check(
      'core_data_access_events_capture_mode_ck',
      sql`${table.evidenceCaptureMode} in ('metadata_only', 'hash_only', 'redacted_payload', 'stored_artifact')`,
    ),
    check(
      'core_data_access_events_redaction_ck',
      sql`(${table.evidenceCaptureMode} = 'redacted_payload' and ${table.redactionProfile} is not null and ${table.evidencePayloadJson} is not null) or (${table.evidenceCaptureMode} <> 'redacted_payload' and ${table.redactionProfile} is null)`,
    ),
  ],
);

const dataAccessEventId = () => uuid('data_access_event_id');

export const domainEvents = coreSchema.table(
  'domain_events',
  {
    domainEventId: uuid('domain_event_id').defaultRandom().primaryKey(),
    tenantId: tenantId(),
    legalEntityId: legalEntityId(),
    actionInvocationId: actionInvocationId(),
    producerModuleKey: text('producer_module_key').notNull(),
    eventType: text('event_type').notNull(),
    subjectModuleKey: text('subject_module_key').notNull(),
    subjectResourceType: text('subject_resource_type').notNull(),
    subjectResourceId: text('subject_resource_id').notNull(),
    payloadJson: jsonb('payload_json')
      .notNull()
      .default(sql`'{}'::jsonb`),
    // PostgreSQL owns sequence allocation. A global sequence is monotonic for
    // every tenant stream, permits gaps, and is safe across concurrent
    // transactions without application-side max + 1 allocation.
    tenantSequenceNo: bigint('tenant_sequence_no', { mode: 'bigint' })
      .default(sql`nextval('core.domain_event_tenant_sequence_no_seq'::regclass)`)
      .notNull(),
    occurredAt: occurredAt(),
  },
  (table) => [
    uniqueIndex('core_domain_events_tenant_id_uk').on(table.tenantId, table.domainEventId),
    uniqueIndex('core_domain_events_tenant_sequence_uk').on(table.tenantId, table.tenantSequenceNo),
    index('core_domain_events_subject_idx').on(
      table.tenantId,
      table.subjectModuleKey,
      table.subjectResourceType,
      table.subjectResourceId,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.legalEntityId],
      name: 'core_domain_events_tenant_legal_entity_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.actionInvocationId],
      foreignColumns: [actionInvocations.tenantId, actionInvocations.actionInvocationId],
      name: 'core_domain_events_tenant_invocation_fk',
    }).onDelete('restrict'),
  ],
);

const domainEventId = () => uuid('domain_event_id');

export const outboxMessages = coreSchema.table(
  'outbox_messages',
  {
    outboxMessageId: uuid('outbox_message_id').defaultRandom().primaryKey(),
    tenantId: tenantId(),
    domainEventId: domainEventId().notNull(),
    producerModuleKey: text('producer_module_key').notNull(),
    topic: text('topic').notNull(),
    payloadJson: jsonb('payload_json')
      .notNull()
      .default(sql`'{}'::jsonb`),
    matchedAt: timestamp('matched_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    index('core_outbox_messages_unmatched_idx')
      .on(table.createdAt)
      .where(sql`${table.matchedAt} is null`),
    foreignKey({
      columns: [table.tenantId, table.domainEventId],
      foreignColumns: [domainEvents.tenantId, domainEvents.domainEventId],
      name: 'core_outbox_messages_tenant_domain_event_fk',
    }).onDelete('restrict'),
  ],
);

export const outboxDeliveries = coreSchema.table(
  'outbox_deliveries',
  {
    outboxDeliveryId: uuid('outbox_delivery_id').defaultRandom().primaryKey(),
    outboxMessageId: uuid('outbox_message_id')
      .notNull()
      .references(() => outboxMessages.outboxMessageId, { onDelete: 'cascade' }),
    workerKey: text('worker_key').notNull(),
    consumerModuleKey: text('consumer_module_key').notNull(),
    status: text('status').default('pending').notNull(),
    attemptsCount: integer('attempts_count').default(0).notNull(),
    availableAt: timestamp('available_at', { withTimezone: true }).defaultNow().notNull(),
    claimedBy: text('claimed_by'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('core_outbox_deliveries_message_worker_uk').on(
      table.outboxMessageId,
      table.workerKey,
    ),
    index('core_outbox_deliveries_pending_idx')
      .on(table.availableAt)
      .where(sql`${table.status} = 'pending'`),
    index('core_outbox_deliveries_message_idx').on(table.outboxMessageId),
    index('core_outbox_deliveries_worker_status_idx').on(table.workerKey, table.status),
    check(
      'core_outbox_deliveries_status_ck',
      sql`${table.status} in ('pending', 'processing', 'done', 'dead')`,
    ),
    check('core_outbox_deliveries_attempts_count_ck', sql`${table.attemptsCount} >= 0`),
  ],
);

export const outboxAttempts = coreSchema.table(
  'outbox_attempts',
  {
    outboxAttemptId: uuid('outbox_attempt_id').defaultRandom().primaryKey(),
    outboxDeliveryId: uuid('outbox_delivery_id')
      .notNull()
      .references(() => outboxDeliveries.outboxDeliveryId, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    errorMessage: text('error_message'),
  },
  (table) => [
    index('core_outbox_attempts_delivery_started_idx').on(table.outboxDeliveryId, table.startedAt),
  ],
);

export const mediaAssets = coreSchema.table(
  'media_assets',
  {
    mediaAssetId: uuid('media_asset_id').defaultRandom().primaryKey(),
    tenantId: tenantId(),
    legalEntityId: legalEntityId(),
    ingestedByPrincipalId: optionalPrincipalId('ingested_by_principal_id'),
    ingestionSource: text('ingestion_source').notNull(),
    externalSourceRef: text('external_source_ref'),
    storageProvider: text('storage_provider').notNull(),
    storageKey: text('storage_key').notNull(),
    storageObjectVersionRef: text('storage_object_version_ref'),
    originalFilename: text('original_filename'),
    displayFilename: text('display_filename').notNull(),
    mimeType: text('mime_type').notNull(),
    byteSize: bigint('byte_size', { mode: 'bigint' }).notNull(),
    contentSha256: text('content_sha256'),
    sealedAt: timestamp('sealed_at', { withTimezone: true }),
    processingStatus: text('processing_status').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('core_media_assets_tenant_id_uk').on(table.tenantId, table.mediaAssetId),
    uniqueIndex('core_media_assets_storage_uk').on(
      table.storageProvider,
      table.storageKey,
      table.storageObjectVersionRef,
    ),
    index('core_media_assets_tenant_idx').on(table.tenantId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.legalEntityId],
      name: 'core_media_assets_tenant_legal_entity_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.ingestedByPrincipalId],
      foreignColumns: [principals.tenantId, principals.principalId],
      name: 'core_media_assets_tenant_principal_fk',
    }).onDelete('restrict'),
    check(
      'core_media_assets_ingestion_source_ck',
      sql`${table.ingestionSource} in ('user', 'integration', 'import', 'system')`,
    ),
    check(
      'core_media_assets_processing_status_ck',
      sql`${table.processingStatus} in ('uploaded', 'scanning', 'ready', 'failed')`,
    ),
  ],
);

const mediaAssetId = () => uuid('media_asset_id').notNull();

export const mediaLinks = coreSchema.table(
  'media_links',
  {
    mediaLinkId: uuid('media_link_id').defaultRandom().primaryKey(),
    tenantId: tenantId(),
    mediaAssetId: mediaAssetId(),
    linkedByPrincipalId: optionalPrincipalId('linked_by_principal_id'),
    actionInvocationId: actionInvocationId(),
    linkSource: text('link_source').notNull(),
    targetModuleKey: text('target_module_key').notNull(),
    targetResourceType: text('target_resource_type').notNull(),
    targetResourceId: text('target_resource_id').notNull(),
    linkKind: text('link_kind').notNull(),
    createdAt: createdAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('core_media_links_target_idx').on(
      table.tenantId,
      table.targetModuleKey,
      table.targetResourceType,
      table.targetResourceId,
    ),
    foreignKey({
      columns: [table.tenantId, table.mediaAssetId],
      foreignColumns: [mediaAssets.tenantId, mediaAssets.mediaAssetId],
      name: 'core_media_links_tenant_asset_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.linkedByPrincipalId],
      foreignColumns: [principals.tenantId, principals.principalId],
      name: 'core_media_links_tenant_principal_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.actionInvocationId],
      foreignColumns: [actionInvocations.tenantId, actionInvocations.actionInvocationId],
      name: 'core_media_links_tenant_invocation_fk',
    }).onDelete('restrict'),
    check(
      'core_media_links_source_ck',
      sql`${table.linkSource} in ('user', 'integration', 'import', 'system')`,
    ),
  ],
);

export const evidenceReferences = coreSchema.table(
  'evidence_references',
  {
    evidenceReferenceId: uuid('evidence_reference_id').defaultRandom().primaryKey(),
    tenantId: tenantId(),
    legalEntityId: legalEntityId(),
    mediaAssetId: mediaAssetId(),
    sourceKind: text('source_kind').notNull(),
    actionInvocationId: actionInvocationId(),
    auditEventId: auditEventId(),
    dataAccessEventId: dataAccessEventId(),
    domainEventId: domainEventId(),
    evidenceKind: text('evidence_kind').notNull(),
    subjectModuleKey: text('subject_module_key'),
    subjectResourceType: text('subject_resource_type'),
    subjectResourceId: text('subject_resource_id'),
    evidencePolicyKey: text('evidence_policy_key').notNull(),
    retentionPolicyKey: text('retention_policy_key').notNull(),
    artifactContentSha256: text('artifact_content_sha256').notNull(),
    storageLockScope: text('storage_lock_scope').notNull(),
    storageLockMode: text('storage_lock_mode').notNull(),
    storageLegalHold: boolean('storage_legal_hold').default(false).notNull(),
    storageRetainUntil: timestamp('storage_retain_until', { withTimezone: true }),
    storageLockStatus: text('storage_lock_status').notNull(),
    storageLockVerifiedAt: timestamp('storage_lock_verified_at', { withTimezone: true }),
    storageLockEvidenceJson: jsonb('storage_lock_evidence_json')
      .notNull()
      .default(sql`'{}'::jsonb`),
    retainUntil: timestamp('retain_until', { withTimezone: true }),
    legalHoldUntil: timestamp('legal_hold_until', { withTimezone: true }),
    dispositionStatus: text('disposition_status').notNull(),
    dataClassification: text('data_classification').notNull(),
    schemaKey: text('schema_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('core_evidence_references_subject_idx').on(
      table.tenantId,
      table.subjectModuleKey,
      table.subjectResourceType,
      table.subjectResourceId,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.legalEntityId],
      name: 'core_evidence_tenant_legal_entity_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.mediaAssetId],
      foreignColumns: [mediaAssets.tenantId, mediaAssets.mediaAssetId],
      name: 'core_evidence_tenant_asset_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.actionInvocationId],
      foreignColumns: [actionInvocations.tenantId, actionInvocations.actionInvocationId],
      name: 'core_evidence_tenant_invocation_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.auditEventId],
      foreignColumns: [auditEvents.tenantId, auditEvents.auditEventId],
      name: 'core_evidence_tenant_audit_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.dataAccessEventId],
      foreignColumns: [dataAccessEvents.tenantId, dataAccessEvents.dataAccessEventId],
      name: 'core_evidence_tenant_data_access_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.domainEventId],
      foreignColumns: [domainEvents.tenantId, domainEvents.domainEventId],
      name: 'core_evidence_tenant_domain_event_fk',
    }).onDelete('restrict'),
    check(
      'core_evidence_references_source_kind_ck',
      sql`${table.sourceKind} in ('action', 'audit', 'data_access', 'domain_event')`,
    ),
    check(
      'core_evidence_references_source_one_ck',
      sql`num_nonnulls(${table.actionInvocationId}, ${table.auditEventId}, ${table.dataAccessEventId}, ${table.domainEventId}) = 1`,
    ),
    check(
      'core_evidence_references_subject_all_ck',
      sql`num_nonnulls(${table.subjectModuleKey}, ${table.subjectResourceType}, ${table.subjectResourceId}) in (0, 3)`,
    ),
    check(
      'core_evidence_references_disposition_ck',
      sql`${table.dispositionStatus} in ('active', 'expired', 'deleted', 'legal_hold')`,
    ),
    check(
      'core_evidence_references_classification_ck',
      sql`${table.dataClassification} in ('internal', 'confidential', 'restricted')`,
    ),
  ],
);

export const searchIndexEntries = coreSchema.table(
  'search_index_entries',
  {
    searchIndexEntryId: uuid('search_index_entry_id').defaultRandom().primaryKey(),
    tenantId: tenantId(),
    legalEntityId: legalEntityId(),
    sourceModuleKey: text('source_module_key').notNull(),
    sourceResourceType: text('source_resource_type').notNull(),
    sourceResourceId: text('source_resource_id').notNull(),
    title: text('title').notNull(),
    bodyText: text('body_text').notNull(),
    facetsJson: jsonb('facets_json')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('core_search_index_entries_source_uk').on(
      table.tenantId,
      table.sourceModuleKey,
      table.sourceResourceType,
      table.sourceResourceId,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.legalEntityId],
      name: 'core_search_index_entries_tenant_legal_entity_fk',
    }).onDelete('restrict'),
  ],
);

export const workerCheckpoints = coreSchema.table(
  'worker_checkpoints',
  {
    tenantId: tenantId(),
    consumerName: text('consumer_name').notNull(),
    streamKey: text('stream_key').notNull(),
    lastTenantSequenceNo: bigint('last_tenant_sequence_no', { mode: 'bigint' }),
    lastProcessedAt: timestamp('last_processed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      name: 'core_worker_checkpoints_pk',
      columns: [table.tenantId, table.consumerName, table.streamKey],
    }),
  ],
);

export const coreDatabaseSchema = {
  actionInvocations,
  auditEvents,
  dataAccessEvents,
  domainEvents,
  evidenceReferences,
  legalEntities,
  mediaAssets,
  mediaLinks,
  outboxAttempts,
  outboxDeliveries,
  outboxMessages,
  principalAuthBindings,
  principals,
  searchIndexEntries,
  tenantModuleStateChanges,
  tenantModuleStates,
  tenants,
  workerCheckpoints,
} as const;

export const CORE_TABLES = [
  tenants,
  legalEntities,
  principals,
  principalAuthBindings,
  tenantModuleStates,
  actionInvocations,
  tenantModuleStateChanges,
  auditEvents,
  dataAccessEvents,
  domainEvents,
  outboxMessages,
  outboxDeliveries,
  outboxAttempts,
  mediaAssets,
  mediaLinks,
  evidenceReferences,
  searchIndexEntries,
  workerCheckpoints,
] as const;

export type TenantRow = typeof tenants.$inferSelect;
export type TenantInsert = typeof tenants.$inferInsert;
