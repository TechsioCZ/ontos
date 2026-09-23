/* oxlint-disable perfectionist/sort-objects -- Drizzle declaration order is the physical Catalog schema contract; expires: 2027-03-31. */
import { tenantRlsPolicies } from '@app/core-runtime';
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
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { ColorDetails } from '../../shared/domain/color.ts';

export const CATALOG_SCHEMA_NAME = 'catalog';

export const CATALOG_TABLE_INVENTORY = [
  'attribute_definition_revisions',
  'attribute_definitions',
  'attribute_value_items',
  'attribute_value_revisions',
  'attribute_value_sets',
  'brand_revisions',
  'brands',
  'catalog_accepted_source_assertions',
  'catalog_local_override_heads',
  'catalog_local_override_revisions',
  'catalog_media_assignment_revisions',
  'catalog_media_assignment_set_revisions',
  'catalog_media_assignment_sets',
  'catalog_media_assignments',
  'catalog_result_snapshots',
  'commercial_gtin_assignment_revisions',
  'commercial_gtin_assignments',
  'commercial_sku_assignment_revisions',
  'commercial_sku_reservations',
  'configuration_unit_revisions',
  'configuration_units',
  'controlled_attribute_value_revisions',
  'controlled_attribute_values',
  'manufacturer_relation_revisions',
  'manufacturer_relations',
  'package_content_revisions',
  'package_definitions',
  'package_option_role_revisions',
  'package_unit_divisibility',
  'package_unit_divisibility_revisions',
  'product_attribute_applicability',
  'product_attribute_applicability_revisions',
  'product_brand_assignment_revisions',
  'product_brand_assignments',
  'product_categories',
  'product_category_assignments',
  'product_category_events',
  'product_category_hierarchy_revisions',
  'product_configuration_choice_options',
  'product_configuration_choices',
  'product_configuration_compatibility_rules',
  'product_configuration_continuity_decisions',
  'product_configuration_definition_revisions',
  'product_configuration_definitions',
  'product_configuration_measured_rules',
  'product_configuration_option_allowances',
  'product_configuration_revision_activations',
  'product_lifecycle_events',
  'product_localized_fact_revisions',
  'product_localized_facts',
  'product_relationship_revisions',
  'product_relationships',
  'product_revisions',
  'product_size_usage_items',
  'product_size_usage_revision_items',
  'product_size_usage_revisions',
  'product_size_usage_sets',
  'product_type_assignment_events',
  'product_type_assignments',
  'product_type_revision_attributes',
  'product_type_revisions',
  'product_type_untyped_decisions',
  'product_types',
  'product_unit_rule_revisions',
  'product_units',
  'product_variant_axes',
  'product_variant_axis_allowance_events',
  'product_variant_axis_allowed_values',
  'product_variant_axis_events',
  'product_variant_revisions',
  'product_variants',
  'products',
  'set_composition_components',
  'set_composition_revisions',
  'set_compositions',
  'size_equivalence_assertions',
  'variant_localized_fact_revisions',
  'variant_localized_facts',
  'variant_unit_divisibility',
  'variant_unit_divisibility_revisions',
] as const;

export const catalogSchema = pgSchema(CATALOG_SCHEMA_NAME);

const recordedAt = () => timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull();

/** The committed Action result is retained by its original invocation, never reconstructed from Current state. */
export const catalogResultSnapshots = catalogSchema.table.withRLS(
  'catalog_result_snapshots',
  {
    tenantId: uuid('tenant_id').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    actionKey: text('action_key').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    encodedResult: jsonb('encoded_result').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.actionInvocationId], name: 'catalog_result_snapshots_pk' }),
    check(
      'catalog_result_snapshots_action_key_ck',
      sql`${table.actionKey} = btrim(${table.actionKey}) and length(${table.actionKey}) between 1 and 200`,
    ),
    check('catalog_result_snapshots_schema_version_ck', sql`${table.schemaVersion} > 0`),
    check(
      'catalog_result_snapshots_result_size_ck',
      sql`octet_length(${table.encodedResult}::text) between 2 and 65536`,
    ),
    ...tenantRlsPolicies('catalog_result_snapshots_tenant', table.tenantId),
  ],
);

/** Immutable accepted authoritative base assertions with complete source and authority evidence. */
export const catalogAcceptedSourceAssertions = catalogSchema.table.withRLS(
  'catalog_accepted_source_assertions',
  {
    tenantId: uuid('tenant_id').notNull(),
    assertionId: uuid('assertion_id').notNull(),
    targetKind: text('target_kind').notNull(),
    targetId: uuid('target_id').notNull(),
    factKey: text('fact_key').notNull(),
    issuerSystemId: text('issuer_system_id').notNull(),
    sourceIssuerKind: text('source_issuer_kind').notNull(),
    sourceIssuerId: text('source_issuer_id').notNull(),
    sourceRecordNamespace: text('source_record_namespace').notNull(),
    sourceRecordId: text('source_record_id').notNull(),
    sourceRevision: bigint('source_revision', { mode: 'bigint' }).notNull(),
    evidencedAt: timestamp('evidenced_at', { withTimezone: true }).notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    value: jsonb('value').notNull(),
    valueFingerprint: text('value_fingerprint').notNull(),
    targetResolutionSource: text('target_resolution_source').notNull(),
    correlationRef: text('correlation_ref'),
    deterministicRuleId: text('deterministic_rule_id'),
    correlationCaptureStatus: text('correlation_capture_status').notNull(),
    authorityIssuerSystemId: text('authority_issuer_system_id').notNull(),
    authorityTargetKind: text('authority_target_kind').notNull(),
    authorityFactKey: text('authority_fact_key').notNull(),
    authorityStatus: text('authority_status').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.assertionId], name: 'catalog_source_assertions_pk' }),
    unique('catalog_source_assertions_source_revision_uk').on(
      table.tenantId,
      table.targetKind,
      table.targetId,
      table.factKey,
      table.sourceIssuerKind,
      table.sourceIssuerId,
      table.sourceRecordNamespace,
      table.sourceRecordId,
      table.sourceRevision,
    ),
    unique('catalog_source_assertions_invocation_uk').on(table.tenantId, table.actionInvocationId, table.assertionId),
    index('catalog_source_assertions_scope_idx').on(table.tenantId, table.targetKind, table.targetId, table.factKey),
    check(
      'catalog_source_assertions_target_kind_ck',
      sql`${table.targetKind} in ('PRODUCT', 'VARIANT', 'PACKAGE_DEFINITION')`,
    ),
    check(
      'catalog_source_assertions_source_kind_ck',
      sql`${table.sourceIssuerKind} in ('EXTERNAL_BUSINESS_SYSTEM', 'EXTERNAL_EVIDENCE_PROVIDER')`,
    ),
    check('catalog_source_assertions_revision_ck', sql`${table.sourceRevision} >= 0`),
    check(
      'catalog_source_assertions_period_ck',
      sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    check('catalog_source_assertions_fingerprint_ck', sql`${table.valueFingerprint} ~ '^[0-9a-f]{64}$'`),
    check(
      'catalog_source_assertions_issuer_ck',
      sql`${table.issuerSystemId} = ${table.sourceIssuerId} and ${table.authorityIssuerSystemId} = ${table.issuerSystemId}`,
    ),
    check(
      'catalog_source_assertions_authority_ck',
      sql`${table.authorityStatus} = 'VERIFIED' and ${table.authorityTargetKind} = ${table.targetKind} and ${table.authorityFactKey} = ${table.factKey}`,
    ),
    check(
      'catalog_source_assertions_resolution_ck',
      sql`(${table.targetResolutionSource} = 'OWNER_CORRELATION' and ${table.correlationRef} is not null and ${table.deterministicRuleId} is null and ${table.correlationCaptureStatus} = 'ALREADY_OWNER_CONFIRMED') or (${table.targetResolutionSource} = 'PRE_APPROVED_RULE' and ${table.correlationRef} is null and ${table.deterministicRuleId} is not null and ${table.correlationCaptureStatus} = 'CONFIRMED_BEFORE_ACCEPTANCE')`,
    ),
    check('catalog_source_assertions_fact_key_ck', sql`length(btrim(${table.factKey})) between 1 and 200`),
    check('catalog_source_assertions_value_size_ck', sql`octet_length(${table.value}::text) between 1 and 65536`),
    ...tenantRlsPolicies('catalog_source_assertions_tenant', table.tenantId),
  ],
);

/** Immutable Local Override decisions. Release repeats the accepted value for complete evidence. */
export const catalogLocalOverrideRevisions = catalogSchema.table.withRLS(
  'catalog_local_override_revisions',
  {
    tenantId: uuid('tenant_id').notNull(),
    targetKind: text('target_kind').notNull(),
    targetId: uuid('target_id').notNull(),
    factKey: text('fact_key').notNull(),
    revision: bigint('revision', { mode: 'bigint' }).notNull(),
    lifecycle: text('lifecycle').notNull(),
    value: jsonb('value').notNull(),
    actorPrincipalId: uuid('actor_principal_id').notNull(),
    reason: text('reason').notNull(),
    evidenceRef: text('evidence_ref').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.targetKind, table.targetId, table.factKey, table.revision],
      name: 'catalog_local_override_revisions_pk',
    }),
    unique('catalog_local_override_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    check(
      'catalog_local_override_revisions_target_kind_ck',
      sql`${table.targetKind} in ('PRODUCT', 'VARIANT', 'PACKAGE_DEFINITION')`,
    ),
    check('catalog_local_override_revisions_revision_ck', sql`${table.revision} > 0`),
    check('catalog_local_override_revisions_lifecycle_ck', sql`${table.lifecycle} in ('ACTIVE', 'RELEASED')`),
    check('catalog_local_override_revisions_reason_ck', sql`length(btrim(${table.reason})) between 1 and 1000`),
    check('catalog_local_override_revisions_evidence_ck', sql`length(btrim(${table.evidenceRef})) between 1 and 1000`),
    check(
      'catalog_local_override_revisions_value_size_ck',
      sql`octet_length(${table.value}::text) between 1 and 65536`,
    ),
    ...tenantRlsPolicies('catalog_local_override_revisions_tenant', table.tenantId),
  ],
);

/** One CAS projection per exact scope; history remains solely in the immutable revision ledger. */
export const catalogLocalOverrideHeads = catalogSchema.table.withRLS(
  'catalog_local_override_heads',
  {
    tenantId: uuid('tenant_id').notNull(),
    targetKind: text('target_kind').notNull(),
    targetId: uuid('target_id').notNull(),
    factKey: text('fact_key').notNull(),
    latestRevision: bigint('latest_revision', { mode: 'bigint' }).notNull(),
    activeRevision: bigint('active_revision', { mode: 'bigint' }),
    lifecycle: text('lifecycle').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.targetKind, table.targetId, table.factKey],
      name: 'catalog_local_override_heads_pk',
    }),
    uniqueIndex('catalog_local_override_heads_one_active_uk')
      .on(table.tenantId, table.targetKind, table.targetId, table.factKey)
      .where(sql`${table.activeRevision} is not null`),
    check(
      'catalog_local_override_heads_target_kind_ck',
      sql`${table.targetKind} in ('PRODUCT', 'VARIANT', 'PACKAGE_DEFINITION')`,
    ),
    check(
      'catalog_local_override_heads_revision_ck',
      sql`${table.latestRevision} > 0 and (${table.activeRevision} is null or ${table.activeRevision} = ${table.latestRevision})`,
    ),
    check(
      'catalog_local_override_heads_lifecycle_ck',
      sql`(${table.lifecycle} = 'ACTIVE' and ${table.activeRevision} = ${table.latestRevision}) or (${table.lifecycle} = 'RELEASED' and ${table.activeRevision} is null)`,
    ),
    ...tenantRlsPolicies('catalog_local_override_heads_tenant', table.tenantId),
  ],
);

export const brands = catalogSchema.table.withRLS(
  'brands',
  {
    brandId: uuid('brand_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    name: text('name').notNull(),
    lifecycleState: text('lifecycle_state').notNull(),
    currentRevision: integer('current_revision').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('catalog_brands_scope_id_uk').on(table.tenantId, table.brandId),
    check(
      'catalog_brands_name_ck',
      sql`${table.name} = btrim(${table.name}) and length(${table.name}) between 1 and 240`,
    ),
    check('catalog_brands_lifecycle_ck', sql`${table.lifecycleState} in ('ACTIVE', 'RETIRED')`),
    check('catalog_brands_revision_ck', sql`${table.currentRevision} > 0`),
    ...tenantRlsPolicies('catalog_brands_tenant', table.tenantId),
  ],
);

export const brandRevisions = catalogSchema.table.withRLS(
  'brand_revisions',
  {
    tenantId: uuid('tenant_id').notNull(),
    brandId: uuid('brand_id').notNull(),
    revision: integer('revision').notNull(),
    name: text('name').notNull(),
    lifecycleState: text('lifecycle_state').notNull(),
    changeKind: text('change_kind').notNull(),
    reason: text('reason').notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.brandId, table.revision], name: 'catalog_brand_revisions_pk' }),
    unique('catalog_brand_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.brandId],
      foreignColumns: [brands.tenantId, brands.brandId],
      name: 'catalog_brand_revisions_brand_fk',
    }).onDelete('restrict'),
    check('catalog_brand_revisions_revision_ck', sql`${table.revision} > 0`),
    check(
      'catalog_brand_revisions_name_ck',
      sql`${table.name} = btrim(${table.name}) and length(${table.name}) between 1 and 240`,
    ),
    check('catalog_brand_revisions_lifecycle_ck', sql`${table.lifecycleState} in ('ACTIVE', 'RETIRED')`),
    check(
      'catalog_brand_revisions_kind_ck',
      sql`${table.changeKind} in ('CREATED', 'RENAMED', 'RETIRED', 'REACTIVATED')`,
    ),
    check(
      'catalog_brand_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_brand_revisions_tenant', table.tenantId),
  ],
);

/** Tenant-wide Unit identity is stable while purchase rules advance by revision. */
export const productUnits = catalogSchema.table.withRLS(
  'product_units',
  {
    unitId: uuid('unit_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    code: text('code').notNull(),
    label: text('label').notNull(),
    lifecycleState: text('lifecycle_state').notNull(),
    currentRuleRevision: integer('current_rule_revision').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('catalog_product_units_scope_id_uk').on(table.tenantId, table.unitId),
    unique('catalog_product_units_code_uk').on(table.tenantId, table.code),
    check('catalog_product_units_revision_ck', sql`${table.currentRuleRevision} > 0`),
    check(
      'catalog_product_units_code_ck',
      sql`${table.code} = btrim(${table.code}) and length(${table.code}) between 1 and 80`,
    ),
    check(
      'catalog_product_units_label_ck',
      sql`${table.label} = btrim(${table.label}) and length(${table.label}) between 1 and 240`,
    ),
    check('catalog_product_units_lifecycle_ck', sql`${table.lifecycleState} in ('ACTIVE', 'RETIRED')`),
    ...tenantRlsPolicies('catalog_product_units_tenant', table.tenantId),
  ],
);

/** Configuration measurement has its own meaning; purchase Quantity Units are not aliases. */
export const configurationUnits = catalogSchema.table.withRLS(
  'configuration_units',
  {
    unitId: uuid('unit_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    code: text('code').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('catalog_configuration_units_scope_id_uk').on(table.tenantId, table.unitId),
    unique('catalog_configuration_units_code_uk').on(table.tenantId, table.code),
    check(
      'catalog_configuration_units_code_ck',
      sql`${table.code} = btrim(${table.code}) and length(${table.code}) between 1 and 80`,
    ),
    ...tenantRlsPolicies('catalog_configuration_units_tenant', table.tenantId),
  ],
);

/** Append-only owner evidence; Current is proved from effective windows, never from latest. */
export const configurationUnitRevisions = catalogSchema.table.withRLS(
  'configuration_unit_revisions',
  {
    tenantId: uuid('tenant_id').notNull(),
    unitId: uuid('unit_id').notNull(),
    revision: integer('revision').notNull(),
    meaning: text('meaning').notNull(),
    dimension: text('dimension').notNull(),
    lifecycleState: text('lifecycle_state').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    reason: text('reason').notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.unitId, table.revision],
      name: 'catalog_configuration_unit_revisions_pk',
    }),
    unique('catalog_configuration_unit_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.unitId],
      foreignColumns: [configurationUnits.tenantId, configurationUnits.unitId],
      name: 'catalog_configuration_unit_revisions_unit_fk',
    }).onDelete('restrict'),
    check('catalog_configuration_unit_revisions_number_ck', sql`${table.revision} > 0`),
    check(
      'catalog_configuration_unit_revisions_meaning_ck',
      sql`${table.meaning} = btrim(${table.meaning}) and length(${table.meaning}) between 1 and 1000`,
    ),
    check(
      'catalog_configuration_unit_revisions_dimension_ck',
      sql`${table.dimension} = btrim(${table.dimension}) and length(${table.dimension}) between 1 and 160`,
    ),
    check('catalog_configuration_unit_revisions_lifecycle_ck', sql`${table.lifecycleState} in ('ACTIVE', 'RETIRED')`),
    check(
      'catalog_configuration_unit_revisions_window_ck',
      sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    check(
      'catalog_configuration_unit_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_configuration_unit_revisions_tenant', table.tenantId),
  ],
);

export const productUnitRuleRevisions = catalogSchema.table.withRLS(
  'product_unit_rule_revisions',
  {
    tenantId: uuid('tenant_id').notNull(),
    unitId: uuid('unit_id').notNull(),
    revision: integer('revision').notNull(),
    step: numeric('step').notNull(),
    rounding: text('rounding').notNull(),
    lifecycleState: text('lifecycle_state').notNull(),
    changeKind: text('change_kind').notNull(),
    reason: text('reason').notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.unitId, table.revision],
      name: 'catalog_product_unit_rule_revisions_pk',
    }),
    unique('catalog_product_unit_rule_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.unitId],
      foreignColumns: [productUnits.tenantId, productUnits.unitId],
      name: 'catalog_product_unit_rule_revisions_unit_fk',
    }).onDelete('restrict'),
    check('catalog_product_unit_rule_revisions_number_ck', sql`${table.revision} > 0`),
    check('catalog_product_unit_rule_revisions_step_ck', sql`${table.step} > 0`),
    check('catalog_product_unit_rule_revisions_rounding_ck', sql`${table.rounding} in ('UP', 'DOWN', 'HALF_UP')`),
    check('catalog_product_unit_rule_revisions_lifecycle_ck', sql`${table.lifecycleState} in ('ACTIVE', 'RETIRED')`),
    check('catalog_product_unit_rule_revisions_kind_ck', sql`${table.changeKind} in ('CREATED', 'REVISED', 'RETIRED')`),
    check(
      'catalog_product_unit_rule_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_product_unit_rule_revisions_tenant', table.tenantId),
  ],
);

export const products = catalogSchema.table.withRLS(
  'products',
  {
    productId: uuid('product_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    lifecycleState: text('lifecycle_state').default('DRAFT').notNull(),
    currentRevision: integer('current_revision').default(1).notNull(),
    name: text('name'),
    description: text('description'),
    retiredEffectiveAt: timestamp('retired_effective_at', { withTimezone: true }),
    retiredReason: text('retired_reason'),
    createdByActionInvocationId: uuid('created_by_action_invocation_id').notNull(),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('catalog_products_scope_id_uk').on(table.tenantId, table.productId),
    index('catalog_products_tenant_lifecycle_idx').on(table.tenantId, table.lifecycleState),
    index('catalog_products_tenant_name_idx').on(table.tenantId, table.name),
    check('catalog_products_lifecycle_ck', sql`${table.lifecycleState} in ('DRAFT', 'ACTIVE', 'RETIRED')`),
    check('catalog_products_revision_ck', sql`${table.currentRevision} > 0`),
    check(
      'catalog_products_name_ck',
      sql`${table.name} is null or (${table.name} = btrim(${table.name}) and length(${table.name}) between 1 and 240)`,
    ),
    check(
      'catalog_products_description_ck',
      sql`${table.description} is null or (${table.description} = btrim(${table.description}) and length(${table.description}) <= 4000)`,
    ),
    check(
      'catalog_products_retirement_ck',
      sql`(${table.lifecycleState} <> 'RETIRED' and ${table.retiredEffectiveAt} is null and ${table.retiredReason} is null) or (${table.lifecycleState} = 'RETIRED' and ${table.retiredEffectiveAt} is not null and ${table.retiredReason} is not null and ${table.retiredReason} = btrim(${table.retiredReason}) and length(${table.retiredReason}) between 1 and 1000)`,
    ),
    ...tenantRlsPolicies('catalog_products_tenant', table.tenantId),
  ],
);

export const productBrandAssignments = catalogSchema.table.withRLS(
  'product_brand_assignments',
  {
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    currentRevision: integer('current_revision').notNull(),
    claimKind: text('claim_kind').notNull(),
    brandId: uuid('brand_id'),
    evidenceRef: text('evidence_ref'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.productId], name: 'catalog_product_brand_assignments_pk' }),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.productId],
      name: 'catalog_product_brand_assignments_product_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.brandId],
      foreignColumns: [brands.tenantId, brands.brandId],
      name: 'catalog_product_brand_assignments_brand_fk',
    }).onDelete('restrict'),
    check('catalog_product_brand_assignments_revision_ck', sql`${table.currentRevision} > 0`),
    check(
      'catalog_product_brand_assignments_claim_ck',
      sql`(${table.claimKind} = 'UNKNOWN' and ${table.brandId} is null and ${table.evidenceRef} is null) or (${table.claimKind} = 'CONFIRMED_UNBRANDED' and ${table.brandId} is null and ${table.evidenceRef} is not null) or (${table.claimKind} = 'BRANDED' and ${table.brandId} is not null and ${table.evidenceRef} is not null)`,
    ),
    check(
      'catalog_product_brand_assignments_evidence_ck',
      sql`${table.evidenceRef} is null or (${table.evidenceRef} = btrim(${table.evidenceRef}) and length(${table.evidenceRef}) between 1 and 1000)`,
    ),
    ...tenantRlsPolicies('catalog_product_brand_assignments_tenant', table.tenantId),
  ],
);

export const productBrandAssignmentRevisions = catalogSchema.table.withRLS(
  'product_brand_assignment_revisions',
  {
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    revision: integer('revision').notNull(),
    claimKind: text('claim_kind').notNull(),
    brandId: uuid('brand_id'),
    evidenceRef: text('evidence_ref'),
    reason: text('reason').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.productId, table.revision],
      name: 'catalog_product_brand_assignment_revisions_pk',
    }),
    unique('catalog_product_brand_assignment_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [productBrandAssignments.tenantId, productBrandAssignments.productId],
      name: 'catalog_product_brand_assignment_revisions_assignment_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.brandId],
      foreignColumns: [brands.tenantId, brands.brandId],
      name: 'catalog_product_brand_assignment_revisions_brand_fk',
    }).onDelete('restrict'),
    check('catalog_product_brand_assignment_revisions_number_ck', sql`${table.revision} > 0`),
    check(
      'catalog_product_brand_assignment_revisions_claim_ck',
      sql`(${table.claimKind} = 'UNKNOWN' and ${table.brandId} is null and ${table.evidenceRef} is null) or (${table.claimKind} = 'CONFIRMED_UNBRANDED' and ${table.brandId} is null and ${table.evidenceRef} is not null) or (${table.claimKind} = 'BRANDED' and ${table.brandId} is not null and ${table.evidenceRef} is not null)`,
    ),
    check(
      'catalog_product_brand_assignment_revisions_evidence_ck',
      sql`${table.evidenceRef} is null or (${table.evidenceRef} = btrim(${table.evidenceRef}) and length(${table.evidenceRef}) between 1 and 1000)`,
    ),
    check(
      'catalog_product_brand_assignment_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_product_brand_assignment_revisions_tenant', table.tenantId),
  ],
);

export const productVariantAxisEvents = catalogSchema.table.withRLS(
  'product_variant_axis_events',
  {
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    axisRevision: integer('axis_revision').notNull(),
    attributeDefinitionIds: uuid('attribute_definition_ids').array().notNull(),
    attributeDefinitionRevisions: integer('attribute_definition_revisions').array(),
    reason: text('reason').notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.productId, table.axisRevision],
      name: 'catalog_product_variant_axis_events_pk',
    }),
    unique('catalog_product_variant_axis_events_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.productId],
      name: 'catalog_product_variant_axis_events_product_fk',
    }).onDelete('restrict'),
    check('catalog_product_variant_axis_events_revision_ck', sql`${table.axisRevision} > 0`),
    check(
      'catalog_product_variant_axis_events_null_free_ck',
      sql`array_position(${table.attributeDefinitionIds}, null) is null`,
    ),
    check(
      'catalog_product_variant_axis_events_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_product_variant_axis_events_tenant', table.tenantId),
  ],
);

/** Exact-locale factual copy; absent rows and REMOVED rows never imply a locale. */
export const productLocalizedFacts = catalogSchema.table.withRLS(
  'product_localized_facts',
  {
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    locale: text('locale').notNull(),
    currentRevision: integer('current_revision').notNull(),
    state: text('state').notNull(),
    name: text('name'),
    description: text('description'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.productId, table.locale],
      name: 'catalog_product_localized_facts_pk',
    }),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.productId],
      name: 'catalog_product_localized_facts_product_fk',
    }).onDelete('restrict'),
    check(
      'catalog_product_localized_facts_locale_ck',
      sql`${table.locale} = btrim(${table.locale}) and length(${table.locale}) between 2 and 64`,
    ),
    check('catalog_product_localized_facts_revision_ck', sql`${table.currentRevision} > 0`),
    check('catalog_product_localized_facts_state_ck', sql`${table.state} in ('SET', 'REMOVED')`),
    check(
      'catalog_product_localized_facts_name_ck',
      sql`${table.name} is null or (${table.name} = btrim(${table.name}) and length(${table.name}) between 1 and 240)`,
    ),
    check(
      'catalog_product_localized_facts_description_ck',
      sql`${table.description} is null or (${table.description} = btrim(${table.description}) and length(${table.description}) between 1 and 4000)`,
    ),
    check(
      'catalog_product_localized_facts_shape_ck',
      sql`(${table.state} = 'SET' and (${table.name} is not null or ${table.description} is not null)) or (${table.state} = 'REMOVED' and ${table.name} is null and ${table.description} is null)`,
    ),
    ...tenantRlsPolicies('catalog_product_localized_facts_tenant', table.tenantId),
  ],
);

export const productLocalizedFactRevisions = catalogSchema.table.withRLS(
  'product_localized_fact_revisions',
  {
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    locale: text('locale').notNull(),
    revision: integer('revision').notNull(),
    state: text('state').notNull(),
    name: text('name'),
    description: text('description'),
    reason: text('reason').notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.productId, table.locale, table.revision],
      name: 'catalog_product_localized_fact_revisions_pk',
    }),
    unique('catalog_product_localized_fact_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.productId, table.locale],
      foreignColumns: [productLocalizedFacts.tenantId, productLocalizedFacts.productId, productLocalizedFacts.locale],
      name: 'catalog_product_localized_fact_revisions_fact_fk',
    }).onDelete('restrict'),
    check('catalog_product_localized_fact_revisions_revision_ck', sql`${table.revision} > 0`),
    check('catalog_product_localized_fact_revisions_state_ck', sql`${table.state} in ('SET', 'REMOVED')`),
    check(
      'catalog_product_localized_fact_revisions_name_ck',
      sql`${table.name} is null or (${table.name} = btrim(${table.name}) and length(${table.name}) between 1 and 240)`,
    ),
    check(
      'catalog_product_localized_fact_revisions_description_ck',
      sql`${table.description} is null or (${table.description} = btrim(${table.description}) and length(${table.description}) between 1 and 4000)`,
    ),
    check(
      'catalog_product_localized_fact_revisions_shape_ck',
      sql`(${table.state} = 'SET' and (${table.name} is not null or ${table.description} is not null)) or (${table.state} = 'REMOVED' and ${table.name} is null and ${table.description} is null)`,
    ),
    check(
      'catalog_product_localized_fact_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_product_localized_fact_revisions_tenant', table.tenantId),
  ],
);

export const productVariants = catalogSchema.table.withRLS(
  'product_variants',
  {
    variantId: uuid('variant_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    lifecycleState: text('lifecycle_state').default('WORK_IN_PROGRESS').notNull(),
    currentRevision: integer('current_revision').default(1).notNull(),
    combinationKey: text('combination_key'),
    combinationAxisRevision: integer('combination_axis_revision'),
    createdByActionInvocationId: uuid('created_by_action_invocation_id').notNull(),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('catalog_product_variants_scope_id_uk').on(table.tenantId, table.variantId),
    unique('catalog_product_variants_product_id_variant_id_uk').on(table.tenantId, table.productId, table.variantId),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.productId],
      name: 'catalog_product_variants_product_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.productId, table.combinationAxisRevision],
      foreignColumns: [
        productVariantAxisEvents.tenantId,
        productVariantAxisEvents.productId,
        productVariantAxisEvents.axisRevision,
      ],
      name: 'catalog_product_variants_axis_revision_fk',
    }).onDelete('restrict'),
    index('catalog_product_variants_product_idx').on(table.tenantId, table.productId, table.lifecycleState),
    uniqueIndex('catalog_product_variants_active_combination_uk')
      .on(table.tenantId, table.productId, table.combinationKey)
      .where(sql`${table.lifecycleState} = 'ACTIVE'`),
    check('catalog_product_variants_revision_ck', sql`${table.currentRevision} > 0`),
    check(
      'catalog_product_variants_axis_revision_ck',
      sql`${table.combinationAxisRevision} is null or ${table.combinationAxisRevision} > 0`,
    ),
    check(
      'catalog_product_variants_combination_ck',
      sql`(${table.lifecycleState} = 'ACTIVE' and ${table.combinationKey} is not null and ${table.combinationAxisRevision} is not null and length(${table.combinationKey}) = 64 and ${table.combinationKey} ~ '^[0-9a-f]{64}$') or (${table.lifecycleState} <> 'ACTIVE' and ${table.combinationKey} is null and ${table.combinationAxisRevision} is null)`,
    ),
    check(
      'catalog_product_variants_lifecycle_ck',
      sql`${table.lifecycleState} in ('WORK_IN_PROGRESS', 'ACTIVE', 'RETIRED')`,
    ),
    ...tenantRlsPolicies('catalog_product_variants_tenant', table.tenantId),
  ],
);

/** One composition Resource belongs to exactly one ordinary Product Variant. */
export const setCompositions = catalogSchema.table.withRLS(
  'set_compositions',
  {
    compositionId: uuid('composition_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    currentRevision: integer('current_revision').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('catalog_set_compositions_scope_id_uk').on(table.tenantId, table.compositionId),
    unique('catalog_set_compositions_variant_uk').on(table.tenantId, table.productId, table.variantId),
    unique('catalog_set_compositions_target_uk').on(
      table.tenantId,
      table.productId,
      table.variantId,
      table.compositionId,
    ),
    foreignKey({
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.variantId],
      name: 'catalog_set_compositions_variant_fk',
    }).onDelete('restrict'),
    check('catalog_set_compositions_revision_ck', sql`${table.currentRevision} > 0`),
    ...tenantRlsPolicies('catalog_set_compositions_tenant', table.tenantId),
  ],
);

/** Immutable content authority; a correction also appends a new numbered revision. */
export const setCompositionRevisions = catalogSchema.table.withRLS(
  'set_composition_revisions',
  {
    tenantId: uuid('tenant_id').notNull(),
    compositionId: uuid('composition_id').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    revision: integer('revision').notNull(),
    predecessorRevision: integer('predecessor_revision'),
    lifecycleState: text('lifecycle_state').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    changeKind: text('change_kind').notNull(),
    reason: text('reason').notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.compositionId, table.revision],
      name: 'catalog_set_composition_revisions_pk',
    }),
    unique('catalog_set_composition_revisions_target_uk').on(
      table.tenantId,
      table.productId,
      table.variantId,
      table.compositionId,
      table.revision,
    ),
    unique('catalog_set_composition_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.productId, table.variantId, table.compositionId],
      foreignColumns: [
        setCompositions.tenantId,
        setCompositions.productId,
        setCompositions.variantId,
        setCompositions.compositionId,
      ],
      name: 'catalog_set_composition_revisions_composition_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.compositionId, table.predecessorRevision],
      foreignColumns: [table.tenantId, table.compositionId, table.revision],
      name: 'catalog_set_composition_revisions_predecessor_fk',
    }).onDelete('restrict'),
    check('catalog_set_composition_revisions_number_ck', sql`${table.revision} > 0`),
    check(
      'catalog_set_composition_revisions_predecessor_ck',
      sql`(${table.revision} = 1 and ${table.predecessorRevision} is null) or (${table.revision} > 1 and ${table.predecessorRevision} = ${table.revision} - 1)`,
    ),
    check(
      'catalog_set_composition_revisions_period_ck',
      sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    check('catalog_set_composition_revisions_state_ck', sql`${table.lifecycleState} in ('DRAFT', 'ACTIVE', 'RETIRED')`),
    check(
      'catalog_set_composition_revisions_kind_ck',
      sql`${table.changeKind} in ('INITIAL', 'MATERIAL_CHANGE', 'EVIDENCE_CORRECTION')`,
    ),
    check(
      'catalog_set_composition_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_set_composition_revisions_tenant', table.tenantId),
  ],
);

export const variantLocalizedFacts = catalogSchema.table.withRLS(
  'variant_localized_facts',
  {
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    locale: text('locale').notNull(),
    currentRevision: integer('current_revision').notNull(),
    state: text('state').notNull(),
    name: text('name'),
    description: text('description'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.productId, table.variantId, table.locale],
      name: 'catalog_variant_localized_facts_pk',
    }),
    foreignKey({
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.variantId],
      name: 'catalog_variant_localized_facts_variant_fk',
    }).onDelete('restrict'),
    check(
      'catalog_variant_localized_facts_locale_ck',
      sql`${table.locale} = btrim(${table.locale}) and length(${table.locale}) between 2 and 64`,
    ),
    check('catalog_variant_localized_facts_revision_ck', sql`${table.currentRevision} > 0`),
    check('catalog_variant_localized_facts_state_ck', sql`${table.state} in ('SET', 'REMOVED')`),
    check(
      'catalog_variant_localized_facts_name_ck',
      sql`${table.name} is null or (${table.name} = btrim(${table.name}) and length(${table.name}) between 1 and 240)`,
    ),
    check(
      'catalog_variant_localized_facts_description_ck',
      sql`${table.description} is null or (${table.description} = btrim(${table.description}) and length(${table.description}) between 1 and 4000)`,
    ),
    check(
      'catalog_variant_localized_facts_shape_ck',
      sql`(${table.state} = 'SET' and (${table.name} is not null or ${table.description} is not null)) or (${table.state} = 'REMOVED' and ${table.name} is null and ${table.description} is null)`,
    ),
    ...tenantRlsPolicies('catalog_variant_localized_facts_tenant', table.tenantId),
  ],
);

export const variantLocalizedFactRevisions = catalogSchema.table.withRLS(
  'variant_localized_fact_revisions',
  {
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    locale: text('locale').notNull(),
    revision: integer('revision').notNull(),
    state: text('state').notNull(),
    name: text('name'),
    description: text('description'),
    reason: text('reason').notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.productId, table.variantId, table.locale, table.revision],
      name: 'catalog_variant_localized_fact_revisions_pk',
    }),
    unique('catalog_variant_localized_fact_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.productId, table.variantId, table.locale],
      foreignColumns: [
        variantLocalizedFacts.tenantId,
        variantLocalizedFacts.productId,
        variantLocalizedFacts.variantId,
        variantLocalizedFacts.locale,
      ],
      name: 'catalog_variant_localized_fact_revisions_fact_fk',
    }).onDelete('restrict'),
    check('catalog_variant_localized_fact_revisions_revision_ck', sql`${table.revision} > 0`),
    check('catalog_variant_localized_fact_revisions_state_ck', sql`${table.state} in ('SET', 'REMOVED')`),
    check(
      'catalog_variant_localized_fact_revisions_name_ck',
      sql`${table.name} is null or (${table.name} = btrim(${table.name}) and length(${table.name}) between 1 and 240)`,
    ),
    check(
      'catalog_variant_localized_fact_revisions_description_ck',
      sql`${table.description} is null or (${table.description} = btrim(${table.description}) and length(${table.description}) between 1 and 4000)`,
    ),
    check(
      'catalog_variant_localized_fact_revisions_shape_ck',
      sql`(${table.state} = 'SET' and (${table.name} is not null or ${table.description} is not null)) or (${table.state} = 'REMOVED' and ${table.name} is null and ${table.description} is null)`,
    ),
    check(
      'catalog_variant_localized_fact_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_variant_localized_fact_revisions_tenant', table.tenantId),
  ],
);

export const productVariantRevisions = catalogSchema.table.withRLS(
  'product_variant_revisions',
  {
    tenantId: uuid('tenant_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    productId: uuid('product_id').notNull(),
    revision: integer('revision').notNull(),
    lifecycleState: text('lifecycle_state').notNull(),
    combinationKey: text('combination_key'),
    combinationAxisRevision: integer('combination_axis_revision'),
    changeKind: text('change_kind').notNull(),
    reason: text('reason').notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.variantId, table.revision],
      name: 'catalog_product_variant_revisions_pk',
    }),
    unique('catalog_product_variant_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.variantId],
      name: 'catalog_product_variant_revisions_variant_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.productId],
      name: 'catalog_product_variant_revisions_product_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.productId, table.combinationAxisRevision],
      foreignColumns: [
        productVariantAxisEvents.tenantId,
        productVariantAxisEvents.productId,
        productVariantAxisEvents.axisRevision,
      ],
      name: 'catalog_product_variant_revisions_axis_revision_fk',
    }).onDelete('restrict'),
    check('catalog_product_variant_revisions_number_ck', sql`${table.revision} > 0`),
    check(
      'catalog_product_variant_revisions_lifecycle_ck',
      sql`${table.lifecycleState} in ('WORK_IN_PROGRESS', 'ACTIVE', 'RETIRED')`,
    ),
    check(
      'catalog_product_variant_revisions_kind_ck',
      sql`${table.changeKind} in ('CREATED', 'CORRECTED', 'LIFECYCLE', 'PARENT_CORRECTION', 'AXIS_REVALIDATION')`,
    ),
    check(
      'catalog_product_variant_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_product_variant_revisions_tenant', table.tenantId),
  ],
);

/** The directed assertion is independent of a set or a substitution rule. */
export const productRelationships = catalogSchema.table.withRLS(
  'product_relationships',
  {
    relationshipId: uuid('relationship_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    relationshipType: text('relationship_type').notNull(),
    sourceProductId: uuid('source_product_id'),
    sourceVariantId: uuid('source_variant_id'),
    targetProductId: uuid('target_product_id'),
    targetVariantId: uuid('target_variant_id'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    currentRevision: integer('current_revision').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('catalog_product_relationships_scope_id_uk').on(table.tenantId, table.relationshipId),
    unique('catalog_product_relationships_exact_uk')
      .on(
        table.tenantId,
        table.relationshipType,
        table.sourceProductId,
        table.sourceVariantId,
        table.targetProductId,
        table.targetVariantId,
        table.effectiveFrom,
        table.effectiveTo,
      )
      .nullsNotDistinct(),
    foreignKey({
      columns: [table.tenantId, table.sourceProductId],
      foreignColumns: [products.tenantId, products.productId],
      name: 'catalog_product_relationships_source_product_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.sourceVariantId],
      foreignColumns: [productVariants.tenantId, productVariants.variantId],
      name: 'catalog_product_relationships_source_variant_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.targetProductId],
      foreignColumns: [products.tenantId, products.productId],
      name: 'catalog_product_relationships_target_product_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.targetVariantId],
      foreignColumns: [productVariants.tenantId, productVariants.variantId],
      name: 'catalog_product_relationships_target_variant_fk',
    }).onDelete('restrict'),
    index('catalog_product_relationships_source_product_idx').on(table.tenantId, table.sourceProductId),
    index('catalog_product_relationships_source_variant_idx').on(table.tenantId, table.sourceVariantId),
    index('catalog_product_relationships_target_product_idx').on(table.tenantId, table.targetProductId),
    index('catalog_product_relationships_target_variant_idx').on(table.tenantId, table.targetVariantId),
    check(
      'catalog_product_relationships_type_ck',
      sql`${table.relationshipType} in ('ACCESSORY_FOR', 'RELATED_PRODUCT', 'SUCCESSOR')`,
    ),
    check(
      'catalog_product_relationships_source_ck',
      sql`num_nonnulls(${table.sourceProductId}, ${table.sourceVariantId}) = 1`,
    ),
    check(
      'catalog_product_relationships_target_ck',
      sql`num_nonnulls(${table.targetProductId}, ${table.targetVariantId}) = 1`,
    ),
    check(
      'catalog_product_relationships_self_ck',
      sql`${table.sourceProductId} is distinct from ${table.targetProductId} or ${table.sourceVariantId} is distinct from ${table.targetVariantId}`,
    ),
    check(
      'catalog_product_relationships_period_ck',
      sql`${table.effectiveFrom} is null or ${table.effectiveTo} is null or ${table.effectiveFrom} < ${table.effectiveTo}`,
    ),
    check('catalog_product_relationships_revision_ck', sql`${table.currentRevision} > 0`),
    ...tenantRlsPolicies('catalog_product_relationships_tenant', table.tenantId),
  ],
);

export const productRelationshipRevisions = catalogSchema.table.withRLS(
  'product_relationship_revisions',
  {
    tenantId: uuid('tenant_id').notNull(),
    relationshipId: uuid('relationship_id').notNull(),
    revision: integer('revision').notNull(),
    relationshipType: text('relationship_type').notNull(),
    sourceProductId: uuid('source_product_id'),
    sourceVariantId: uuid('source_variant_id'),
    targetProductId: uuid('target_product_id'),
    targetVariantId: uuid('target_variant_id'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    changeKind: text('change_kind').notNull(),
    reason: text('reason').notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.relationshipId, table.revision],
      name: 'catalog_product_relationship_revisions_pk',
    }),
    unique('catalog_product_relationship_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.relationshipId],
      foreignColumns: [productRelationships.tenantId, productRelationships.relationshipId],
      name: 'catalog_product_relationship_revisions_relationship_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.sourceProductId],
      foreignColumns: [products.tenantId, products.productId],
      name: 'catalog_product_relationship_revisions_source_product_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.sourceVariantId],
      foreignColumns: [productVariants.tenantId, productVariants.variantId],
      name: 'catalog_product_relationship_revisions_source_variant_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.targetProductId],
      foreignColumns: [products.tenantId, products.productId],
      name: 'catalog_product_relationship_revisions_target_product_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.targetVariantId],
      foreignColumns: [productVariants.tenantId, productVariants.variantId],
      name: 'catalog_product_relationship_revisions_target_variant_fk',
    }).onDelete('restrict'),
    check('catalog_product_relationship_revisions_revision_ck', sql`${table.revision} > 0`),
    check(
      'catalog_product_relationship_revisions_type_ck',
      sql`${table.relationshipType} in ('ACCESSORY_FOR', 'RELATED_PRODUCT', 'SUCCESSOR')`,
    ),
    check(
      'catalog_product_relationship_revisions_source_ck',
      sql`num_nonnulls(${table.sourceProductId}, ${table.sourceVariantId}) = 1`,
    ),
    check(
      'catalog_product_relationship_revisions_target_ck',
      sql`num_nonnulls(${table.targetProductId}, ${table.targetVariantId}) = 1`,
    ),
    check(
      'catalog_product_relationship_revisions_self_ck',
      sql`${table.sourceProductId} is distinct from ${table.targetProductId} or ${table.sourceVariantId} is distinct from ${table.targetVariantId}`,
    ),
    check(
      'catalog_product_relationship_revisions_period_ck',
      sql`${table.effectiveFrom} is null or ${table.effectiveTo} is null or ${table.effectiveFrom} < ${table.effectiveTo}`,
    ),
    check(
      'catalog_product_relationship_revisions_kind_ck',
      sql`${table.changeKind} in ('CREATED', 'CORRECTED', 'ENDED')`,
    ),
    check(
      'catalog_product_relationship_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    check(
      'catalog_product_relationship_revisions_evidence_ck',
      sql`cardinality(${table.evidenceRefs}) > 0 and array_position(${table.evidenceRefs}, null) is null`,
    ),
    ...tenantRlsPolicies('catalog_product_relationship_revisions_tenant', table.tenantId),
  ],
);

/** A Package Option is a selectable role of this identity, never a second Resource. */
export const packageDefinitions = catalogSchema.table.withRLS(
  'package_definitions',
  {
    packageDefinitionId: uuid('package_definition_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    lifecycleState: text('lifecycle_state').default('DRAFT').notNull(),
    optionState: text('option_state').default('NOT_SELECTABLE').notNull(),
    currentOptionRevision: integer('current_option_revision').default(0).notNull(),
    currentRevision: integer('current_revision').default(1).notNull(),
    createdByActionInvocationId: uuid('created_by_action_invocation_id').notNull(),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('catalog_package_definitions_scope_id_uk').on(table.tenantId, table.packageDefinitionId),
    unique('catalog_package_definitions_form_id_uk').on(
      table.tenantId,
      table.productId,
      table.variantId,
      table.packageDefinitionId,
    ),
    foreignKey({
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.variantId],
      name: 'catalog_package_definitions_variant_fk',
    }).onDelete('restrict'),
    index('catalog_package_definitions_variant_idx').on(table.tenantId, table.productId, table.variantId),
    check('catalog_package_definitions_revision_ck', sql`${table.currentRevision} > 0`),
    check('catalog_package_definitions_option_revision_ck', sql`${table.currentOptionRevision} >= 0`),
    check('catalog_package_definitions_state_ck', sql`${table.lifecycleState} in ('DRAFT', 'ACTIVE', 'RETIRED')`),
    check(
      'catalog_package_definitions_option_ck',
      sql`${table.optionState} in ('NOT_SELECTABLE', 'ACTIVE', 'RETIRED')`,
    ),
    ...tenantRlsPolicies('catalog_package_definitions_tenant', table.tenantId),
  ],
);

/** Divisibility is owned by the selectable Variant, not the shared Unit. */
export const variantUnitDivisibility = catalogSchema.table.withRLS(
  'variant_unit_divisibility',
  {
    tenantId: uuid('tenant_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    unitId: uuid('unit_id').notNull(),
    currentRevision: integer('current_revision').notNull(),
    divisible: boolean('divisible').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.variantId], name: 'catalog_variant_unit_divisibility_pk' }),
    foreignKey({
      columns: [table.tenantId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.variantId],
      name: 'catalog_variant_unit_divisibility_variant_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.unitId],
      foreignColumns: [productUnits.tenantId, productUnits.unitId],
      name: 'catalog_variant_unit_divisibility_unit_fk',
    }).onDelete('restrict'),
    check('catalog_variant_unit_divisibility_revision_ck', sql`${table.currentRevision} > 0`),
    ...tenantRlsPolicies('catalog_variant_unit_divisibility_tenant', table.tenantId),
  ],
);

export const variantUnitDivisibilityRevisions = catalogSchema.table.withRLS(
  'variant_unit_divisibility_revisions',
  {
    tenantId: uuid('tenant_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    revision: integer('revision').notNull(),
    unitId: uuid('unit_id').notNull(),
    divisible: boolean('divisible').notNull(),
    reason: text('reason').notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.variantId, table.revision],
      name: 'catalog_variant_unit_divisibility_revisions_pk',
    }),
    unique('catalog_variant_unit_divisibility_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.variantId],
      foreignColumns: [variantUnitDivisibility.tenantId, variantUnitDivisibility.variantId],
      name: 'catalog_variant_unit_divisibility_revisions_target_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.unitId],
      foreignColumns: [productUnits.tenantId, productUnits.unitId],
      name: 'catalog_variant_unit_divisibility_revisions_unit_fk',
    }).onDelete('restrict'),
    check('catalog_variant_unit_divisibility_revisions_number_ck', sql`${table.revision} > 0`),
    check(
      'catalog_variant_unit_divisibility_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_variant_unit_divisibility_revisions_tenant', table.tenantId),
  ],
);

export const packageUnitDivisibility = catalogSchema.table.withRLS(
  'package_unit_divisibility',
  {
    tenantId: uuid('tenant_id').notNull(),
    packageDefinitionId: uuid('package_definition_id').notNull(),
    unitId: uuid('unit_id').notNull(),
    currentRevision: integer('current_revision').notNull(),
    divisible: boolean('divisible').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.packageDefinitionId], name: 'catalog_package_unit_divisibility_pk' }),
    foreignKey({
      columns: [table.tenantId, table.packageDefinitionId],
      foreignColumns: [packageDefinitions.tenantId, packageDefinitions.packageDefinitionId],
      name: 'catalog_package_unit_divisibility_package_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.unitId],
      foreignColumns: [productUnits.tenantId, productUnits.unitId],
      name: 'catalog_package_unit_divisibility_unit_fk',
    }).onDelete('restrict'),
    check('catalog_package_unit_divisibility_revision_ck', sql`${table.currentRevision} > 0`),
    ...tenantRlsPolicies('catalog_package_unit_divisibility_tenant', table.tenantId),
  ],
);

export const packageUnitDivisibilityRevisions = catalogSchema.table.withRLS(
  'package_unit_divisibility_revisions',
  {
    tenantId: uuid('tenant_id').notNull(),
    packageDefinitionId: uuid('package_definition_id').notNull(),
    revision: integer('revision').notNull(),
    unitId: uuid('unit_id').notNull(),
    divisible: boolean('divisible').notNull(),
    reason: text('reason').notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.packageDefinitionId, table.revision],
      name: 'catalog_package_unit_divisibility_revisions_pk',
    }),
    unique('catalog_package_unit_divisibility_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.packageDefinitionId],
      foreignColumns: [packageUnitDivisibility.tenantId, packageUnitDivisibility.packageDefinitionId],
      name: 'catalog_package_unit_divisibility_revisions_target_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.unitId],
      foreignColumns: [productUnits.tenantId, productUnits.unitId],
      name: 'catalog_package_unit_divisibility_revisions_unit_fk',
    }).onDelete('restrict'),
    check('catalog_package_unit_divisibility_revisions_number_ck', sql`${table.revision} > 0`),
    check(
      'catalog_package_unit_divisibility_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_package_unit_divisibility_revisions_tenant', table.tenantId),
  ],
);

/** The complete, immutable content basis; lower levels bind an exact revision, not latest. */
export const packageContentRevisions = catalogSchema.table.withRLS(
  'package_content_revisions',
  {
    tenantId: uuid('tenant_id').notNull(),
    packageDefinitionId: uuid('package_definition_id').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    revision: integer('revision').notNull(),
    lifecycleState: text('lifecycle_state').notNull(),
    amount: numeric('amount').notNull(),
    unitResourceType: text('unit_resource_type').notNull(),
    unitResourceId: uuid('unit_resource_id').notNull(),
    configurationKey: text('configuration_key'),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    lowerPackageDefinitionId: uuid('lower_package_definition_id'),
    lowerRevision: integer('lower_revision'),
    lowerCount: numeric('lower_count'),
    setCompositionResourceId: uuid('set_composition_resource_id'),
    setCompositionRevision: integer('set_composition_revision'),
    // Existing immutable rows predate intent capture; their classification cannot be inferred honestly.
    changeKind: text('change_kind').default('legacy_unclassified').notNull(),
    priorErrorExplanation: text('prior_error_explanation'),
    reason: text('reason').notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.packageDefinitionId, table.revision],
      name: 'catalog_package_content_revisions_pk',
    }),
    unique('catalog_package_content_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.productId, table.variantId, table.packageDefinitionId],
      foreignColumns: [
        packageDefinitions.tenantId,
        packageDefinitions.productId,
        packageDefinitions.variantId,
        packageDefinitions.packageDefinitionId,
      ],
      name: 'catalog_package_content_revisions_definition_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.unitResourceId],
      foreignColumns: [productUnits.tenantId, productUnits.unitId],
      name: 'catalog_package_content_revisions_unit_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.productId, table.variantId, table.lowerPackageDefinitionId],
      foreignColumns: [
        packageDefinitions.tenantId,
        packageDefinitions.productId,
        packageDefinitions.variantId,
        packageDefinitions.packageDefinitionId,
      ],
      name: 'catalog_package_content_revisions_lower_form_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.lowerPackageDefinitionId, table.lowerRevision],
      foreignColumns: [table.tenantId, table.packageDefinitionId, table.revision],
      name: 'catalog_package_content_revisions_lower_revision_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.tenantId,
        table.productId,
        table.variantId,
        table.setCompositionResourceId,
        table.setCompositionRevision,
      ],
      foreignColumns: [
        setCompositionRevisions.tenantId,
        setCompositionRevisions.productId,
        setCompositionRevisions.variantId,
        setCompositionRevisions.compositionId,
        setCompositionRevisions.revision,
      ],
      name: 'catalog_package_content_revisions_set_revision_fk',
    }).onDelete('restrict'),
    index('catalog_package_content_revisions_effective_idx').on(
      table.tenantId,
      table.packageDefinitionId,
      table.effectiveAt,
    ),
    check('catalog_package_content_revisions_number_ck', sql`${table.revision} > 0`),
    check('catalog_package_content_revisions_state_ck', sql`${table.lifecycleState} in ('DRAFT', 'ACTIVE', 'RETIRED')`),
    check('catalog_package_content_revisions_amount_ck', sql`${table.amount} > 0`),
    check(
      'catalog_package_content_revisions_unit_ck',
      sql`${table.unitResourceType} = 'commerce.catalog.product-unit'`,
    ),
    check(
      'catalog_package_content_revisions_configuration_ck',
      sql`${table.configurationKey} is null or (${table.configurationKey} = btrim(${table.configurationKey}) and length(${table.configurationKey}) between 1 and 300)`,
    ),
    check(
      'catalog_package_content_revisions_lower_ck',
      sql`(${table.lowerPackageDefinitionId} is null and ${table.lowerRevision} is null and ${table.lowerCount} is null) or (${table.lowerPackageDefinitionId} is not null and ${table.lowerRevision} is not null and ${table.lowerRevision} > 0 and ${table.lowerCount} is not null and ${table.lowerCount} > 0 and ${table.lowerCount} = trunc(${table.lowerCount}) and ${table.lowerPackageDefinitionId} <> ${table.packageDefinitionId})`,
    ),
    check(
      'catalog_package_content_revisions_set_ck',
      sql`(${table.setCompositionResourceId} is null and ${table.setCompositionRevision} is null) or (${table.setCompositionResourceId} is not null and ${table.setCompositionRevision} is not null and ${table.setCompositionRevision} > 0)`,
    ),
    check(
      'catalog_package_content_revisions_correction_ck',
      sql`(${table.changeKind} = 'legacy_unclassified' and ${table.priorErrorExplanation} is null) or (${table.changeKind} = 'physical_change' and ${table.priorErrorExplanation} is null) or (${table.changeKind} = 'correction' and ${table.revision} > 1 and ${table.priorErrorExplanation} is not null and ${table.priorErrorExplanation} = btrim(${table.priorErrorExplanation}) and length(${table.priorErrorExplanation}) between 1 and 1000)`,
    ),
    check(
      'catalog_package_content_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_package_content_revisions_tenant', table.tenantId),
  ],
);

/** Stable need IDs may recur across revisions; every row fixes one exact non-Set selection. */
export const setCompositionComponents = catalogSchema.table.withRLS(
  'set_composition_components',
  {
    tenantId: uuid('tenant_id').notNull(),
    compositionId: uuid('composition_id').notNull(),
    revision: integer('revision').notNull(),
    componentId: uuid('component_id').notNull(),
    componentProductId: uuid('component_product_id').notNull(),
    componentVariantId: uuid('component_variant_id').notNull(),
    packageDefinitionId: uuid('package_definition_id'),
    packageContentRevision: integer('package_content_revision'),
    configuration: jsonb('configuration'),
    quantityAmount: numeric('quantity_amount').notNull(),
    quantityUnitId: uuid('quantity_unit_id').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.compositionId, table.revision, table.componentId],
      name: 'catalog_set_composition_components_pk',
    }),
    foreignKey({
      columns: [table.tenantId, table.compositionId, table.revision],
      foreignColumns: [
        setCompositionRevisions.tenantId,
        setCompositionRevisions.compositionId,
        setCompositionRevisions.revision,
      ],
      name: 'catalog_set_composition_components_revision_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.componentProductId, table.componentVariantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.variantId],
      name: 'catalog_set_composition_components_variant_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.componentProductId, table.componentVariantId, table.packageDefinitionId],
      foreignColumns: [
        packageDefinitions.tenantId,
        packageDefinitions.productId,
        packageDefinitions.variantId,
        packageDefinitions.packageDefinitionId,
      ],
      name: 'catalog_set_composition_components_package_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.packageDefinitionId, table.packageContentRevision],
      foreignColumns: [
        packageContentRevisions.tenantId,
        packageContentRevisions.packageDefinitionId,
        packageContentRevisions.revision,
      ],
      name: 'catalog_set_composition_components_package_revision_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.quantityUnitId],
      foreignColumns: [productUnits.tenantId, productUnits.unitId],
      name: 'catalog_set_composition_components_unit_fk',
    }).onDelete('restrict'),
    check('catalog_set_composition_components_quantity_ck', sql`${table.quantityAmount} > 0`),
    check(
      'catalog_set_composition_components_package_pair_ck',
      sql`(${table.packageDefinitionId} is null and ${table.packageContentRevision} is null) or (${table.packageDefinitionId} is not null and ${table.packageContentRevision} > 0)`,
    ),
    ...tenantRlsPolicies('catalog_set_composition_components_tenant', table.tenantId),
  ],
);

/** An independently versioned, immutable decision about the Definition's selectable role. */
/** Tenant-wide reservation survives retirement; corrections retain every earlier attribution. */
export const commercialSkuReservations = catalogSchema.table.withRLS(
  'commercial_sku_reservations',
  {
    tenantId: uuid('tenant_id').notNull(),
    normalizedCode: text('normalized_code').notNull(),
    displayCode: text('display_code').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    packageDefinitionId: uuid('package_definition_id'),
    state: text('state').notNull(),
    currentRevision: integer('current_revision').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.normalizedCode], name: 'catalog_sku_reservations_pk' }),
    foreignKey({
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.variantId],
      name: 'catalog_sku_reservations_variant_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.productId, table.variantId, table.packageDefinitionId],
      foreignColumns: [
        packageDefinitions.tenantId,
        packageDefinitions.productId,
        packageDefinitions.variantId,
        packageDefinitions.packageDefinitionId,
      ],
      name: 'catalog_sku_reservations_package_fk',
    }).onDelete('restrict'),
    uniqueIndex('catalog_sku_reservations_current_variant_uk')
      .on(table.tenantId, table.variantId)
      .where(sql`${table.state} = 'CURRENT' and ${table.packageDefinitionId} is null`),
    uniqueIndex('catalog_sku_reservations_current_package_uk')
      .on(table.tenantId, table.packageDefinitionId)
      .where(sql`${table.state} = 'CURRENT' and ${table.packageDefinitionId} is not null`),
    uniqueIndex('catalog_sku_reservations_binary_code_uk').on(table.tenantId, sql.raw('"normalized_code" COLLATE "C"')),
    check(
      'catalog_sku_reservations_code_ck',
      sql`${table.normalizedCode} = btrim(${table.normalizedCode}) and length(${table.normalizedCode}) between 1 and 240`,
    ),
    check('catalog_sku_reservations_state_ck', sql`${table.state} in ('CURRENT', 'HISTORICAL', 'UNRESOLVED')`),
    check('catalog_sku_reservations_revision_ck', sql`${table.currentRevision} > 0`),
    ...tenantRlsPolicies('catalog_sku_reservations_tenant', table.tenantId),
  ],
);

export const commercialSkuAssignmentRevisions = catalogSchema.table.withRLS(
  'commercial_sku_assignment_revisions',
  {
    tenantId: uuid('tenant_id').notNull(),
    normalizedCode: text('normalized_code').notNull(),
    revision: integer('revision').notNull(),
    displayCode: text('display_code').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    packageDefinitionId: uuid('package_definition_id'),
    state: text('state').notNull(),
    changeKind: text('change_kind').notNull(),
    reason: text('reason').notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.normalizedCode, table.revision],
      name: 'catalog_sku_assignment_revisions_pk',
    }),
    unique('catalog_sku_assignment_revisions_invocation_uk').on(
      table.tenantId,
      table.normalizedCode,
      table.actionInvocationId,
    ),
    foreignKey({
      columns: [table.tenantId, table.normalizedCode],
      foreignColumns: [commercialSkuReservations.tenantId, commercialSkuReservations.normalizedCode],
      name: 'catalog_sku_assignment_revisions_reservation_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.variantId],
      name: 'catalog_sku_assignment_revisions_variant_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.productId, table.variantId, table.packageDefinitionId],
      foreignColumns: [
        packageDefinitions.tenantId,
        packageDefinitions.productId,
        packageDefinitions.variantId,
        packageDefinitions.packageDefinitionId,
      ],
      name: 'catalog_sku_assignment_revisions_package_fk',
    }).onDelete('restrict'),
    check(
      'catalog_sku_assignment_revisions_code_ck',
      sql`${table.normalizedCode} = btrim(${table.normalizedCode}) and length(${table.normalizedCode}) between 1 and 240`,
    ),
    check('catalog_sku_assignment_revisions_revision_ck', sql`${table.revision} > 0`),
    check('catalog_sku_assignment_revisions_state_ck', sql`${table.state} in ('CURRENT', 'HISTORICAL', 'UNRESOLVED')`),
    check(
      'catalog_sku_assignment_revisions_kind_ck',
      sql`${table.changeKind} in ('ASSIGN', 'RENAME', 'RETIRE', 'CORRECT', 'MARK_UNRESOLVED')`,
    ),
    check('catalog_sku_assignment_revisions_reason_ck', sql`length(btrim(${table.reason})) between 1 and 1000`),
    ...tenantRlsPolicies('catalog_sku_assignment_revisions_tenant', table.tenantId),
  ],
);

/** GTIN is a separate exact-digit namespace; a packaging level need not be selectable. */
export const commercialGtinAssignments = catalogSchema.table.withRLS(
  'commercial_gtin_assignments',
  {
    tenantId: uuid('tenant_id').notNull(),
    gtin: text('gtin').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    packageDefinitionId: uuid('package_definition_id'),
    state: text('state').notNull(),
    currentRevision: integer('current_revision').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.gtin], name: 'catalog_gtin_assignments_pk' }),
    foreignKey({
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.variantId],
      name: 'catalog_gtin_assignments_variant_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.productId, table.variantId, table.packageDefinitionId],
      foreignColumns: [
        packageDefinitions.tenantId,
        packageDefinitions.productId,
        packageDefinitions.variantId,
        packageDefinitions.packageDefinitionId,
      ],
      name: 'catalog_gtin_assignments_package_fk',
    }).onDelete('restrict'),
    check('catalog_gtin_assignments_digits_ck', sql`${table.gtin} ~ '^[0-9]{8}([0-9]{4,6})?$'`),
    check('catalog_gtin_assignments_state_ck', sql`${table.state} in ('CONFIRMED', 'RETIRED', 'UNRESOLVED')`),
    check('catalog_gtin_assignments_revision_ck', sql`${table.currentRevision} > 0`),
    ...tenantRlsPolicies('catalog_gtin_assignments_tenant', table.tenantId),
  ],
);

export const commercialGtinAssignmentRevisions = catalogSchema.table.withRLS(
  'commercial_gtin_assignment_revisions',
  {
    tenantId: uuid('tenant_id').notNull(),
    gtin: text('gtin').notNull(),
    revision: integer('revision').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    packageDefinitionId: uuid('package_definition_id'),
    state: text('state').notNull(),
    attributionEvidenceRef: text('attribution_evidence_ref').notNull(),
    reason: text('reason').notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.gtin, table.revision], name: 'catalog_gtin_assignment_revisions_pk' }),
    unique('catalog_gtin_assignment_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.gtin],
      foreignColumns: [commercialGtinAssignments.tenantId, commercialGtinAssignments.gtin],
      name: 'catalog_gtin_assignment_revisions_assignment_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.variantId],
      name: 'catalog_gtin_assignment_revisions_variant_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.productId, table.variantId, table.packageDefinitionId],
      foreignColumns: [
        packageDefinitions.tenantId,
        packageDefinitions.productId,
        packageDefinitions.variantId,
        packageDefinitions.packageDefinitionId,
      ],
      name: 'catalog_gtin_assignment_revisions_package_fk',
    }).onDelete('restrict'),
    check('catalog_gtin_assignment_revisions_revision_ck', sql`${table.revision} > 0`),
    check('catalog_gtin_assignment_revisions_state_ck', sql`${table.state} in ('CONFIRMED', 'RETIRED', 'UNRESOLVED')`),
    check(
      'catalog_gtin_assignment_revisions_evidence_ck',
      sql`length(btrim(${table.attributionEvidenceRef})) between 1 and 1000`,
    ),
    check('catalog_gtin_assignment_revisions_reason_ck', sql`length(btrim(${table.reason})) between 1 and 1000`),
    ...tenantRlsPolicies('catalog_gtin_assignment_revisions_tenant', table.tenantId),
  ],
);

export const packageOptionRoleRevisions = catalogSchema.table.withRLS(
  'package_option_role_revisions',
  {
    tenantId: uuid('tenant_id').notNull(),
    packageDefinitionId: uuid('package_definition_id').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    revision: integer('revision').notNull(),
    contentRevision: integer('content_revision').notNull(),
    state: text('state').notNull(),
    independentlyRequested: boolean('independently_requested').notNull(),
    looseUnitsSubstitutable: boolean('loose_units_substitutable').notNull(),
    validationReason: text('validation_reason').notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.packageDefinitionId, table.revision],
      name: 'catalog_package_option_role_revisions_pk',
    }),
    unique('catalog_package_option_role_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.productId, table.variantId, table.packageDefinitionId],
      foreignColumns: [
        packageDefinitions.tenantId,
        packageDefinitions.productId,
        packageDefinitions.variantId,
        packageDefinitions.packageDefinitionId,
      ],
      name: 'catalog_package_option_role_revisions_definition_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.packageDefinitionId, table.contentRevision],
      foreignColumns: [
        packageContentRevisions.tenantId,
        packageContentRevisions.packageDefinitionId,
        packageContentRevisions.revision,
      ],
      name: 'catalog_package_option_role_revisions_content_fk',
    }).onDelete('restrict'),
    index('catalog_package_option_role_revisions_effective_idx').on(
      table.tenantId,
      table.packageDefinitionId,
      table.effectiveAt,
    ),
    check('catalog_package_option_role_revisions_number_ck', sql`${table.revision} > 0`),
    check('catalog_package_option_role_revisions_content_ck', sql`${table.contentRevision} > 0`),
    check('catalog_package_option_role_revisions_state_ck', sql`${table.state} in ('ACTIVE', 'RETIRED')`),
    check(
      'catalog_package_option_role_revisions_active_ck',
      sql`${table.state} <> 'ACTIVE' or (${table.independentlyRequested} and not ${table.looseUnitsSubstitutable})`,
    ),
    check(
      'catalog_package_option_role_revisions_reason_ck',
      sql`${table.validationReason} = btrim(${table.validationReason}) and length(${table.validationReason}) between 1 and 1000`,
    ),
    check(
      'catalog_package_option_role_revisions_evidence_ck',
      sql`cardinality(${table.evidenceRefs}) > 0 and array_position(${table.evidenceRefs}, null) is null`,
    ),
    ...tenantRlsPolicies('catalog_package_option_role_revisions_tenant', table.tenantId),
  ],
);

export const productRevisions = catalogSchema.table.withRLS(
  'product_revisions',
  {
    productRevisionId: uuid('product_revision_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    revision: integer('revision').notNull(),
    changeKind: text('change_kind').notNull(),
    lifecycleState: text('lifecycle_state').notNull(),
    name: text('name'),
    description: text('description'),
    reason: text('reason').notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('catalog_product_revisions_scope_id_uk').on(table.tenantId, table.productRevisionId),
    unique('catalog_product_revisions_number_uk').on(table.tenantId, table.productId, table.revision),
    unique('catalog_product_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.productId],
      name: 'catalog_product_revisions_product_fk',
    }).onDelete('restrict'),
    index('catalog_product_revisions_history_idx').on(table.tenantId, table.productId, table.revision),
    check('catalog_product_revisions_revision_ck', sql`${table.revision} > 0`),
    check(
      'catalog_product_revisions_change_kind_ck',
      sql`${table.changeKind} in ('CREATED', 'UPDATED', 'COSMETIC_CORRECTION', 'LIFECYCLE')`,
    ),
    check('catalog_product_revisions_lifecycle_ck', sql`${table.lifecycleState} in ('DRAFT', 'ACTIVE', 'RETIRED')`),
    check(
      'catalog_product_revisions_name_ck',
      sql`${table.name} is null or (${table.name} = btrim(${table.name}) and length(${table.name}) between 1 and 240)`,
    ),
    check(
      'catalog_product_revisions_description_ck',
      sql`${table.description} is null or (${table.description} = btrim(${table.description}) and length(${table.description}) <= 4000)`,
    ),
    check(
      'catalog_product_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_product_revisions_tenant', table.tenantId),
  ],
);

export const productLifecycleEvents = catalogSchema.table.withRLS(
  'product_lifecycle_events',
  {
    productLifecycleEventId: uuid('product_lifecycle_event_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    event: text('event').notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    reason: text('reason').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('catalog_product_lifecycle_scope_id_uk').on(table.tenantId, table.productLifecycleEventId),
    unique('catalog_product_lifecycle_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.productId],
      name: 'catalog_product_lifecycle_product_fk',
    }).onDelete('restrict'),
    index('catalog_product_lifecycle_history_idx').on(table.tenantId, table.productId, table.effectiveAt),
    check('catalog_product_lifecycle_event_ck', sql`${table.event} in ('ACTIVATED', 'RETIRED')`),
    check(
      'catalog_product_lifecycle_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_product_lifecycle_tenant', table.tenantId),
  ],
);

export const productTypes = catalogSchema.table.withRLS(
  'product_types',
  {
    productTypeId: uuid('product_type_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    name: text('name').notNull(),
    // Create/revise writes the immutable revision in the same Core transaction; the verifier proves this pointer.
    currentRevision: integer('current_revision').default(1).notNull(),
    createdByActionInvocationId: uuid('created_by_action_invocation_id').notNull(),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('catalog_product_types_scope_id_uk').on(table.tenantId, table.productTypeId),
    index('catalog_product_types_tenant_name_idx').on(table.tenantId, table.name),
    check('catalog_product_types_revision_ck', sql`${table.currentRevision} > 0`),
    check(
      'catalog_product_types_name_ck',
      sql`${table.name} = btrim(${table.name}) and length(${table.name}) between 1 and 240`,
    ),
    ...tenantRlsPolicies('catalog_product_types_tenant', table.tenantId),
  ],
);

export const productTypeRevisions = catalogSchema.table.withRLS(
  'product_type_revisions',
  {
    productTypeRevisionId: uuid('product_type_revision_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    productTypeId: uuid('product_type_id').notNull(),
    revision: integer('revision').notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    reason: text('reason').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('catalog_product_type_revisions_scope_id_uk').on(table.tenantId, table.productTypeRevisionId),
    unique('catalog_product_type_revisions_number_uk').on(table.tenantId, table.productTypeId, table.revision),
    unique('catalog_product_type_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.productTypeId],
      foreignColumns: [productTypes.tenantId, productTypes.productTypeId],
      name: 'catalog_product_type_revisions_type_fk',
    }).onDelete('restrict'),
    check('catalog_product_type_revisions_number_ck', sql`${table.revision} > 0`),
    check(
      'catalog_product_type_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_product_type_revisions_tenant', table.tenantId),
  ],
);

export const attributeDefinitions = catalogSchema.table.withRLS(
  'attribute_definitions',
  {
    attributeDefinitionId: uuid('attribute_definition_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    currentRevision: integer('current_revision').default(1).notNull(),
    name: text('name').notNull(),
    meaning: text('meaning').notNull(),
    valueKind: text('value_kind').notNull(),
    controlledValueKind: text('controlled_value_kind'),
    multiplicity: text('multiplicity').notNull(),
    applicableLevels: text('applicable_levels').array().notNull(),
    measuredQuantity: text('measured_quantity'),
    canonicalUnit: text('canonical_unit'),
    minimumValue: numeric('minimum_value'),
    maximumValue: numeric('maximum_value'),
    decimalPlaces: integer('decimal_places'),
    allowsUnknown: integer('allows_unknown').default(0).notNull(),
    allowsNotApplicable: integer('allows_not_applicable').default(0).notNull(),
    allowsNone: integer('allows_none').default(0).notNull(),
    createdByActionInvocationId: uuid('created_by_action_invocation_id').notNull(),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('catalog_attribute_definitions_scope_id_uk').on(table.tenantId, table.attributeDefinitionId),
    check('catalog_attribute_definitions_revision_ck', sql`${table.currentRevision} > 0`),
    check('catalog_attribute_definitions_kind_ck', sql`${table.valueKind} in ('TEXT', 'CONTROLLED', 'MEASUREMENT')`),
    check('catalog_attribute_definitions_multiplicity_ck', sql`${table.multiplicity} in ('SINGLE', 'MULTIPLE')`),
    check(
      'catalog_attribute_definitions_controlled_kind_ck',
      sql`(${table.valueKind} = 'CONTROLLED' and ${table.controlledValueKind} in ('GENERAL', 'COLOR', 'SIZE')) or (${table.valueKind} <> 'CONTROLLED' and ${table.controlledValueKind} is null)`,
    ),
    check(
      'catalog_attribute_definitions_levels_ck',
      sql`cardinality(${table.applicableLevels}) between 1 and 2 and ${table.applicableLevels} <@ array['PRODUCT', 'VARIANT']::text[] and array_position(${table.applicableLevels}, null) is null and (${table.applicableLevels} = array['PRODUCT']::text[] or ${table.applicableLevels} = array['VARIANT']::text[] or ${table.applicableLevels} in (array['PRODUCT','VARIANT']::text[], array['VARIANT','PRODUCT']::text[]))`,
    ),
    check(
      'catalog_attribute_definitions_meaning_ck',
      sql`${table.meaning} = btrim(${table.meaning}) and length(${table.meaning}) between 1 and 1000`,
    ),
    check(
      'catalog_attribute_definitions_name_ck',
      sql`${table.name} = btrim(${table.name}) and length(${table.name}) between 1 and 240`,
    ),
    check(
      'catalog_attribute_definitions_measurement_ck',
      sql`(${table.valueKind} = 'MEASUREMENT' and ${table.measuredQuantity} is not null and ${table.canonicalUnit} is not null and ${table.decimalPlaces} is not null) or (${table.valueKind} <> 'MEASUREMENT' and ${table.measuredQuantity} is null and ${table.canonicalUnit} is null and ${table.minimumValue} is null and ${table.maximumValue} is null and ${table.decimalPlaces} is null)`,
    ),
    check(
      'catalog_attribute_definitions_range_ck',
      sql`${table.minimumValue} is null or ${table.maximumValue} is null or ${table.minimumValue} <= ${table.maximumValue}`,
    ),
    check(
      'catalog_attribute_definitions_precision_ck',
      sql`${table.decimalPlaces} is null or ${table.decimalPlaces} between 0 and 12`,
    ),
    check(
      'catalog_attribute_definitions_special_ck',
      sql`${table.allowsUnknown} in (0, 1) and ${table.allowsNotApplicable} in (0, 1) and ${table.allowsNone} in (0, 1)`,
    ),
    ...tenantRlsPolicies('catalog_attribute_definitions_tenant', table.tenantId),
  ],
);

export const attributeDefinitionRevisions = catalogSchema.table.withRLS(
  'attribute_definition_revisions',
  {
    attributeDefinitionRevisionId: uuid('attribute_definition_revision_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    attributeDefinitionId: uuid('attribute_definition_id').notNull(),
    revision: integer('revision').notNull(),
    name: text('name').notNull(),
    meaning: text('meaning').notNull(),
    valueKind: text('value_kind').notNull(),
    controlledValueKind: text('controlled_value_kind'),
    multiplicity: text('multiplicity').notNull(),
    applicableLevels: text('applicable_levels').array().notNull(),
    measuredQuantity: text('measured_quantity'),
    canonicalUnit: text('canonical_unit'),
    minimumValue: numeric('minimum_value'),
    maximumValue: numeric('maximum_value'),
    decimalPlaces: integer('decimal_places'),
    allowsUnknown: integer('allows_unknown').notNull(),
    allowsNotApplicable: integer('allows_not_applicable').notNull(),
    allowsNone: integer('allows_none').notNull(),
    reason: text('reason').notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('catalog_attribute_definition_revisions_number_uk').on(
      table.tenantId,
      table.attributeDefinitionId,
      table.revision,
    ),
    unique('catalog_attribute_definition_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.attributeDefinitionId],
      foreignColumns: [attributeDefinitions.tenantId, attributeDefinitions.attributeDefinitionId],
      name: 'catalog_attribute_definition_revisions_definition_fk',
    }).onDelete('restrict'),
    check('catalog_attribute_definition_revisions_number_ck', sql`${table.revision} > 0`),
    check(
      'catalog_attribute_definition_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_attribute_definition_revisions_tenant', table.tenantId),
  ],
);

export const controlledAttributeValues = catalogSchema.table.withRLS(
  'controlled_attribute_values',
  {
    controlledAttributeValueId: uuid('controlled_attribute_value_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    attributeDefinitionId: uuid('attribute_definition_id').notNull(),
    currentRevision: integer('current_revision').default(1).notNull(),
    name: text('name').notNull(),
    meaning: text('meaning').notNull(),
    specialization: text('specialization').notNull(),
    lifecycleState: text('lifecycle_state').default('ACTIVE').notNull(),
    colorGroup: text('color_group'),
    colorDetails: jsonb('color_details').$type<ColorDetails>(),
    swatchSystem: text('swatch_system'),
    swatchCode: text('swatch_code'),
    previewHex: text('preview_hex'),
    previewEvidenceRef: text('preview_evidence_ref'),
    createdByActionInvocationId: uuid('created_by_action_invocation_id').notNull(),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('catalog_controlled_values_scope_id_uk').on(table.tenantId, table.controlledAttributeValueId),
    unique('catalog_controlled_values_size_kind_uk').on(
      table.tenantId,
      table.controlledAttributeValueId,
      table.specialization,
    ),
    unique('catalog_controlled_values_definition_id_uk').on(
      table.tenantId,
      table.attributeDefinitionId,
      table.controlledAttributeValueId,
    ),
    foreignKey({
      columns: [table.tenantId, table.attributeDefinitionId],
      foreignColumns: [attributeDefinitions.tenantId, attributeDefinitions.attributeDefinitionId],
      name: 'catalog_controlled_values_definition_fk',
    }).onDelete('restrict'),
    check('catalog_controlled_values_revision_ck', sql`${table.currentRevision} > 0`),
    check(
      'catalog_controlled_values_name_ck',
      sql`${table.name} = btrim(${table.name}) and length(${table.name}) between 1 and 240`,
    ),
    check('catalog_controlled_values_lifecycle_ck', sql`${table.lifecycleState} in ('ACTIVE', 'RETIRED')`),
    check('catalog_controlled_values_specialization_ck', sql`${table.specialization} in ('GENERAL', 'COLOR', 'SIZE')`),
    check(
      'catalog_controlled_values_swatch_ck',
      sql`(${table.swatchSystem} is null and ${table.swatchCode} is null) or (${table.specialization} = 'COLOR' and ${table.swatchSystem} is not null and ${table.swatchCode} is not null)`,
    ),
    check(
      'catalog_controlled_values_meaning_ck',
      sql`${table.meaning} = btrim(${table.meaning}) and length(${table.meaning}) between 1 and 1000`,
    ),
    check(
      'catalog_controlled_values_preview_ck',
      sql`${table.previewHex} is null or ${table.previewHex} ~ '^#[0-9A-Fa-f]{6}$'`,
    ),
    ...tenantRlsPolicies('catalog_controlled_values_tenant', table.tenantId),
  ],
);

/** One Product owns its explicit Size order; shared Size identity stays in the controlled vocabulary. */
export const productSizeUsageSets = catalogSchema.table.withRLS(
  'product_size_usage_sets',
  {
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    currentRevision: integer('current_revision').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.productId], name: 'catalog_product_size_usage_sets_pk' }),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.productId],
      name: 'catalog_product_size_usage_sets_product_fk',
    }).onDelete('restrict'),
    check('catalog_product_size_usage_sets_revision_ck', sql`${table.currentRevision} > 0`),
    ...tenantRlsPolicies('catalog_product_size_usage_sets_tenant', table.tenantId),
  ],
);

export const productSizeUsageItems = catalogSchema.table.withRLS(
  'product_size_usage_items',
  {
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    position: integer('position').notNull(),
    sizeValueId: uuid('size_value_id').notNull(),
    sizeSpecialization: text('size_specialization').default('SIZE').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.productId, table.position],
      name: 'catalog_product_size_usage_items_pk',
    }),
    unique('catalog_product_size_usage_items_value_uk').on(table.tenantId, table.productId, table.sizeValueId),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [productSizeUsageSets.tenantId, productSizeUsageSets.productId],
      name: 'catalog_product_size_usage_items_set_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.sizeValueId, table.sizeSpecialization],
      foreignColumns: [
        controlledAttributeValues.tenantId,
        controlledAttributeValues.controlledAttributeValueId,
        controlledAttributeValues.specialization,
      ],
      name: 'catalog_product_size_usage_items_size_fk',
    }).onDelete('restrict'),
    check('catalog_product_size_usage_items_position_ck', sql`${table.position} >= 0`),
    check('catalog_product_size_usage_items_kind_ck', sql`${table.sizeSpecialization} = 'SIZE'`),
    ...tenantRlsPolicies('catalog_product_size_usage_items_tenant', table.tenantId),
  ],
);

export const productSizeUsageRevisions = catalogSchema.table.withRLS(
  'product_size_usage_revisions',
  {
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    revision: integer('revision').notNull(),
    reason: text('reason').notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.productId, table.revision],
      name: 'catalog_product_size_usage_revisions_pk',
    }),
    unique('catalog_product_size_usage_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [productSizeUsageSets.tenantId, productSizeUsageSets.productId],
      name: 'catalog_product_size_usage_revisions_set_fk',
    }).onDelete('restrict'),
    check('catalog_product_size_usage_revisions_number_ck', sql`${table.revision} > 0`),
    check(
      'catalog_product_size_usage_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_product_size_usage_revisions_tenant', table.tenantId),
  ],
);

export const productSizeUsageRevisionItems = catalogSchema.table.withRLS(
  'product_size_usage_revision_items',
  {
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    revision: integer('revision').notNull(),
    position: integer('position').notNull(),
    sizeValueId: uuid('size_value_id').notNull(),
    sizeSpecialization: text('size_specialization').default('SIZE').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.productId, table.revision, table.position],
      name: 'catalog_product_size_usage_revision_items_pk',
    }),
    unique('catalog_product_size_usage_revision_items_value_uk').on(
      table.tenantId,
      table.productId,
      table.revision,
      table.sizeValueId,
    ),
    foreignKey({
      columns: [table.tenantId, table.productId, table.revision],
      foreignColumns: [
        productSizeUsageRevisions.tenantId,
        productSizeUsageRevisions.productId,
        productSizeUsageRevisions.revision,
      ],
      name: 'catalog_product_size_usage_revision_items_revision_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.sizeValueId, table.sizeSpecialization],
      foreignColumns: [
        controlledAttributeValues.tenantId,
        controlledAttributeValues.controlledAttributeValueId,
        controlledAttributeValues.specialization,
      ],
      name: 'catalog_product_size_usage_revision_items_size_fk',
    }).onDelete('restrict'),
    check('catalog_product_size_usage_revision_items_position_ck', sql`${table.position} >= 0`),
    check('catalog_product_size_usage_revision_items_kind_ck', sql`${table.sizeSpecialization} = 'SIZE'`),
    ...tenantRlsPolicies('catalog_product_size_usage_revision_items_tenant', table.tenantId),
  ],
);

/** An assertion is immutable evidence for one scope and period, never a global conversion rule. */
export const sizeEquivalenceAssertions = catalogSchema.table.withRLS(
  'size_equivalence_assertions',
  {
    assertionId: uuid('assertion_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    leftSizeValueId: uuid('left_size_value_id').notNull(),
    rightSizeValueId: uuid('right_size_value_id').notNull(),
    leftSpecialization: text('left_specialization').default('SIZE').notNull(),
    rightSpecialization: text('right_specialization').default('SIZE').notNull(),
    scope: text('scope').notNull(),
    evidenceRef: text('evidence_ref').notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('catalog_size_equivalence_assertions_scope_id_uk').on(table.tenantId, table.assertionId),
    unique('catalog_size_equivalence_assertions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.leftSizeValueId, table.leftSpecialization],
      foreignColumns: [
        controlledAttributeValues.tenantId,
        controlledAttributeValues.controlledAttributeValueId,
        controlledAttributeValues.specialization,
      ],
      name: 'catalog_size_equivalence_assertions_left_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.rightSizeValueId, table.rightSpecialization],
      foreignColumns: [
        controlledAttributeValues.tenantId,
        controlledAttributeValues.controlledAttributeValueId,
        controlledAttributeValues.specialization,
      ],
      name: 'catalog_size_equivalence_assertions_right_fk',
    }).onDelete('restrict'),
    check(
      'catalog_size_equivalence_assertions_kind_ck',
      sql`${table.leftSpecialization} = 'SIZE' and ${table.rightSpecialization} = 'SIZE'`,
    ),
    check(
      'catalog_size_equivalence_assertions_distinct_ck',
      sql`${table.leftSizeValueId} <> ${table.rightSizeValueId}`,
    ),
    check(
      'catalog_size_equivalence_assertions_scope_ck',
      sql`${table.scope} = btrim(${table.scope}) and length(${table.scope}) between 1 and 1000`,
    ),
    check(
      'catalog_size_equivalence_assertions_evidence_ck',
      sql`${table.evidenceRef} = btrim(${table.evidenceRef}) and length(${table.evidenceRef}) between 1 and 1000`,
    ),
    check(
      'catalog_size_equivalence_assertions_period_ck',
      sql`${table.validUntil} is null or ${table.validFrom} is null or ${table.validUntil} > ${table.validFrom}`,
    ),
    ...tenantRlsPolicies('catalog_size_equivalence_assertions_tenant', table.tenantId),
  ],
);

export const controlledAttributeValueRevisions = catalogSchema.table.withRLS(
  'controlled_attribute_value_revisions',
  {
    controlledAttributeValueRevisionId: uuid('controlled_attribute_value_revision_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    controlledAttributeValueId: uuid('controlled_attribute_value_id').notNull(),
    attributeDefinitionId: uuid('attribute_definition_id').notNull(),
    revision: integer('revision').notNull(),
    name: text('name').notNull(),
    meaning: text('meaning').notNull(),
    specialization: text('specialization').notNull(),
    lifecycleState: text('lifecycle_state').notNull(),
    colorGroup: text('color_group'),
    colorDetails: jsonb('color_details').$type<ColorDetails>(),
    swatchSystem: text('swatch_system'),
    swatchCode: text('swatch_code'),
    previewHex: text('preview_hex'),
    previewEvidenceRef: text('preview_evidence_ref'),
    reason: text('reason').notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('catalog_controlled_value_revisions_number_uk').on(
      table.tenantId,
      table.controlledAttributeValueId,
      table.revision,
    ),
    unique('catalog_controlled_value_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.attributeDefinitionId, table.controlledAttributeValueId],
      foreignColumns: [
        controlledAttributeValues.tenantId,
        controlledAttributeValues.attributeDefinitionId,
        controlledAttributeValues.controlledAttributeValueId,
      ],
      name: 'catalog_controlled_value_revisions_value_fk',
    }).onDelete('restrict'),
    check('catalog_controlled_value_revisions_number_ck', sql`${table.revision} > 0`),
    check('catalog_controlled_value_revisions_lifecycle_ck', sql`${table.lifecycleState} in ('ACTIVE', 'RETIRED')`),
    check(
      'catalog_controlled_value_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_controlled_value_revisions_tenant', table.tenantId),
  ],
);

export const productTypeRevisionAttributes = catalogSchema.table.withRLS(
  'product_type_revision_attributes',
  {
    tenantId: uuid('tenant_id').notNull(),
    productTypeId: uuid('product_type_id').notNull(),
    revision: integer('revision').notNull(),
    attributeDefinitionId: uuid('attribute_definition_id').notNull(),
    level: text('level').notNull(),
    requirement: text('requirement').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.productTypeId, table.revision, table.attributeDefinitionId, table.level],
      name: 'catalog_product_type_revision_attributes_pk',
    }),
    foreignKey({
      columns: [table.tenantId, table.productTypeId, table.revision],
      foreignColumns: [
        productTypeRevisions.tenantId,
        productTypeRevisions.productTypeId,
        productTypeRevisions.revision,
      ],
      name: 'catalog_product_type_revision_attributes_revision_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.attributeDefinitionId],
      foreignColumns: [attributeDefinitions.tenantId, attributeDefinitions.attributeDefinitionId],
      name: 'catalog_product_type_revision_attributes_definition_fk',
    }).onDelete('restrict'),
    check(
      'catalog_product_type_revision_attributes_requirement_ck',
      sql`${table.requirement} in ('REQUIRED', 'OPTIONAL')`,
    ),
    check('catalog_product_type_revision_attributes_level_ck', sql`${table.level} in ('PRODUCT', 'VARIANT')`),
    ...tenantRlsPolicies('catalog_product_type_revision_attributes_tenant', table.tenantId),
  ],
);

/** Product-local use is distinct from Type permission, values, and Variant Axis role. */
export const productAttributeApplicability = catalogSchema.table.withRLS(
  'product_attribute_applicability',
  {
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    attributeDefinitionId: uuid('attribute_definition_id').notNull(),
    currentRevision: integer('current_revision').notNull(),
    productLevel: boolean('product_level').notNull(),
    variantLevel: boolean('variant_level').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.productId, table.attributeDefinitionId],
      name: 'catalog_product_attribute_applicability_pk',
    }),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.productId],
      name: 'catalog_product_attribute_applicability_product_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.attributeDefinitionId],
      foreignColumns: [attributeDefinitions.tenantId, attributeDefinitions.attributeDefinitionId],
      name: 'catalog_product_attribute_applicability_definition_fk',
    }).onDelete('restrict'),
    check('catalog_product_attribute_applicability_revision_ck', sql`${table.currentRevision} > 0`),
    ...tenantRlsPolicies('catalog_product_attribute_applicability_tenant', table.tenantId),
  ],
);

/** Append-only evidence retains even an entirely removed declaration. */
export const productAttributeApplicabilityRevisions = catalogSchema.table.withRLS(
  'product_attribute_applicability_revisions',
  {
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    attributeDefinitionId: uuid('attribute_definition_id').notNull(),
    revision: integer('revision').notNull(),
    productLevel: boolean('product_level').notNull(),
    variantLevel: boolean('variant_level').notNull(),
    reason: text('reason').notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.productId, table.attributeDefinitionId, table.revision],
      name: 'catalog_product_attribute_applicability_revisions_pk',
    }),
    unique('catalog_product_attribute_applicability_revisions_invocation_uk').on(
      table.tenantId,
      table.actionInvocationId,
    ),
    foreignKey({
      columns: [table.tenantId, table.productId, table.attributeDefinitionId],
      foreignColumns: [
        productAttributeApplicability.tenantId,
        productAttributeApplicability.productId,
        productAttributeApplicability.attributeDefinitionId,
      ],
      name: 'catalog_product_attribute_applicability_revisions_current_fk',
    }).onDelete('restrict'),
    check('catalog_product_attribute_applicability_revisions_number_ck', sql`${table.revision} > 0`),
    check(
      'catalog_product_attribute_applicability_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_product_attribute_applicability_revisions_tenant', table.tenantId),
  ],
);

// An axis is a Product-local role for a shared definition.  The revision is a
// compare-and-swap token for whole-product combination revalidation.
export const productVariantAxes = catalogSchema.table.withRLS(
  'product_variant_axes',
  {
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    attributeDefinitionId: uuid('attribute_definition_id').notNull(),
    axisRevision: integer('axis_revision').notNull(),
    definitionRevision: integer('definition_revision'),
    ordinal: integer('ordinal').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.productId, table.attributeDefinitionId],
      name: 'catalog_product_variant_axes_pk',
    }),
    unique('catalog_product_variant_axes_ordinal_uk').on(table.tenantId, table.productId, table.ordinal),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.productId],
      name: 'catalog_product_variant_axes_product_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.attributeDefinitionId],
      foreignColumns: [attributeDefinitions.tenantId, attributeDefinitions.attributeDefinitionId],
      name: 'catalog_product_variant_axes_definition_fk',
    }).onDelete('restrict'),
    check('catalog_product_variant_axes_revision_ck', sql`${table.axisRevision} > 0 and ${table.ordinal} >= 0`),
    ...tenantRlsPolicies('catalog_product_variant_axes_tenant', table.tenantId),
  ],
);

/** An explicit replacement snapshot, including an intentionally empty allowed set. */
export const productVariantAxisAllowanceEvents = catalogSchema.table.withRLS(
  'product_variant_axis_allowance_events',
  {
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    attributeDefinitionId: uuid('attribute_definition_id').notNull(),
    allowanceRevision: integer('allowance_revision').notNull(),
    axisRevision: integer('axis_revision').notNull(),
    definitionRevision: integer('definition_revision').notNull(),
    valueCount: integer('value_count').notNull(),
    reason: text('reason').notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.productId, table.attributeDefinitionId, table.allowanceRevision],
      name: 'catalog_product_variant_axis_allowance_events_pk',
    }),
    unique('catalog_product_variant_axis_allowance_invocation_uk').on(table.tenantId, table.actionInvocationId),
    // Carries axisRevision so child value rows can pin the exact allowance axis revision.
    unique('catalog_product_variant_axis_allowance_axis_uk').on(
      table.tenantId,
      table.productId,
      table.attributeDefinitionId,
      table.allowanceRevision,
      table.axisRevision,
    ),
    foreignKey({
      columns: [table.tenantId, table.productId, table.axisRevision],
      foreignColumns: [
        productVariantAxisEvents.tenantId,
        productVariantAxisEvents.productId,
        productVariantAxisEvents.axisRevision,
      ],
      name: 'catalog_product_variant_axis_allowance_axis_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.attributeDefinitionId, table.definitionRevision],
      foreignColumns: [
        attributeDefinitionRevisions.tenantId,
        attributeDefinitionRevisions.attributeDefinitionId,
        attributeDefinitionRevisions.revision,
      ],
      name: 'catalog_product_variant_axis_allowance_definition_revision_fk',
    }).onDelete('restrict'),
    check(
      'catalog_product_variant_axis_allowance_revision_ck',
      sql`${table.allowanceRevision} > 0 and ${table.axisRevision} > 0 and ${table.definitionRevision} > 0 and ${table.valueCount} >= 0`,
    ),
    check(
      'catalog_product_variant_axis_allowance_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_product_variant_axis_allowance_events_tenant', table.tenantId),
  ],
);

/** Only rows explicitly recorded in an allowance event can be selected for its axis. */
export const productVariantAxisAllowedValues = catalogSchema.table.withRLS(
  'product_variant_axis_allowed_values',
  {
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    attributeDefinitionId: uuid('attribute_definition_id').notNull(),
    allowanceRevision: integer('allowance_revision').notNull(),
    axisRevision: integer('axis_revision').notNull(),
    valueKey: text('value_key').notNull(),
    valueSnapshot: jsonb('value_snapshot').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.productId, table.attributeDefinitionId, table.allowanceRevision, table.valueKey],
      name: 'catalog_product_variant_axis_allowed_values_pk',
    }),
    foreignKey({
      columns: [
        table.tenantId,
        table.productId,
        table.attributeDefinitionId,
        table.allowanceRevision,
        table.axisRevision,
      ],
      foreignColumns: [
        productVariantAxisAllowanceEvents.tenantId,
        productVariantAxisAllowanceEvents.productId,
        productVariantAxisAllowanceEvents.attributeDefinitionId,
        productVariantAxisAllowanceEvents.allowanceRevision,
        productVariantAxisAllowanceEvents.axisRevision,
      ],
      name: 'catalog_product_variant_axis_allowed_values_event_fk',
    }).onDelete('restrict'),
    check(
      'catalog_product_variant_axis_allowed_values_key_ck',
      sql`length(${table.valueKey}) = 64 and ${table.valueKey} ~ '^[0-9a-f]{64}$'`,
    ),
    ...tenantRlsPolicies('catalog_product_variant_axis_allowed_values_tenant', table.tenantId),
  ],
);

// A missing Variant set means inheritance.  A present set (including SPECIAL)
// is an explicit complete override; item rows never merge with Product items.
export const attributeValueSets = catalogSchema.table.withRLS(
  'attribute_value_sets',
  {
    attributeValueSetId: uuid('attribute_value_set_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id'),
    attributeDefinitionId: uuid('attribute_definition_id').notNull(),
    currentRevision: integer('current_revision').default(1).notNull(),
    currentState: text('current_state').default('SET').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('catalog_attribute_value_sets_scope_id_uk').on(table.tenantId, table.attributeValueSetId),
    unique('catalog_attribute_value_sets_definition_id_uk').on(
      table.tenantId,
      table.attributeValueSetId,
      table.attributeDefinitionId,
    ),
    uniqueIndex('catalog_attribute_value_sets_product_uk')
      .on(table.tenantId, table.productId, table.attributeDefinitionId)
      .where(sql`${table.variantId} is null`),
    uniqueIndex('catalog_attribute_value_sets_variant_uk')
      .on(table.tenantId, table.variantId, table.attributeDefinitionId)
      .where(sql`${table.variantId} is not null`),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.productId],
      name: 'catalog_attribute_value_sets_product_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.variantId],
      name: 'catalog_attribute_value_sets_variant_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.attributeDefinitionId],
      foreignColumns: [attributeDefinitions.tenantId, attributeDefinitions.attributeDefinitionId],
      name: 'catalog_attribute_value_sets_definition_fk',
    }).onDelete('restrict'),
    check('catalog_attribute_value_sets_revision_ck', sql`${table.currentRevision} > 0`),
    check('catalog_attribute_value_sets_state_ck', sql`${table.currentState} in ('SET', 'REMOVED')`),
    ...tenantRlsPolicies('catalog_attribute_value_sets_tenant', table.tenantId),
  ],
);

export const attributeValueItems = catalogSchema.table.withRLS(
  'attribute_value_items',
  {
    tenantId: uuid('tenant_id').notNull(),
    attributeValueSetId: uuid('attribute_value_set_id').notNull(),
    attributeDefinitionId: uuid('attribute_definition_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    valueKind: text('value_kind').notNull(),
    textValue: text('text_value'),
    numericValue: numeric('numeric_value'),
    unit: text('unit'),
    controlledAttributeValueId: uuid('controlled_attribute_value_id'),
    specialState: text('special_state'),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.attributeValueSetId, table.ordinal],
      name: 'catalog_attribute_value_items_pk',
    }),
    foreignKey({
      columns: [table.tenantId, table.attributeValueSetId, table.attributeDefinitionId],
      foreignColumns: [
        attributeValueSets.tenantId,
        attributeValueSets.attributeValueSetId,
        attributeValueSets.attributeDefinitionId,
      ],
      name: 'catalog_attribute_value_items_set_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.tenantId, table.attributeDefinitionId, table.controlledAttributeValueId],
      foreignColumns: [
        controlledAttributeValues.tenantId,
        controlledAttributeValues.attributeDefinitionId,
        controlledAttributeValues.controlledAttributeValueId,
      ],
      name: 'catalog_attribute_value_items_controlled_fk',
    }).onDelete('restrict'),
    check('catalog_attribute_value_items_ordinal_ck', sql`${table.ordinal} >= 0`),
    check(
      'catalog_attribute_value_items_shape_ck',
      sql`(${table.valueKind} = 'TEXT' and ${table.textValue} is not null and ${table.numericValue} is null and ${table.unit} is null and ${table.controlledAttributeValueId} is null and ${table.specialState} is null) or (${table.valueKind} = 'MEASUREMENT' and ${table.textValue} is null and ${table.numericValue} is not null and ${table.unit} is not null and ${table.controlledAttributeValueId} is null and ${table.specialState} is null) or (${table.valueKind} = 'CONTROLLED' and ${table.textValue} is null and ${table.numericValue} is null and ${table.unit} is null and ${table.controlledAttributeValueId} is not null and ${table.specialState} is null) or (${table.valueKind} = 'SPECIAL' and ${table.textValue} is null and ${table.numericValue} is null and ${table.unit} is null and ${table.controlledAttributeValueId} is null and ${table.specialState} in ('UNKNOWN', 'NOT_APPLICABLE', 'NONE'))`,
    ),
    ...tenantRlsPolicies('catalog_attribute_value_items_tenant', table.tenantId),
  ],
);

export const attributeValueRevisions = catalogSchema.table.withRLS(
  'attribute_value_revisions',
  {
    tenantId: uuid('tenant_id').notNull(),
    attributeValueSetId: uuid('attribute_value_set_id').notNull(),
    revision: integer('revision').notNull(),
    changeKind: text('change_kind').notNull(),
    valueSnapshot: jsonb('value_snapshot').notNull(),
    reason: text('reason').notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.attributeValueSetId, table.revision],
      name: 'catalog_attribute_value_revisions_pk',
    }),
    unique('catalog_attribute_value_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.attributeValueSetId],
      foreignColumns: [attributeValueSets.tenantId, attributeValueSets.attributeValueSetId],
      name: 'catalog_attribute_value_revisions_set_fk',
    }).onDelete('restrict'),
    check('catalog_attribute_value_revisions_number_ck', sql`${table.revision} > 0`),
    check('catalog_attribute_value_revisions_kind_ck', sql`${table.changeKind} in ('SET', 'REMOVED')`),
    check(
      'catalog_attribute_value_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_attribute_value_revisions_tenant', table.tenantId),
  ],
);

export const productTypeAssignments = catalogSchema.table.withRLS(
  'product_type_assignments',
  {
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    productTypeId: uuid('product_type_id').notNull(),
    // Assignment writes append the matching event in the same transaction; removal leaves only the event.
    assignmentRevision: integer('assignment_revision').default(1).notNull(),
    assignedByActionInvocationId: uuid('assigned_by_action_invocation_id').notNull(),
    assignedByPrincipalId: uuid('assigned_by_principal_id').notNull(),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.productId], name: 'catalog_product_type_assignments_pk' }),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.productId],
      name: 'catalog_product_type_assignments_product_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.productTypeId],
      foreignColumns: [productTypes.tenantId, productTypes.productTypeId],
      name: 'catalog_product_type_assignments_type_fk',
    }).onDelete('restrict'),
    index('catalog_product_type_assignments_type_idx').on(table.tenantId, table.productTypeId),
    check('catalog_product_type_assignments_revision_ck', sql`${table.assignmentRevision} > 0`),
    ...tenantRlsPolicies('catalog_product_type_assignments_tenant', table.tenantId),
  ],
);

export const productTypeAssignmentEvents = catalogSchema.table.withRLS(
  'product_type_assignment_events',
  {
    productTypeAssignmentEventId: uuid('product_type_assignment_event_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    previousProductTypeId: uuid('previous_product_type_id'),
    nextProductTypeId: uuid('next_product_type_id'),
    assignmentRevision: integer('assignment_revision').notNull(),
    reason: text('reason').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('catalog_product_type_assignment_events_scope_id_uk').on(table.tenantId, table.productTypeAssignmentEventId),
    unique('catalog_product_type_assignment_events_number_uk').on(
      table.tenantId,
      table.productId,
      table.assignmentRevision,
    ),
    unique('catalog_product_type_assignment_events_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.productId],
      name: 'catalog_product_type_assignment_events_product_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.previousProductTypeId],
      foreignColumns: [productTypes.tenantId, productTypes.productTypeId],
      name: 'catalog_product_type_assignment_events_previous_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.nextProductTypeId],
      foreignColumns: [productTypes.tenantId, productTypes.productTypeId],
      name: 'catalog_product_type_assignment_events_next_fk',
    }).onDelete('restrict'),
    check('catalog_product_type_assignment_events_revision_ck', sql`${table.assignmentRevision} > 0`),
    check(
      'catalog_product_type_assignment_events_transition_ck',
      sql`${table.previousProductTypeId} is distinct from ${table.nextProductTypeId}`,
    ),
    check(
      'catalog_product_type_assignment_events_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_product_type_assignment_events_tenant', table.tenantId),
  ],
);

/** Append-only owner decisions; absence of a Type or values is never itself an affirmative decision. */
export const productTypeUntypedDecisions = catalogSchema.table.withRLS(
  'product_type_untyped_decisions',
  {
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    decisionRevision: integer('decision_revision').notNull(),
    decisionState: text('decision_state').notNull(),
    structuredAttributesRequired: boolean('structured_attributes_required').notNull(),
    variantAxesRequired: boolean('variant_axes_required').notNull(),
    productRevision: integer('product_revision').notNull(),
    axisRevision: integer('axis_revision').notNull(),
    valueRevisionTokens: text('value_revision_tokens').array().notNull(),
    variantRevisionTokens: text('variant_revision_tokens').array().notNull(),
    reason: text('reason').notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.productId, table.decisionRevision],
      name: 'catalog_product_type_untyped_decisions_pk',
    }),
    unique('catalog_product_type_untyped_decisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.productId],
      name: 'catalog_product_type_untyped_decisions_product_fk',
    }).onDelete('restrict'),
    check(
      'catalog_product_type_untyped_decisions_revision_ck',
      sql`${table.decisionRevision} > 0 and ${table.productRevision} > 0 and ${table.axisRevision} >= 0`,
    ),
    check('catalog_product_type_untyped_decisions_state_ck', sql`${table.decisionState} in ('CONFIRMED', 'REVOKED')`),
    check(
      'catalog_product_type_untyped_decisions_confirmed_ck',
      sql`${table.decisionState} <> 'CONFIRMED' or (not ${table.structuredAttributesRequired} and not ${table.variantAxesRequired})`,
    ),
    check(
      'catalog_product_type_untyped_decisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_product_type_untyped_decisions_tenant', table.tenantId),
  ],
);

export const productCategoryHierarchyRevisions = catalogSchema.table.withRLS(
  'product_category_hierarchy_revisions',
  {
    tenantId: uuid('tenant_id').primaryKey(),
    // Every Category writer locks this row first, advances exactly one counter, and appends its event atomically.
    hierarchyRevision: integer('hierarchy_revision').default(0).notNull(),
    assignmentRevision: integer('assignment_revision').default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      'catalog_category_hierarchy_revision_ck',
      sql`${table.hierarchyRevision} >= 0 and ${table.assignmentRevision} >= 0`,
    ),
    ...tenantRlsPolicies('catalog_category_hierarchy_revisions_tenant', table.tenantId),
  ],
);

export const productCategories = catalogSchema.table.withRLS(
  'product_categories',
  {
    categoryId: uuid('category_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    parentCategoryId: uuid('parent_category_id'),
    name: text('name').notNull(),
    lifecycleState: text('lifecycle_state').default('ACTIVE').notNull(),
    currentRevision: integer('current_revision').default(1).notNull(),
    createdByActionInvocationId: uuid('created_by_action_invocation_id').notNull(),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('catalog_product_categories_scope_id_uk').on(table.tenantId, table.categoryId),
    foreignKey({
      columns: [table.tenantId, table.parentCategoryId],
      foreignColumns: [table.tenantId, table.categoryId],
      name: 'catalog_product_categories_parent_fk',
    }).onDelete('restrict'),
    index('catalog_product_categories_parent_idx').on(table.tenantId, table.parentCategoryId),
    check(
      'catalog_product_categories_name_ck',
      sql`${table.name} = btrim(${table.name}) and length(${table.name}) between 1 and 240`,
    ),
    check('catalog_product_categories_state_ck', sql`${table.lifecycleState} in ('ACTIVE', 'RETIRED')`),
    check('catalog_product_categories_revision_ck', sql`${table.currentRevision} > 0`),
    check(
      'catalog_product_categories_not_self_parent_ck',
      sql`${table.parentCategoryId} is null or ${table.parentCategoryId} <> ${table.categoryId}`,
    ),
    ...tenantRlsPolicies('catalog_product_categories_tenant', table.tenantId),
  ],
);

export const productCategoryAssignments = catalogSchema.table.withRLS(
  'product_category_assignments',
  {
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    categoryId: uuid('category_id').notNull(),
    assignedByActionInvocationId: uuid('assigned_by_action_invocation_id').notNull(),
    assignedByPrincipalId: uuid('assigned_by_principal_id').notNull(),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.productId, table.categoryId],
      name: 'catalog_product_category_assignments_pk',
    }),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.productId],
      name: 'catalog_product_category_assignments_product_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.categoryId],
      foreignColumns: [productCategories.tenantId, productCategories.categoryId],
      name: 'catalog_product_category_assignments_category_fk',
    }).onDelete('restrict'),
    index('catalog_product_category_assignments_category_idx').on(table.tenantId, table.categoryId),
    ...tenantRlsPolicies('catalog_product_category_assignments_tenant', table.tenantId),
  ],
);

export const productCategoryEvents = catalogSchema.table.withRLS(
  'product_category_events',
  {
    productCategoryEventId: uuid('product_category_event_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    categoryId: uuid('category_id').notNull(),
    productId: uuid('product_id'),
    previousParentCategoryId: uuid('previous_parent_category_id'),
    nextParentCategoryId: uuid('next_parent_category_id'),
    previousName: text('previous_name'),
    nextName: text('next_name'),
    previousLifecycleState: text('previous_lifecycle_state'),
    nextLifecycleState: text('next_lifecycle_state'),
    categoryRevision: integer('category_revision'),
    changeKind: text('change_kind').notNull(),
    hierarchyRevision: integer('hierarchy_revision').notNull(),
    assignmentRevision: integer('assignment_revision').notNull(),
    reason: text('reason').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('catalog_product_category_events_scope_id_uk').on(table.tenantId, table.productCategoryEventId),
    unique('catalog_product_category_events_invocation_uk').on(table.tenantId, table.actionInvocationId),
    uniqueIndex('catalog_product_category_events_category_revision_uk')
      .on(table.tenantId, table.categoryId, table.categoryRevision)
      .where(sql`${table.changeKind} in ('CREATED', 'RENAMED', 'MOVED', 'RETIRED')`),
    foreignKey({
      columns: [table.tenantId, table.categoryId],
      foreignColumns: [productCategories.tenantId, productCategories.categoryId],
      name: 'catalog_product_category_events_category_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.productId],
      name: 'catalog_product_category_events_product_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.previousParentCategoryId],
      foreignColumns: [productCategories.tenantId, productCategories.categoryId],
      name: 'catalog_product_category_events_previous_parent_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.nextParentCategoryId],
      foreignColumns: [productCategories.tenantId, productCategories.categoryId],
      name: 'catalog_product_category_events_next_parent_fk',
    }).onDelete('restrict'),
    index('catalog_product_category_events_history_idx').on(table.tenantId, table.categoryId, table.recordedAt),
    check(
      'catalog_product_category_events_kind_ck',
      sql`${table.changeKind} in ('CREATED', 'RENAMED', 'MOVED', 'RETIRED', 'ASSIGNED', 'UNASSIGNED')`,
    ),
    check(
      'catalog_product_category_events_revisions_ck',
      sql`${table.hierarchyRevision} >= 0 and ${table.assignmentRevision} >= 0`,
    ),
    check('catalog_product_category_events_category_revision_ck', sql`${table.categoryRevision} > 0`),
    check(
      'catalog_product_category_events_snapshot_ck',
      sql`${table.changeKind} not in ('CREATED', 'RENAMED', 'MOVED', 'RETIRED') or (${table.nextName} is not null and ${table.nextLifecycleState} is not null)`,
    ),
    check(
      'catalog_product_category_events_previous_lifecycle_ck',
      sql`${table.previousLifecycleState} is null or ${table.previousLifecycleState} in ('ACTIVE', 'RETIRED')`,
    ),
    check(
      'catalog_product_category_events_next_lifecycle_ck',
      sql`${table.nextLifecycleState} is null or ${table.nextLifecycleState} in ('ACTIVE', 'RETIRED')`,
    ),
    check(
      'catalog_product_category_events_previous_name_ck',
      sql`${table.previousName} is null or (${table.previousName} = btrim(${table.previousName}) and length(${table.previousName}) between 1 and 240)`,
    ),
    check(
      'catalog_product_category_events_next_name_ck',
      sql`${table.nextName} is null or (${table.nextName} = btrim(${table.nextName}) and length(${table.nextName}) between 1 and 240)`,
    ),
    check(
      'catalog_product_category_events_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_product_category_events_tenant', table.tenantId),
  ],
);

export const manufacturerRelations = catalogSchema.table.withRLS(
  'manufacturer_relations',
  {
    relationId: uuid('relation_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id'),
    variantId: uuid('variant_id'),
    targetKind: text('target_kind').notNull(),
    targetId: text('target_id').notNull(),
    currentRevision: integer('current_revision').notNull(),
    disposition: text('disposition').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    reason: text('reason').notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('catalog_manufacturer_relations_scope_id_uk').on(table.tenantId, table.relationId),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.productId],
      name: 'catalog_manufacturer_relations_product_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.variantId],
      name: 'catalog_manufacturer_relations_variant_fk',
    }).onDelete('restrict'),
    index('catalog_manufacturer_relations_product_idx').on(table.tenantId, table.productId),
    index('catalog_manufacturer_relations_variant_idx').on(table.tenantId, table.variantId),
    check(
      'catalog_manufacturer_relations_subject_ck',
      sql`(${table.productId} is null) <> (${table.variantId} is null)`,
    ),
    check('catalog_manufacturer_relations_target_ck', sql`${table.targetKind} in ('PARTY', 'LEGAL_ENTITY')`),
    check('catalog_manufacturer_relations_target_id_ck', sql`length(${table.targetId}) between 1 and 300`),
    check('catalog_manufacturer_relations_revision_ck', sql`${table.currentRevision} > 0`),
    check('catalog_manufacturer_relations_disposition_ck', sql`${table.disposition} in ('CONFIRMED', 'RETRACTED')`),
    check(
      'catalog_manufacturer_relations_period_ck',
      sql`${table.effectiveFrom} is null or ${table.effectiveTo} is null or ${table.effectiveFrom} < ${table.effectiveTo}`,
    ),
    check(
      'catalog_manufacturer_relations_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_manufacturer_relations_tenant', table.tenantId),
  ],
);

export const manufacturerRelationRevisions = catalogSchema.table.withRLS(
  'manufacturer_relation_revisions',
  {
    tenantId: uuid('tenant_id').notNull(),
    relationId: uuid('relation_id').notNull(),
    revision: integer('revision').notNull(),
    productId: uuid('product_id'),
    variantId: uuid('variant_id'),
    targetKind: text('target_kind').notNull(),
    targetId: text('target_id').notNull(),
    disposition: text('disposition').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    reason: text('reason').notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.relationId, table.revision],
      name: 'catalog_manufacturer_relation_revisions_pk',
    }),
    unique('catalog_manufacturer_relation_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.relationId],
      foreignColumns: [manufacturerRelations.tenantId, manufacturerRelations.relationId],
      name: 'catalog_manufacturer_relation_revisions_relation_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.productId],
      name: 'catalog_manufacturer_relation_revisions_product_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.variantId],
      name: 'catalog_manufacturer_relation_revisions_variant_fk',
    }).onDelete('restrict'),
    check(
      'catalog_manufacturer_relation_revisions_subject_ck',
      sql`(${table.productId} is null) <> (${table.variantId} is null)`,
    ),
    check('catalog_manufacturer_relation_revisions_target_ck', sql`${table.targetKind} in ('PARTY', 'LEGAL_ENTITY')`),
    check('catalog_manufacturer_relation_revisions_target_id_ck', sql`length(${table.targetId}) between 1 and 300`),
    check('catalog_manufacturer_relation_revisions_number_ck', sql`${table.revision} > 0`),
    check(
      'catalog_manufacturer_relation_revisions_disposition_ck',
      sql`${table.disposition} in ('CONFIRMED', 'RETRACTED')`,
    ),
    check(
      'catalog_manufacturer_relation_revisions_period_ck',
      sql`${table.effectiveFrom} is null or ${table.effectiveTo} is null or ${table.effectiveFrom} < ${table.effectiveTo}`,
    ),
    check(
      'catalog_manufacturer_relation_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_manufacturer_relation_revisions_tenant', table.tenantId),
  ],
);

/** One lock/CAS counter per Product or Variant assignment set; an empty Variant set overrides Product. */
export const catalogMediaAssignmentSets = catalogSchema.table.withRLS(
  'catalog_media_assignment_sets',
  {
    assignmentSetId: uuid('assignment_set_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id'),
    currentRevision: integer('current_revision').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('catalog_media_assignment_sets_scope_id_uk').on(table.tenantId, table.assignmentSetId),
    uniqueIndex('catalog_media_assignment_sets_product_uk')
      .on(table.tenantId, table.productId)
      .where(sql`${table.variantId} is null`),
    uniqueIndex('catalog_media_assignment_sets_variant_uk')
      .on(table.tenantId, table.productId, table.variantId)
      .where(sql`${table.variantId} is not null`),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.productId],
      name: 'catalog_media_assignment_sets_product_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.variantId],
      name: 'catalog_media_assignment_sets_variant_fk',
    }).onDelete('restrict'),
    check('catalog_media_assignment_sets_revision_ck', sql`${table.currentRevision} > 0`),
    ...tenantRlsPolicies('catalog_media_assignment_sets_tenant', table.tenantId),
  ],
);

export const catalogMediaAssignmentSetRevisions = catalogSchema.table.withRLS(
  'catalog_media_assignment_set_revisions',
  {
    tenantId: uuid('tenant_id').notNull(),
    assignmentSetId: uuid('assignment_set_id').notNull(),
    revision: integer('revision').notNull(),
    reason: text('reason').notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.assignmentSetId, table.revision],
      name: 'catalog_media_assignment_set_revisions_pk',
    }),
    unique('catalog_media_assignment_set_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.assignmentSetId],
      foreignColumns: [catalogMediaAssignmentSets.tenantId, catalogMediaAssignmentSets.assignmentSetId],
      name: 'catalog_media_assignment_set_revisions_set_fk',
    }).onDelete('restrict'),
    check('catalog_media_assignment_set_revisions_revision_ck', sql`${table.revision} > 0`),
    check(
      'catalog_media_assignment_set_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_media_assignment_set_revisions_tenant', table.tenantId),
  ],
);

export const catalogMediaAssignments = catalogSchema.table.withRLS(
  'catalog_media_assignments',
  {
    assignmentId: uuid('assignment_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    assignmentSetId: uuid('assignment_set_id').notNull(),
    currentRevision: integer('current_revision').notNull(),
    resourceKind: text('resource_kind').notNull(),
    ownerModuleId: text('owner_module_id').notNull(),
    ownerResourceType: text('owner_resource_type').notNull(),
    ownerResourceId: uuid('owner_resource_id').notNull(),
    ownerTenantId: uuid('owner_tenant_id').notNull(),
    purpose: text('purpose').notNull(),
    position: integer('position').notNull(),
    state: text('state').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('catalog_media_assignments_scope_id_uk').on(table.tenantId, table.assignmentId),
    uniqueIndex('catalog_media_assignments_active_position_uk')
      .on(table.tenantId, table.assignmentSetId, table.resourceKind, table.position)
      .where(sql`${table.state} = 'ACTIVE'`),
    foreignKey({
      columns: [table.tenantId, table.assignmentSetId],
      foreignColumns: [catalogMediaAssignmentSets.tenantId, catalogMediaAssignmentSets.assignmentSetId],
      name: 'catalog_media_assignments_set_fk',
    }).onDelete('restrict'),
    check('catalog_media_assignments_revision_ck', sql`${table.currentRevision} > 0`),
    check('catalog_media_assignments_kind_ck', sql`${table.resourceKind} in ('MEDIA', 'DOCUMENT')`),
    check('catalog_media_assignments_owner_tenant_ck', sql`${table.ownerTenantId} = ${table.tenantId}`),
    check(
      'catalog_media_assignments_owner_ck',
      sql`${table.ownerModuleId} = btrim(${table.ownerModuleId}) and length(${table.ownerModuleId}) between 1 and 160 and ${table.ownerResourceType} = btrim(${table.ownerResourceType}) and length(${table.ownerResourceType}) between 1 and 160`,
    ),
    check(
      'catalog_media_assignments_purpose_ck',
      sql`${table.purpose} = btrim(${table.purpose}) and length(${table.purpose}) between 1 and 160`,
    ),
    check('catalog_media_assignments_position_ck', sql`${table.position} > 0`),
    check('catalog_media_assignments_state_ck', sql`${table.state} in ('ACTIVE', 'REMOVED')`),
    ...tenantRlsPolicies('catalog_media_assignments_tenant', table.tenantId),
  ],
);

export const catalogMediaAssignmentRevisions = catalogSchema.table.withRLS(
  'catalog_media_assignment_revisions',
  {
    tenantId: uuid('tenant_id').notNull(),
    assignmentId: uuid('assignment_id').notNull(),
    assignmentSetId: uuid('assignment_set_id').notNull(),
    revision: integer('revision').notNull(),
    setRevision: integer('set_revision').notNull(),
    resourceKind: text('resource_kind').notNull(),
    ownerModuleId: text('owner_module_id').notNull(),
    ownerResourceType: text('owner_resource_type').notNull(),
    ownerResourceId: uuid('owner_resource_id').notNull(),
    ownerTenantId: uuid('owner_tenant_id').notNull(),
    purpose: text('purpose').notNull(),
    position: integer('position').notNull(),
    state: text('state').notNull(),
    reason: text('reason').notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.assignmentId, table.revision],
      name: 'catalog_media_assignment_revisions_pk',
    }),
    foreignKey({
      columns: [table.tenantId, table.assignmentId],
      foreignColumns: [catalogMediaAssignments.tenantId, catalogMediaAssignments.assignmentId],
      name: 'catalog_media_assignment_revisions_assignment_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.assignmentSetId],
      foreignColumns: [catalogMediaAssignmentSets.tenantId, catalogMediaAssignmentSets.assignmentSetId],
      name: 'catalog_media_assignment_revisions_set_fk',
    }).onDelete('restrict'),
    check('catalog_media_assignment_revisions_revision_ck', sql`${table.revision} > 0 and ${table.setRevision} > 0`),
    check('catalog_media_assignment_revisions_kind_ck', sql`${table.resourceKind} in ('MEDIA', 'DOCUMENT')`),
    check('catalog_media_assignment_revisions_owner_tenant_ck', sql`${table.ownerTenantId} = ${table.tenantId}`),
    check(
      'catalog_media_assignment_revisions_owner_ck',
      sql`${table.ownerModuleId} = btrim(${table.ownerModuleId}) and length(${table.ownerModuleId}) between 1 and 160 and ${table.ownerResourceType} = btrim(${table.ownerResourceType}) and length(${table.ownerResourceType}) between 1 and 160`,
    ),
    check(
      'catalog_media_assignment_revisions_purpose_ck',
      sql`${table.purpose} = btrim(${table.purpose}) and length(${table.purpose}) between 1 and 160`,
    ),
    check('catalog_media_assignment_revisions_position_ck', sql`${table.position} > 0`),
    check('catalog_media_assignment_revisions_state_ck', sql`${table.state} in ('ACTIVE', 'REMOVED')`),
    check(
      'catalog_media_assignment_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_media_assignment_revisions_tenant', table.tenantId),
  ],
);

/** Stable Product-scoped definition identity; selected configurations remain values, not rows here. */
export const productConfigurationDefinitions = catalogSchema.table.withRLS(
  'product_configuration_definitions',
  {
    definitionId: uuid('definition_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    productId: uuid('product_id').notNull(),
    currentRevision: integer('current_revision').notNull(),
    createdAt: recordedAt(),
  },
  (table) => [
    unique('catalog_configuration_definitions_scope_id_uk').on(table.tenantId, table.definitionId),
    unique('catalog_configuration_definitions_product_id_uk').on(table.tenantId, table.productId, table.definitionId),
    foreignKey({
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.productId],
      name: 'catalog_configuration_definitions_product_fk',
    }).onDelete('restrict'),
    check('catalog_configuration_definitions_revision_ck', sql`${table.currentRevision} > 0`),
    ...tenantRlsPolicies('catalog_configuration_definitions_tenant', table.tenantId),
  ],
);

/** An immutable, exact rule snapshot; effective_to is exclusive. */
export const productConfigurationDefinitionRevisions = catalogSchema.table.withRLS(
  'product_configuration_definition_revisions',
  {
    tenantId: uuid('tenant_id').notNull(),
    definitionId: uuid('definition_id').notNull(),
    productId: uuid('product_id').notNull(),
    revision: integer('revision').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    state: text('state').notNull(),
    reason: text('reason').notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.definitionId, table.revision],
      name: 'catalog_configuration_definition_revisions_pk',
    }),
    unique('catalog_configuration_definition_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.productId, table.definitionId],
      foreignColumns: [
        productConfigurationDefinitions.tenantId,
        productConfigurationDefinitions.productId,
        productConfigurationDefinitions.definitionId,
      ],
      name: 'catalog_configuration_definition_revisions_definition_fk',
    }).onDelete('restrict'),
    check('catalog_configuration_definition_revisions_number_ck', sql`${table.revision} > 0`),
    check(
      'catalog_configuration_definition_revisions_period_ck',
      sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    check('catalog_configuration_definition_revisions_state_ck', sql`${table.state} in ('ACTIVE', 'RETIRED')`),
    check(
      'catalog_configuration_definition_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_configuration_definition_revisions_tenant', table.tenantId),
  ],
);

/** Append-only effectiveness timeline: an event explicitly supersedes its predecessor. */
export const productConfigurationRevisionActivations = catalogSchema.table.withRLS(
  'product_configuration_revision_activations',
  {
    tenantId: uuid('tenant_id').notNull(),
    definitionId: uuid('definition_id').notNull(),
    revision: integer('revision').notNull(),
    supersededRevision: integer('superseded_revision'),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    reason: text('reason').notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.definitionId, table.revision],
      name: 'catalog_configuration_revision_activations_pk',
    }),
    unique('catalog_configuration_revision_activations_time_uk').on(
      table.tenantId,
      table.definitionId,
      table.effectiveAt,
    ),
    unique('catalog_configuration_revision_activations_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.definitionId, table.revision],
      foreignColumns: [
        productConfigurationDefinitionRevisions.tenantId,
        productConfigurationDefinitionRevisions.definitionId,
        productConfigurationDefinitionRevisions.revision,
      ],
      name: 'catalog_configuration_revision_activations_revision_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.definitionId, table.supersededRevision],
      foreignColumns: [
        productConfigurationDefinitionRevisions.tenantId,
        productConfigurationDefinitionRevisions.definitionId,
        productConfigurationDefinitionRevisions.revision,
      ],
      name: 'catalog_configuration_revision_activations_predecessor_fk',
    }).onDelete('restrict'),
    check(
      'catalog_configuration_revision_activations_predecessor_ck',
      sql`${table.supersededRevision} is null or ${table.supersededRevision} <> ${table.revision}`,
    ),
    check(
      'catalog_configuration_revision_activations_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...tenantRlsPolicies('catalog_configuration_revision_activations_tenant', table.tenantId),
  ],
);

/** Choice keys are stable semantic identities across revisions, not display labels. */
export const productConfigurationChoices = catalogSchema.table.withRLS(
  'product_configuration_choices',
  {
    tenantId: uuid('tenant_id').notNull(),
    definitionId: uuid('definition_id').notNull(),
    revision: integer('revision').notNull(),
    choiceKey: text('choice_key').notNull(),
    meaning: text('meaning').notNull(),
    label: text('label').notNull(),
    valueKind: text('value_kind').notNull(),
    required: boolean('required').notNull(),
    unitId: uuid('unit_id'),
    unitRevision: integer('unit_revision'),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.definitionId, table.revision, table.choiceKey],
      name: 'catalog_configuration_choices_pk',
    }),
    foreignKey({
      columns: [table.tenantId, table.definitionId, table.revision],
      foreignColumns: [
        productConfigurationDefinitionRevisions.tenantId,
        productConfigurationDefinitionRevisions.definitionId,
        productConfigurationDefinitionRevisions.revision,
      ],
      name: 'catalog_configuration_choices_revision_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.unitId, table.unitRevision],
      foreignColumns: [
        configurationUnitRevisions.tenantId,
        configurationUnitRevisions.unitId,
        configurationUnitRevisions.revision,
      ],
      name: 'catalog_configuration_choices_unit_fk',
    }).onDelete('restrict'),
    check(
      'catalog_configuration_choices_key_ck',
      sql`${table.choiceKey} = btrim(${table.choiceKey}) and length(${table.choiceKey}) between 1 and 160`,
    ),
    check(
      'catalog_configuration_choices_meaning_ck',
      sql`${table.meaning} = btrim(${table.meaning}) and length(${table.meaning}) between 1 and 1000`,
    ),
    check(
      'catalog_configuration_choices_label_ck',
      sql`${table.label} = btrim(${table.label}) and length(${table.label}) between 1 and 240`,
    ),
    check(
      'catalog_configuration_choices_kind_ck',
      sql`(${table.valueKind} = 'SINGLE_CHOICE' and ${table.unitId} is null and ${table.unitRevision} is null) or (${table.valueKind} = 'MEASURED_VALUE' and ${table.unitId} is not null and ${table.unitRevision} > 0)`,
    ),
    ...tenantRlsPolicies('catalog_configuration_choices_tenant', table.tenantId),
  ],
);

export const productConfigurationChoiceOptions = catalogSchema.table.withRLS(
  'product_configuration_choice_options',
  {
    tenantId: uuid('tenant_id').notNull(),
    definitionId: uuid('definition_id').notNull(),
    revision: integer('revision').notNull(),
    choiceKey: text('choice_key').notNull(),
    optionKey: text('option_key').notNull(),
    meaning: text('meaning').notNull(),
    label: text('label').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.definitionId, table.revision, table.choiceKey, table.optionKey],
      name: 'catalog_configuration_choice_options_pk',
    }),
    foreignKey({
      columns: [table.tenantId, table.definitionId, table.revision, table.choiceKey],
      foreignColumns: [
        productConfigurationChoices.tenantId,
        productConfigurationChoices.definitionId,
        productConfigurationChoices.revision,
        productConfigurationChoices.choiceKey,
      ],
      name: 'catalog_configuration_choice_options_choice_fk',
    }).onDelete('restrict'),
    check(
      'catalog_configuration_choice_options_key_ck',
      sql`${table.optionKey} = btrim(${table.optionKey}) and length(${table.optionKey}) between 1 and 160`,
    ),
    check(
      'catalog_configuration_choice_options_meaning_ck',
      sql`${table.meaning} = btrim(${table.meaning}) and length(${table.meaning}) between 1 and 1000`,
    ),
    check(
      'catalog_configuration_choice_options_label_ck',
      sql`${table.label} = btrim(${table.label}) and length(${table.label}) between 1 and 240`,
    ),
    ...tenantRlsPolicies('catalog_configuration_choice_options_tenant', table.tenantId),
  ],
);

/** A target-specific option decision is explicit; absent rows are not an implicit allow. */
export const productConfigurationOptionAllowances = catalogSchema.table.withRLS(
  'product_configuration_option_allowances',
  {
    allowanceId: uuid('allowance_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    definitionId: uuid('definition_id').notNull(),
    productId: uuid('product_id').notNull(),
    revision: integer('revision').notNull(),
    choiceKey: text('choice_key').notNull(),
    optionKey: text('option_key').notNull(),
    variantId: uuid('variant_id'),
    packageDefinitionId: uuid('package_definition_id'),
    allowed: boolean('allowed').notNull(),
    evidenceRefs: text('evidence_refs').array().notNull(),
  },
  (table) => [
    uniqueIndex('catalog_configuration_allowances_product_uk')
      .on(table.tenantId, table.definitionId, table.revision, table.choiceKey, table.optionKey)
      .where(sql`${table.variantId} is null and ${table.packageDefinitionId} is null`),
    uniqueIndex('catalog_configuration_allowances_variant_uk')
      .on(table.tenantId, table.definitionId, table.revision, table.choiceKey, table.optionKey, table.variantId)
      .where(sql`${table.variantId} is not null and ${table.packageDefinitionId} is null`),
    uniqueIndex('catalog_configuration_allowances_package_uk')
      .on(
        table.tenantId,
        table.definitionId,
        table.revision,
        table.choiceKey,
        table.optionKey,
        table.variantId,
        table.packageDefinitionId,
      )
      .where(sql`${table.packageDefinitionId} is not null`),
    foreignKey({
      columns: [table.tenantId, table.productId, table.definitionId],
      foreignColumns: [
        productConfigurationDefinitions.tenantId,
        productConfigurationDefinitions.productId,
        productConfigurationDefinitions.definitionId,
      ],
      name: 'catalog_configuration_allowances_product_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.definitionId, table.revision, table.choiceKey, table.optionKey],
      foreignColumns: [
        productConfigurationChoiceOptions.tenantId,
        productConfigurationChoiceOptions.definitionId,
        productConfigurationChoiceOptions.revision,
        productConfigurationChoiceOptions.choiceKey,
        productConfigurationChoiceOptions.optionKey,
      ],
      name: 'catalog_configuration_allowances_option_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.variantId],
      name: 'catalog_configuration_allowances_variant_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.productId, table.variantId, table.packageDefinitionId],
      foreignColumns: [
        packageDefinitions.tenantId,
        packageDefinitions.productId,
        packageDefinitions.variantId,
        packageDefinitions.packageDefinitionId,
      ],
      name: 'catalog_configuration_allowances_package_fk',
    }).onDelete('restrict'),
    check(
      'catalog_configuration_allowances_target_ck',
      sql`${table.packageDefinitionId} is null or ${table.variantId} is not null`,
    ),
    ...tenantRlsPolicies('catalog_configuration_allowances_tenant', table.tenantId),
  ],
);

/** One explicit rule per choice and exact target; null bound or step means confirmed absence. */
export const productConfigurationMeasuredRules = catalogSchema.table.withRLS(
  'product_configuration_measured_rules',
  {
    ruleId: uuid('rule_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    definitionId: uuid('definition_id').notNull(),
    productId: uuid('product_id').notNull(),
    revision: integer('revision').notNull(),
    choiceKey: text('choice_key').notNull(),
    variantId: uuid('variant_id'),
    packageDefinitionId: uuid('package_definition_id'),
    minimum: numeric('minimum'),
    minimumInclusive: boolean('minimum_inclusive'),
    maximum: numeric('maximum'),
    maximumInclusive: boolean('maximum_inclusive'),
    step: numeric('step'),
    stepBase: numeric('step_base'),
    evidenceRefs: text('evidence_refs').array().notNull(),
  },
  (table) => [
    uniqueIndex('catalog_configuration_measured_rules_product_uk')
      .on(table.tenantId, table.definitionId, table.revision, table.choiceKey)
      .where(sql`${table.variantId} is null and ${table.packageDefinitionId} is null`),
    uniqueIndex('catalog_configuration_measured_rules_variant_uk')
      .on(table.tenantId, table.definitionId, table.revision, table.choiceKey, table.variantId)
      .where(sql`${table.variantId} is not null and ${table.packageDefinitionId} is null`),
    uniqueIndex('catalog_configuration_measured_rules_package_uk')
      .on(
        table.tenantId,
        table.definitionId,
        table.revision,
        table.choiceKey,
        table.variantId,
        table.packageDefinitionId,
      )
      .where(sql`${table.packageDefinitionId} is not null`),
    foreignKey({
      columns: [table.tenantId, table.productId, table.definitionId],
      foreignColumns: [
        productConfigurationDefinitions.tenantId,
        productConfigurationDefinitions.productId,
        productConfigurationDefinitions.definitionId,
      ],
      name: 'catalog_configuration_measured_rules_product_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.definitionId, table.revision, table.choiceKey],
      foreignColumns: [
        productConfigurationChoices.tenantId,
        productConfigurationChoices.definitionId,
        productConfigurationChoices.revision,
        productConfigurationChoices.choiceKey,
      ],
      name: 'catalog_configuration_measured_rules_choice_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.variantId],
      name: 'catalog_configuration_measured_rules_variant_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.productId, table.variantId, table.packageDefinitionId],
      foreignColumns: [
        packageDefinitions.tenantId,
        packageDefinitions.productId,
        packageDefinitions.variantId,
        packageDefinitions.packageDefinitionId,
      ],
      name: 'catalog_configuration_measured_rules_package_fk',
    }).onDelete('restrict'),
    check(
      'catalog_configuration_measured_rules_bounds_ck',
      sql`(${table.minimum} is null) = (${table.minimumInclusive} is null) and (${table.maximum} is null) = (${table.maximumInclusive} is null) and (${table.minimum} is null or ${table.maximum} is null or ${table.minimum} <= ${table.maximum})`,
    ),
    check(
      'catalog_configuration_measured_rules_step_ck',
      sql`(${table.step} is null and ${table.stepBase} is null) or (${table.step} > 0 and ${table.stepBase} is not null)`,
    ),
    check(
      'catalog_configuration_measured_rules_target_ck',
      sql`${table.packageDefinitionId} is null or ${table.variantId} is not null`,
    ),
    ...tenantRlsPolicies('catalog_configuration_measured_rules_tenant', table.tenantId),
  ],
);

/** Bounded compatibility kinds; operands are exact choice/option or measured maximum. */
export const productConfigurationCompatibilityRules = catalogSchema.table.withRLS(
  'product_configuration_compatibility_rules',
  {
    tenantId: uuid('tenant_id').notNull(),
    definitionId: uuid('definition_id').notNull(),
    productId: uuid('product_id').notNull(),
    revision: integer('revision').notNull(),
    ruleId: uuid('rule_id').notNull(),
    variantId: uuid('variant_id'),
    packageDefinitionId: uuid('package_definition_id'),
    kind: text('kind').notNull(),
    choiceKey: text('choice_key').notNull(),
    optionKey: text('option_key').notNull(),
    otherChoiceKey: text('other_choice_key').notNull(),
    otherOptionKey: text('other_option_key'),
    maximum: numeric('maximum'),
    maximumInclusive: boolean('maximum_inclusive'),
    evidenceRefs: text('evidence_refs').array().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.definitionId, table.revision, table.ruleId],
      name: 'catalog_configuration_compatibility_rules_pk',
    }),
    foreignKey({
      columns: [table.tenantId, table.productId, table.definitionId],
      foreignColumns: [
        productConfigurationDefinitions.tenantId,
        productConfigurationDefinitions.productId,
        productConfigurationDefinitions.definitionId,
      ],
      name: 'catalog_configuration_compatibility_rules_product_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.definitionId, table.revision, table.choiceKey, table.optionKey],
      foreignColumns: [
        productConfigurationChoiceOptions.tenantId,
        productConfigurationChoiceOptions.definitionId,
        productConfigurationChoiceOptions.revision,
        productConfigurationChoiceOptions.choiceKey,
        productConfigurationChoiceOptions.optionKey,
      ],
      name: 'catalog_configuration_compatibility_rules_option_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.definitionId, table.revision, table.otherChoiceKey],
      foreignColumns: [
        productConfigurationChoices.tenantId,
        productConfigurationChoices.definitionId,
        productConfigurationChoices.revision,
        productConfigurationChoices.choiceKey,
      ],
      name: 'catalog_configuration_compatibility_rules_other_choice_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.variantId],
      name: 'catalog_configuration_compatibility_rules_variant_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.productId, table.variantId, table.packageDefinitionId],
      foreignColumns: [
        packageDefinitions.tenantId,
        packageDefinitions.productId,
        packageDefinitions.variantId,
        packageDefinitions.packageDefinitionId,
      ],
      name: 'catalog_configuration_compatibility_rules_package_fk',
    }).onDelete('restrict'),
    check(
      'catalog_configuration_compatibility_rules_kind_ck',
      sql`(${table.kind} = 'FORBIDDEN_PAIR' and ${table.otherOptionKey} is not null and ${table.maximum} is null and ${table.maximumInclusive} is null) or (${table.kind} = 'CONDITIONAL_MAXIMUM' and ${table.otherOptionKey} is null and ${table.maximum} is not null and ${table.maximumInclusive} is not null)`,
    ),
    check(
      'catalog_configuration_compatibility_rules_target_ck',
      sql`${table.packageDefinitionId} is null or ${table.variantId} is not null`,
    ),
    ...tenantRlsPolicies('catalog_configuration_compatibility_rules_tenant', table.tenantId),
  ],
);

/** Owner-recorded, immutable evidence for one exact selection across two Definition revisions. */
export const productConfigurationContinuityDecisions = catalogSchema.table.withRLS(
  'product_configuration_continuity_decisions',
  {
    tenantId: uuid('tenant_id').notNull(),
    decisionId: uuid('decision_id').defaultRandom().notNull(),
    definitionId: uuid('definition_id').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    packageDefinitionId: uuid('package_definition_id'),
    leftRevision: integer('left_revision').notNull(),
    rightRevision: integer('right_revision').notNull(),
    leftSelectionHash: text('left_selection_hash').notNull(),
    rightSelectionHash: text('right_selection_hash').notNull(),
    meaningEvidenceRefs: text('meaning_evidence_refs').array().notNull(),
    leftRuleEvidenceRefs: text('left_rule_evidence_refs').array().notNull(),
    rightRuleEvidenceRefs: text('right_rule_evidence_refs').array().notNull(),
    reason: text('reason').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.decisionId], name: 'catalog_configuration_continuity_pk' }),
    unique('catalog_configuration_continuity_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.productId, table.definitionId],
      foreignColumns: [
        productConfigurationDefinitions.tenantId,
        productConfigurationDefinitions.productId,
        productConfigurationDefinitions.definitionId,
      ],
      name: 'catalog_configuration_continuity_definition_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.definitionId, table.leftRevision],
      foreignColumns: [
        productConfigurationDefinitionRevisions.tenantId,
        productConfigurationDefinitionRevisions.definitionId,
        productConfigurationDefinitionRevisions.revision,
      ],
      name: 'catalog_configuration_continuity_left_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.definitionId, table.rightRevision],
      foreignColumns: [
        productConfigurationDefinitionRevisions.tenantId,
        productConfigurationDefinitionRevisions.definitionId,
        productConfigurationDefinitionRevisions.revision,
      ],
      name: 'catalog_configuration_continuity_right_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.variantId],
      name: 'catalog_configuration_continuity_variant_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.productId, table.variantId, table.packageDefinitionId],
      foreignColumns: [
        packageDefinitions.tenantId,
        packageDefinitions.productId,
        packageDefinitions.variantId,
        packageDefinitions.packageDefinitionId,
      ],
      name: 'catalog_configuration_continuity_package_fk',
    }).onDelete('restrict'),
    check(
      'catalog_configuration_continuity_revisions_ck',
      sql`${table.leftRevision} > 0 and ${table.rightRevision} > 0 and ${table.leftRevision} <> ${table.rightRevision}`,
    ),
    check('catalog_configuration_continuity_left_hash_ck', sql`${table.leftSelectionHash} ~ '^[0-9a-f]{64}$'`),
    check('catalog_configuration_continuity_right_hash_ck', sql`${table.rightSelectionHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'catalog_configuration_continuity_evidence_ck',
      sql`cardinality(${table.meaningEvidenceRefs}) > 0 and cardinality(${table.leftRuleEvidenceRefs}) > 0 and cardinality(${table.rightRuleEvidenceRefs}) > 0`,
    ),
    check('catalog_configuration_continuity_reason_ck', sql`length(btrim(${table.reason})) between 1 and 1000`),
    ...tenantRlsPolicies('catalog_configuration_continuity_tenant', table.tenantId),
  ],
);

const catalogDatabaseSchema = {
  catalogAcceptedSourceAssertions,
  catalogLocalOverrideHeads,
  catalogLocalOverrideRevisions,
  catalogResultSnapshots,
  commercialGtinAssignmentRevisions,
  commercialGtinAssignments,
  commercialSkuAssignmentRevisions,
  commercialSkuReservations,
  productConfigurationDefinitions,
  productConfigurationDefinitionRevisions,
  productConfigurationChoices,
  productConfigurationChoiceOptions,
  productConfigurationMeasuredRules,
  productConfigurationOptionAllowances,
  productConfigurationRevisionActivations,
  productConfigurationCompatibilityRules,
  productConfigurationContinuityDecisions,
  catalogMediaAssignmentRevisions,
  catalogMediaAssignments,
  catalogMediaAssignmentSetRevisions,
  catalogMediaAssignmentSets,
  productLocalizedFactRevisions,
  productLocalizedFacts,
  variantLocalizedFactRevisions,
  variantLocalizedFacts,
  brandRevisions,
  brands,
  manufacturerRelationRevisions,
  manufacturerRelations,
  productBrandAssignmentRevisions,
  productBrandAssignments,
  attributeDefinitionRevisions,
  attributeDefinitions,
  productAttributeApplicability,
  productAttributeApplicabilityRevisions,
  attributeValueItems,
  attributeValueRevisions,
  attributeValueSets,
  controlledAttributeValueRevisions,
  controlledAttributeValues,
  packageContentRevisions,
  packageDefinitions,
  packageOptionRoleRevisions,
  productCategories,
  productCategoryAssignments,
  productCategoryEvents,
  productCategoryHierarchyRevisions,
  productLifecycleEvents,
  productRelationshipRevisions,
  productRelationships,
  productRevisions,
  setCompositionComponents,
  setCompositionRevisions,
  setCompositions,
  productSizeUsageItems,
  productSizeUsageRevisionItems,
  productSizeUsageRevisions,
  productSizeUsageSets,
  productTypeAssignmentEvents,
  productTypeAssignments,
  productTypeUntypedDecisions,
  productTypeRevisionAttributes,
  productTypeRevisions,
  productTypes,
  productVariantAxes,
  productVariantAxisAllowanceEvents,
  productVariantAxisAllowedValues,
  productVariantAxisEvents,
  productVariantRevisions,
  productVariants,
  products,
  productUnits,
  configurationUnits,
  configurationUnitRevisions,
  sizeEquivalenceAssertions,
  productUnitRuleRevisions,
  variantUnitDivisibility,
  variantUnitDivisibilityRevisions,
  packageUnitDivisibility,
  packageUnitDivisibilityRevisions,
} as const;

export const CATALOG_TABLES = [
  catalogAcceptedSourceAssertions,
  catalogLocalOverrideHeads,
  catalogLocalOverrideRevisions,
  catalogResultSnapshots,
  commercialGtinAssignmentRevisions,
  commercialGtinAssignments,
  commercialSkuAssignmentRevisions,
  commercialSkuReservations,
  productConfigurationDefinitions,
  productConfigurationDefinitionRevisions,
  productConfigurationChoices,
  productConfigurationChoiceOptions,
  productConfigurationMeasuredRules,
  productConfigurationOptionAllowances,
  productConfigurationRevisionActivations,
  productConfigurationCompatibilityRules,
  productConfigurationContinuityDecisions,
  catalogMediaAssignmentRevisions,
  catalogMediaAssignments,
  catalogMediaAssignmentSetRevisions,
  catalogMediaAssignmentSets,
  productLocalizedFactRevisions,
  productLocalizedFacts,
  variantLocalizedFactRevisions,
  variantLocalizedFacts,
  brandRevisions,
  brands,
  manufacturerRelationRevisions,
  manufacturerRelations,
  productBrandAssignmentRevisions,
  productBrandAssignments,
  attributeDefinitionRevisions,
  attributeDefinitions,
  productAttributeApplicability,
  productAttributeApplicabilityRevisions,
  attributeValueItems,
  attributeValueRevisions,
  attributeValueSets,
  controlledAttributeValueRevisions,
  controlledAttributeValues,
  packageContentRevisions,
  packageDefinitions,
  packageOptionRoleRevisions,
  productCategories,
  productCategoryAssignments,
  productCategoryEvents,
  productCategoryHierarchyRevisions,
  productLifecycleEvents,
  productRelationshipRevisions,
  productRelationships,
  productRevisions,
  setCompositionComponents,
  setCompositionRevisions,
  setCompositions,
  productSizeUsageItems,
  productSizeUsageRevisionItems,
  productSizeUsageRevisions,
  productSizeUsageSets,
  productTypeAssignmentEvents,
  productTypeAssignments,
  productTypeUntypedDecisions,
  productTypeRevisionAttributes,
  productTypeRevisions,
  productTypes,
  productVariantAxes,
  productVariantAxisAllowanceEvents,
  productVariantAxisAllowedValues,
  productVariantAxisEvents,
  productVariantRevisions,
  productVariants,
  products,
  productUnits,
  configurationUnits,
  configurationUnitRevisions,
  sizeEquivalenceAssertions,
  productUnitRuleRevisions,
  variantUnitDivisibility,
  variantUnitDivisibilityRevisions,
  packageUnitDivisibility,
  packageUnitDivisibilityRevisions,
] as const;

export const catalogRelations = defineRelations(catalogDatabaseSchema);
