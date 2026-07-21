import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
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

export const coreSchema = pgSchema('core');

const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).defaultNow().notNull();
const occurredAt = () => timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull();

export const tenants = coreSchema.table(
  'tenants',
  {
    createdAt: createdAt(),
    defaultLocale: text('default_locale').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    status: text('status').notNull(),
    tenantId: uuid('tenant_id').defaultRandom().primaryKey(),
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
    createdAt: createdAt(),
    legalEntityId: uuid('legal_entity_id').defaultRandom().primaryKey(),
    legalName: text('legal_name').notNull(),
    registrationCountry: text('registration_country').notNull(),
    registrationNumber: text('registration_number').notNull(),
    status: text('status').notNull(),
    tenantId: tenantId(),
    updatedAt: updatedAt(),
    vatId: text('vat_id'),
  },
  (table) => [
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
    createdAt: createdAt(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    displayName: text('display_name').notNull(),
    kind: text('kind').notNull(),
    principalId: uuid('principal_id').defaultRandom().primaryKey(),
    status: text('status').notNull(),
    tenantId: tenantId(),
  },
  (table) => [
    index('core_principals_tenant_kind_idx').on(table.tenantId, table.kind),
    check(
      'core_principals_kind_ck',
      sql`${table.kind} in ('human', 'service', 'integration', 'agent', 'system')`,
    ),
    check('core_principals_status_ck', sql`${table.status} in ('active', 'disabled', 'archived')`),
  ],
);

export const principalTimeZonePreferences = coreSchema.table(
  'principal_time_zone_preferences',
  {
    principalId: uuid('principal_id')
      .notNull()
      .references(() => principals.principalId, { onDelete: 'restrict' }),
    tenantId: tenantId(),
    timeZone: text('time_zone').notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.principalId],
      name: 'core_principal_time_zone_preferences_pk',
    }),
  ],
);

const principalId = (columnName = 'principal_id') =>
  uuid(columnName)
    .notNull()
    .references(() => principals.principalId, { onDelete: 'restrict' });

const optionalPrincipalId = (columnName = 'principal_id') =>
  uuid(columnName).references(() => principals.principalId, { onDelete: 'restrict' });

export const principalAuthBindings = coreSchema.table(
  'principal_auth_bindings',
  {
    createdAt: createdAt(),
    principalAuthBindingId: uuid('principal_auth_binding_id').defaultRandom().primaryKey(),
    principalId: principalId(),
    provider: text('provider').notNull(),
    providerSubjectId: text('provider_subject_id').notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    status: text('status').notNull(),
    subjectType: text('subject_type').notNull(),
    tenantId: tenantId(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('core_auth_bindings_subject_uk').on(
      table.tenantId,
      table.provider,
      table.subjectType,
      table.providerSubjectId,
    ),
    index('core_auth_bindings_principal_idx').on(table.principalId),
    check('core_auth_bindings_provider_ck', sql`${table.provider} in ('better_auth')`),
    check('core_auth_bindings_subject_type_ck', sql`${table.subjectType} in ('user', 'api_key')`),
    check(
      'core_auth_bindings_status_ck',
      sql`${table.status} in ('active', 'revoked', 'disabled')`,
    ),
  ],
);

const legalEntityId = () =>
  uuid('legal_entity_id').references(() => legalEntities.legalEntityId, {
    onDelete: 'restrict',
  });

const authBindingId = () =>
  uuid('auth_binding_id').references(() => principalAuthBindings.principalAuthBindingId, {
    onDelete: 'restrict',
  });

export const tenantModuleStates = coreSchema.table(
  'tenant_module_states',
  {
    createdAt: createdAt(),
    lastChangeId: uuid('last_change_id'),
    moduleKey: text('module_key').notNull(),
    state: text('state').notNull(),
    tenantId: tenantId(),
    tenantModuleStateId: uuid('tenant_module_state_id').defaultRandom().primaryKey(),
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
    actionKey: text('action_key').notNull(),
    authBindingId: authBindingId(),
    authContextRef: text('auth_context_ref'),
    authMethod: text('auth_method').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    correlationId: text('correlation_id'),
    idempotencyKey: text('idempotency_key'),
    impersonatedByPrincipalId: optionalPrincipalId('impersonated_by_principal_id'),
    legalEntityId: legalEntityId(),
    principalId: principalId(),
    requestHash: text('request_hash').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    status: text('status').notNull(),
    targetModuleKey: text('target_module_key'),
    targetResourceId: text('target_resource_id'),
    targetResourceType: text('target_resource_type'),
    tenantId: tenantId(),
    traceId: text('trace_id'),
  },
  (table) => [
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
    check(
      'core_action_invocations_auth_method_ck',
      sql`${table.authMethod} in ('session', 'api_key', 'system', 'support_impersonation')`,
    ),
    check(
      'core_action_invocations_status_ck',
      sql`${table.status} in ('received', 'rejected', 'running', 'succeeded', 'failed', 'replayed')`,
    ),
  ],
);

const actionInvocationId = () =>
  uuid('action_invocation_id').references(() => actionInvocations.actionInvocationId, {
    onDelete: 'restrict',
  });

export const tenantModuleStateChanges = coreSchema.table(
  'tenant_module_state_changes',
  {
    actionInvocationId: actionInvocationId(),
    changeSource: text('change_source').notNull(),
    changedByPrincipalId: optionalPrincipalId('changed_by_principal_id'),
    moduleKey: text('module_key').notNull(),
    moduleStateChangeId: uuid('module_state_change_id').defaultRandom().primaryKey(),
    newState: text('new_state').notNull(),
    occurredAt: occurredAt(),
    previousState: text('previous_state'),
    reason: text('reason'),
    tenantId: tenantId(),
  },
  (table) => [
    index('core_module_state_changes_tenant_module_idx').on(
      table.tenantId,
      table.moduleKey,
      table.occurredAt,
    ),
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
    actionInvocationId: actionInvocationId(),
    auditEventId: uuid('audit_event_id').defaultRandom().primaryKey(),
    auditProfile: text('audit_profile').notNull(),
    authBindingId: authBindingId(),
    authContextRef: text('auth_context_ref'),
    authMethod: text('auth_method').notNull(),
    eventType: text('event_type').notNull(),
    evidenceJson: jsonb('evidence_json')
      .notNull()
      .default(sql`'{}'::jsonb`),
    impersonatedByPrincipalId: optionalPrincipalId('impersonated_by_principal_id'),
    legalEntityId: legalEntityId(),
    occurredAt: occurredAt(),
    outcome: text('outcome').notNull(),
    outcomeCode: text('outcome_code').notNull(),
    outcomeStage: text('outcome_stage').notNull(),
    principalId: optionalPrincipalId(),
    targetModuleKey: text('target_module_key'),
    targetResourceId: text('target_resource_id'),
    targetResourceType: text('target_resource_type'),
    tenantId: tenantId(),
  },
  (table) => [
    index('core_audit_events_tenant_occurred_idx').on(table.tenantId, table.occurredAt),
    index('core_audit_events_action_idx').on(table.actionInvocationId),
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

const auditEventId = () =>
  uuid('audit_event_id').references(() => auditEvents.auditEventId, {
    onDelete: 'restrict',
  });

export const dataAccessEvents = coreSchema.table(
  'data_access_events',
  {
    accessKind: text('access_kind').notNull(),
    actionInvocationId: actionInvocationId(),
    authBindingId: authBindingId(),
    authContextRef: text('auth_context_ref'),
    authMethod: text('auth_method').notNull(),
    dataAccessEventId: uuid('data_access_event_id').defaultRandom().primaryKey(),
    evidenceCaptureMode: text('evidence_capture_mode').notNull(),
    evidencePayloadJson: jsonb('evidence_payload_json'),
    evidencePolicyKey: text('evidence_policy_key').notNull(),
    impersonatedByPrincipalId: optionalPrincipalId('impersonated_by_principal_id'),
    legalEntityId: legalEntityId(),
    occurredAt: occurredAt(),
    principalId: principalId(),
    queryHash: text('query_hash').notNull(),
    redactionProfile: text('redaction_profile'),
    resultCount: integer('result_count').notNull(),
    resultFingerprintHash: text('result_fingerprint_hash'),
    resultFingerprintSchema: text('result_fingerprint_schema'),
    servingModuleKey: text('serving_module_key').notNull(),
    targetModuleKey: text('target_module_key'),
    targetResourceId: text('target_resource_id'),
    targetResourceType: text('target_resource_type'),
    tenantId: tenantId(),
  },
  (table) => [
    index('core_data_access_events_tenant_occurred_idx').on(table.tenantId, table.occurredAt),
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

const dataAccessEventId = () =>
  uuid('data_access_event_id').references(() => dataAccessEvents.dataAccessEventId, {
    onDelete: 'restrict',
  });

export const domainEvents = coreSchema.table(
  'domain_events',
  {
    actionInvocationId: actionInvocationId(),
    domainEventId: uuid('domain_event_id').defaultRandom().primaryKey(),
    eventType: text('event_type').notNull(),
    legalEntityId: legalEntityId(),
    occurredAt: occurredAt(),
    payloadJson: jsonb('payload_json')
      .notNull()
      .default(sql`'{}'::jsonb`),
    producerModuleKey: text('producer_module_key').notNull(),
    subjectModuleKey: text('subject_module_key').notNull(),
    subjectResourceId: text('subject_resource_id').notNull(),
    subjectResourceType: text('subject_resource_type').notNull(),
    tenantId: tenantId(),
    tenantSequenceNo: bigint('tenant_sequence_no', { mode: 'bigint' }).notNull(),
  },
  (table) => [
    uniqueIndex('core_domain_events_tenant_sequence_uk').on(table.tenantId, table.tenantSequenceNo),
    index('core_domain_events_subject_idx').on(
      table.tenantId,
      table.subjectModuleKey,
      table.subjectResourceType,
      table.subjectResourceId,
    ),
  ],
);

const domainEventId = () =>
  uuid('domain_event_id').references(() => domainEvents.domainEventId, {
    onDelete: 'restrict',
  });

export const outboxMessages = coreSchema.table(
  'outbox_messages',
  {
    createdAt: createdAt(),
    domainEventId: domainEventId().notNull(),
    matchedAt: timestamp('matched_at', { withTimezone: true }),
    outboxMessageId: uuid('outbox_message_id').defaultRandom().primaryKey(),
    payloadJson: jsonb('payload_json')
      .notNull()
      .default(sql`'{}'::jsonb`),
    producerModuleKey: text('producer_module_key').notNull(),
    tenantId: tenantId(),
    topic: text('topic').notNull(),
  },
  (table) => [
    index('core_outbox_messages_unmatched_idx')
      .on(table.createdAt)
      .where(sql`${table.matchedAt} is null`),
  ],
);

export const outboxDeliveries = coreSchema.table(
  'outbox_deliveries',
  {
    attemptsCount: integer('attempts_count').default(0).notNull(),
    availableAt: timestamp('available_at', { withTimezone: true }).defaultNow().notNull(),
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimedBy: text('claimed_by'),
    consumerModuleKey: text('consumer_module_key').notNull(),
    createdAt: createdAt(),
    outboxDeliveryId: uuid('outbox_delivery_id').defaultRandom().primaryKey(),
    outboxMessageId: uuid('outbox_message_id')
      .notNull()
      .references(() => outboxMessages.outboxMessageId, { onDelete: 'cascade' }),
    status: text('status').default('pending').notNull(),
    updatedAt: updatedAt(),
    workerKey: text('worker_key').notNull(),
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
    errorMessage: text('error_message'),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    outboxAttemptId: uuid('outbox_attempt_id').defaultRandom().primaryKey(),
    outboxDeliveryId: uuid('outbox_delivery_id')
      .notNull()
      .references(() => outboxDeliveries.outboxDeliveryId, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('core_outbox_attempts_delivery_started_idx').on(table.outboxDeliveryId, table.startedAt),
  ],
);

export const mediaAssets = coreSchema.table(
  'media_assets',
  {
    byteSize: bigint('byte_size', { mode: 'bigint' }).notNull(),
    contentSha256: text('content_sha256'),
    createdAt: createdAt(),
    displayFilename: text('display_filename').notNull(),
    externalSourceRef: text('external_source_ref'),
    ingestedByPrincipalId: optionalPrincipalId('ingested_by_principal_id'),
    ingestionSource: text('ingestion_source').notNull(),
    legalEntityId: legalEntityId(),
    mediaAssetId: uuid('media_asset_id').defaultRandom().primaryKey(),
    mimeType: text('mime_type').notNull(),
    originalFilename: text('original_filename'),
    processingStatus: text('processing_status').notNull(),
    sealedAt: timestamp('sealed_at', { withTimezone: true }),
    storageKey: text('storage_key').notNull(),
    storageObjectVersionRef: text('storage_object_version_ref'),
    storageProvider: text('storage_provider').notNull(),
    tenantId: tenantId(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('core_media_assets_storage_uk').on(
      table.storageProvider,
      table.storageKey,
      table.storageObjectVersionRef,
    ),
    index('core_media_assets_tenant_idx').on(table.tenantId),
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

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
});

export const mediaAssetBytes = coreSchema.table('media_asset_bytes', {
  bytes: bytea('bytes').notNull(),
  mediaAssetId: uuid('media_asset_id')
    .primaryKey()
    .references(() => mediaAssets.mediaAssetId, { onDelete: 'restrict' }),
  tenantId: tenantId(),
});

const mediaAssetId = () =>
  uuid('media_asset_id')
    .notNull()
    .references(() => mediaAssets.mediaAssetId, { onDelete: 'restrict' });

export const mediaLinks = coreSchema.table(
  'media_links',
  {
    actionInvocationId: actionInvocationId(),
    createdAt: createdAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    linkKind: text('link_kind').notNull(),
    linkSource: text('link_source').notNull(),
    linkedByPrincipalId: optionalPrincipalId('linked_by_principal_id'),
    mediaAssetId: mediaAssetId(),
    mediaLinkId: uuid('media_link_id').defaultRandom().primaryKey(),
    targetModuleKey: text('target_module_key').notNull(),
    targetResourceId: text('target_resource_id').notNull(),
    targetResourceType: text('target_resource_type').notNull(),
    tenantId: tenantId(),
  },
  (table) => [
    index('core_media_links_target_idx').on(
      table.tenantId,
      table.targetModuleKey,
      table.targetResourceType,
      table.targetResourceId,
    ),
    check(
      'core_media_links_source_ck',
      sql`${table.linkSource} in ('user', 'integration', 'import', 'system')`,
    ),
  ],
);

export const evidenceReferences = coreSchema.table(
  'evidence_references',
  {
    actionInvocationId: actionInvocationId(),
    artifactContentSha256: text('artifact_content_sha256').notNull(),
    auditEventId: auditEventId(),
    createdAt: createdAt(),
    dataAccessEventId: dataAccessEventId(),
    dataClassification: text('data_classification').notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    dispositionStatus: text('disposition_status').notNull(),
    domainEventId: domainEventId(),
    evidenceKind: text('evidence_kind').notNull(),
    evidencePolicyKey: text('evidence_policy_key').notNull(),
    evidenceReferenceId: uuid('evidence_reference_id').defaultRandom().primaryKey(),
    legalEntityId: legalEntityId(),
    legalHoldUntil: timestamp('legal_hold_until', { withTimezone: true }),
    mediaAssetId: mediaAssetId(),
    retainUntil: timestamp('retain_until', { withTimezone: true }),
    retentionPolicyKey: text('retention_policy_key').notNull(),
    schemaKey: text('schema_key'),
    sourceKind: text('source_kind').notNull(),
    storageLegalHold: boolean('storage_legal_hold').default(false).notNull(),
    storageLockEvidenceJson: jsonb('storage_lock_evidence_json')
      .notNull()
      .default(sql`'{}'::jsonb`),
    storageLockMode: text('storage_lock_mode').notNull(),
    storageLockScope: text('storage_lock_scope').notNull(),
    storageLockStatus: text('storage_lock_status').notNull(),
    storageLockVerifiedAt: timestamp('storage_lock_verified_at', { withTimezone: true }),
    storageRetainUntil: timestamp('storage_retain_until', { withTimezone: true }),
    subjectModuleKey: text('subject_module_key'),
    subjectResourceId: text('subject_resource_id'),
    subjectResourceType: text('subject_resource_type'),
    tenantId: tenantId(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('core_evidence_references_subject_idx').on(
      table.tenantId,
      table.subjectModuleKey,
      table.subjectResourceType,
      table.subjectResourceId,
    ),
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
    bodyText: text('body_text').notNull(),
    createdAt: createdAt(),
    facetsJson: jsonb('facets_json')
      .notNull()
      .default(sql`'{}'::jsonb`),
    legalEntityId: legalEntityId(),
    searchIndexEntryId: uuid('search_index_entry_id').defaultRandom().primaryKey(),
    sourceModuleKey: text('source_module_key').notNull(),
    sourceResourceId: text('source_resource_id').notNull(),
    sourceResourceType: text('source_resource_type').notNull(),
    tenantId: tenantId(),
    title: text('title').notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('core_search_index_entries_source_uk').on(
      table.tenantId,
      table.sourceModuleKey,
      table.sourceResourceType,
      table.sourceResourceId,
    ),
  ],
);

export const workerCheckpoints = coreSchema.table(
  'worker_checkpoints',
  {
    consumerName: text('consumer_name').notNull(),
    createdAt: createdAt(),
    lastProcessedAt: timestamp('last_processed_at', { withTimezone: true }),
    lastTenantSequenceNo: bigint('last_tenant_sequence_no', { mode: 'bigint' }),
    streamKey: text('stream_key').notNull(),
    tenantId: tenantId(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.consumerName, table.streamKey],
      name: 'core_worker_checkpoints_pk',
    }),
  ],
);

export type TenantRow = typeof tenants.$inferSelect;
export type TenantInsert = typeof tenants.$inferInsert;
