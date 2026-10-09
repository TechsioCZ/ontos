/* oxlint-disable perfectionist/sort-objects -- Drizzle declaration order is the physical database contract; expires: 2027-03-31. */
import { tenantLegalEntityRlsPolicies, tenantRlsPolicies } from '@app/core-runtime';
import type { PriceGroupSelector, PriceIdentityKey } from '@app/pricing-contracts/domain/price-definition';
import type { PriceScheduleAcknowledgement } from '@app/pricing-contracts/domain/price-schedule';
import type {
  PricingCommercialFeeCatalogTargetEvidence,
  PricingCommercialFeeIdentityKey,
  PricingCommercialFeeScheduleAcknowledgement,
} from '@app/pricing-contracts/domain/commercial-fee';
import type {
  QuantityTierQuantityBasis,
  QuantityTierScheduleAcknowledgement,
} from '@app/pricing-contracts/domain/quantity-tier';
import type {
  PricingDiscountIdentityKey,
  PricingDiscountScheduleAcknowledgement,
  PricingDiscountScheduleSnapshot,
} from '@app/pricing-contracts/domain/discount';
import type { ZeroFloorAuthorizationScheduleSnapshot } from '../../shared/actions/manage-zero-floor-authorization.ts';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgPolicy,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

export const PRICING_SCHEMA_NAME = 'pricing';
export const PRICING_TABLE_INVENTORY = [
  'contractual_discount_action_invocation_receipts',
  'contractual_discount_revisions',
  'contractual_discount_schedule_acknowledgements',
  'contractual_discount_schedule_heads',
  'contractual_discounts',
  'contractual_discount_set_heads',
  'contractual_discount_set_revisions',
  'contractual_discount_set_roots',
  'currency_support_action_result_receipts',
  'currency_support_recovery_compensation_receipts',
  'currency_support_proof_receipts',
  'currency_support_revisions',
  'currency_support_roots',
  'currency_support_schedule_entries',
  'currency_support_schedule_heads',
  'currency_support_schedule_revisions',
  'currency_support_value_revisions',
  'external_price_source_authority_grants',
  'fee_action_invocation_receipts',
  'fee_set_heads',
  'fee_set_revisions',
  'fee_set_roots',
  'fee_revisions',
  'fee_schedule_acknowledgements',
  'fee_schedule_entries',
  'fee_schedule_heads',
  'fee_schedule_revisions',
  'fees',
  'gateway_assertion_redemptions',
  'material_evidence_proof_receipts',
  'price_current_revisions',
  'price_fee_action_invocation_claims',
  'price_fee_action_result_receipts',
  'price_candidate_set_heads',
  'price_candidate_set_revisions',
  'price_candidate_set_roots',
  'price_invocation_receipts',
  'price_revisions',
  'price_schedule_acknowledgements',
  'price_schedule_entries',
  'price_schedule_heads',
  'price_schedule_revisions',
  'price_source_assertion_deliveries',
  'price_source_assertions',
  'prices',
  'pricing_commitment_confirmations',
  'pricing_quotations',
  'quantity_tier_action_result_receipts',
  'quantity_tier_revisions',
  'quantity_tier_set_heads',
  'quantity_tier_set_revisions',
  'quantity_tier_set_roots',
  'quantity_tier_schedule_acknowledgements',
  'quantity_tier_schedule_entries',
  'quantity_tier_schedule_heads',
  'quantity_tier_schedule_revisions',
  'quantity_tiers',
  'zero_floor_action_invocation_receipts',
  'zero_floor_authorization_revisions',
  'zero_floor_authorization_schedule_heads',
  'zero_floor_authorizations',
  'zero_floor_governance_approvals',
  'zero_floor_schedule_acknowledgements',
  'zero_floor_set_heads',
  'zero_floor_set_revisions',
  'zero_floor_set_roots',
] as const;
export const pricingSchema = pgSchema(PRICING_SCHEMA_NAME);

/** Global single-use assertion identities. This infrastructure table is deliberately not Tenant/SLE scoped. */
export const gatewayAssertionRedemptions = pricingSchema.table(
  'gateway_assertion_redemptions',
  {
    audience: text('audience').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    issuer: text('issuer').notNull(),
    jti: uuid('jti').notNull(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_gateway_assertion_redemptions_identity_uk').on(table.issuer, table.audience, table.jti),
    index('pricing_gateway_assertion_redemptions_expiry_idx').on(table.expiresAt),
  ],
);

const appendOnlyTenantLegalEntityRlsPolicies = (
  prefix: string,
  tenantColumn: AnyPgColumn,
  legalEntityColumn: AnyPgColumn,
  role: 'ontos_runtime' | 'public' = 'ontos_runtime',
) => {
  const predicate = sql`${tenantColumn} = nullif(current_setting('ontos.tenant_id', true), '')::uuid and ${legalEntityColumn} = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid`;
  return [
    pgPolicy(`${prefix}_select`, { for: 'select', to: role, using: predicate }),
    pgPolicy(`${prefix}_insert`, { for: 'insert', to: role, withCheck: predicate }),
    pgPolicy(`${prefix}_update`, {
      for: 'update',
      to: role,
      using: sql`false`,
      withCheck: sql`false`,
    }),
    pgPolicy(`${prefix}_delete`, { for: 'delete', to: role, using: sql`false` }),
  ] as const;
};

/**
 * Immutable owner proof instances issued outside the Order Decision Bundle.
 * The normalized columns provide exact recovery keys while `confirmation`
 * preserves the complete signed source, terms, binding, and authenticity
 * evidence without reconstructing it from mutable Current state.
 */
export const pricingCommitmentConfirmations = pricingSchema.table.withRLS(
  'pricing_commitment_confirmations',
  {
    confirmationId: uuid('confirmation_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    confirmationRef: text('confirmation_ref').notNull(),
    attemptRef: text('attempt_ref').notNull(),
    decisionBundleRef: text('decision_bundle_ref').notNull(),
    decisionBundleHash: text('decision_bundle_hash').notNull(),
    decisionBundleVersion: text('decision_bundle_version').notNull(),
    sourceKind: text('source_kind').notNull(),
    quotationRef: text('quotation_ref'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    confirmation: jsonb('confirmation').notNull(),
    payloadDigest: text('payload_digest').notNull(),
    proofRef: text('proof_ref').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_commitment_confirmations_scope_ref_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.confirmationRef,
    ),
    unique('pricing_commitment_confirmations_scope_proof_uk').on(table.tenantId, table.legalEntityId, table.proofRef),
    index('pricing_commitment_confirmations_attempt_bundle_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.attemptRef,
      table.decisionBundleHash,
      table.issuedAt,
    ),
    index('pricing_commitment_confirmations_expiry_idx').on(table.expiresAt),
    check(
      'pricing_commitment_confirmations_source_kind_ck',
      sql`${table.sourceKind} in ('CURRENT_BACKED', 'QUOTATION_BACKED')`,
    ),
    check(
      'pricing_commitment_confirmations_source_reference_ck',
      sql`(${table.sourceKind} = 'CURRENT_BACKED' and ${table.quotationRef} is null) or (${table.sourceKind} = 'QUOTATION_BACKED' and ${table.quotationRef} is not null)`,
    ),
    check(
      'pricing_commitment_confirmations_interval_ck',
      sql`${table.expiresAt} > ${table.issuedAt} and ${table.expiresAt} <= ${table.issuedAt} + interval '30 seconds'`,
    ),
    check('pricing_commitment_confirmations_payload_ck', sql`jsonb_typeof(${table.confirmation}) = 'object'`),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_commitment_confirmations_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

/** Immutable owner-issued evidence that resolves an opaque material proof reference exactly. */
export const materialEvidenceProofReceipts = pricingSchema.table.withRLS(
  'material_evidence_proof_receipts',
  {
    materialEvidenceProofReceiptId: uuid('material_evidence_proof_receipt_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    family: text('family').notNull(),
    verificationRef: text('verification_ref').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    ownerRootRef: text('owner_root_ref').notNull(),
    ownerSetRevisionRef: text('owner_set_revision_ref').notNull(),
    predicateRef: text('predicate_ref').notNull(),
    generation: integer('generation').notNull(),
    currentFacts: jsonb('current_facts').notNull(),
    query: jsonb('query').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    unique('pricing_material_proof_receipt_identity_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.family,
      table.verificationRef,
      table.observedAt,
      table.effectiveAt,
    ),
    check(
      'pricing_material_proof_receipt_family_ck',
      sql`${table.family} in ('PRICE', 'COMMERCIAL_FEE', 'ZERO_FLOOR', 'QUANTITY_TIER', 'DISCOUNT', 'CURRENCY_SUPPORT')`,
    ),
    check('pricing_material_proof_receipt_generation_ck', sql`${table.generation} >= 0`),
    check(
      'pricing_material_proof_receipt_temporal_ck',
      sql`${table.effectiveAt} <= ${table.observedAt} and ${table.observedAt} <= ${table.recordedAt}`,
    ),
    check('pricing_material_proof_receipt_facts_ck', sql`jsonb_typeof(${table.currentFacts}) = 'array'`),
    check('pricing_material_proof_receipt_query_ck', sql`jsonb_typeof(${table.query}) = 'object'`),
    check(
      'pricing_material_proof_receipt_refs_ck',
      sql`length(${table.verificationRef}) > 0 and length(${table.ownerRootRef}) > 0 and length(${table.ownerSetRevisionRef}) > 0 and length(${table.predicateRef}) > 0`,
    ),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_material_proof_receipts_scope',
      table.tenantId,
      table.legalEntityId,
      'public',
    ),
  ],
);

/** Immutable exact quotation facts and owner result lookup evidence. */
export const pricingQuotations = pricingSchema.table.withRLS(
  'pricing_quotations',
  {
    quotationId: uuid('quotation_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    quotationRef: text('quotation_ref').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    commandFingerprint: text('command_fingerprint').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
    quotation: jsonb('quotation').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_quotations_scope_ref_uk').on(table.tenantId, table.legalEntityId, table.quotationRef),
    unique('pricing_quotations_invocation_uk').on(table.tenantId, table.actionInvocationId),
    check(
      'pricing_quotations_ref_ck',
      sql`length(${table.quotationRef}) between 1 and 300 and ${table.quotationRef} = btrim(${table.quotationRef})`,
    ),
    check('pricing_quotations_fingerprint_ck', sql`${table.commandFingerprint} ~ '^[0-9a-f]{64}$'`),
    check('pricing_quotations_payload_ck', sql`jsonb_typeof(${table.quotation}) = 'object'`),
    check(
      'pricing_quotations_interval_ck',
      sql`${table.validUntil} > ${table.validFrom} and ${table.issuedAt} = ${table.validFrom}`,
    ),
    ...appendOnlyTenantLegalEntityRlsPolicies('pricing_quotations_scope', table.tenantId, table.legalEntityId),
  ],
);

const readOnlyTenantLegalEntityRlsPolicies = (
  prefix: string,
  tenantColumn: AnyPgColumn,
  legalEntityColumn: AnyPgColumn,
) => {
  const predicate = sql`${tenantColumn} = nullif(current_setting('ontos.tenant_id', true), '')::uuid and ${legalEntityColumn} = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid`;
  return [
    pgPolicy(`${prefix}_select`, { for: 'select', to: 'ontos_runtime', using: predicate }),
    pgPolicy(`${prefix}_insert`, { for: 'insert', to: 'ontos_runtime', withCheck: sql`false` }),
    pgPolicy(`${prefix}_update`, {
      for: 'update',
      to: 'ontos_runtime',
      using: sql`false`,
      withCheck: sql`false`,
    }),
    pgPolicy(`${prefix}_delete`, { for: 'delete', to: 'ontos_runtime', using: sql`false` }),
  ] as const;
};

const appendOnlyTenantRlsPolicies = (
  prefix: string,
  tenantColumn: AnyPgColumn,
  role: 'ontos_runtime' | 'public' = 'ontos_runtime',
) => {
  const predicate = sql`${tenantColumn} = nullif(current_setting('ontos.tenant_id', true), '')::uuid`;
  return [
    pgPolicy(`${prefix}_select`, { for: 'select', to: role, using: predicate }),
    pgPolicy(`${prefix}_insert`, { for: 'insert', to: role, withCheck: predicate }),
    pgPolicy(`${prefix}_update`, {
      for: 'update',
      to: role,
      using: sql`false`,
      withCheck: sql`false`,
    }),
    pgPolicy(`${prefix}_delete`, { for: 'delete', to: role, using: sql`false` }),
  ] as const;
};

export const currencySupportRevisions = pricingSchema.table.withRLS(
  'currency_support_revisions',
  {
    currencySupportRevisionId: uuid('currency_support_revision_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    contextRevision: text('context_revision').notNull(),
    storefrontId: text('storefront_id').notNull(),
    marketId: text('market_id').notNull(),
    channelId: text('channel_id').notNull(),
    cartId: text('cart_id').notNull(),
    subjectFingerprint: text('subject_fingerprint').notNull(),
    generation: integer('generation').notNull(),
    pricingRevision: text('pricing_revision').notNull(),
    supportedCurrencies: jsonb('supported_currencies').$type<readonly string[]>().notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actorPrincipalId: uuid('actor_principal_id').notNull(),
    reason: text('reason').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_currency_support_scope_generation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.contextRevision,
      table.storefrontId,
      table.marketId,
      table.channelId,
      table.cartId,
      table.subjectFingerprint,
      table.generation,
    ),
    unique('pricing_currency_support_action_uk').on(table.tenantId, table.actionInvocationId),
    index('pricing_currency_support_current_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.contextRevision,
      table.storefrontId,
      table.marketId,
      table.channelId,
      table.cartId,
      table.subjectFingerprint,
      table.effectiveFrom,
    ),
    check('pricing_currency_support_generation_ck', sql`${table.generation} > 0`),
    check(
      'pricing_currency_support_revision_ck',
      sql`${table.pricingRevision} ~ '^pricing-currency-support:[1-9][0-9]*$'`,
    ),
    check(
      'pricing_currency_support_period_ck',
      sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    check(
      'pricing_currency_support_currencies_ck',
      sql`jsonb_typeof(${table.supportedCurrencies}) = 'array' and jsonb_array_length(${table.supportedCurrencies}) > 0`,
    ),
    check(
      'pricing_currency_support_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...readOnlyTenantLegalEntityRlsPolicies(
      'pricing_currency_support_legacy_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

// Qualified, read-only legacy history. The canonical Tenant authority begins with
// currencySupportRoots and never infers a baseline from these per-context rows.
/** Tenant-scoped exact Currency Support Action result for original-invocation recovery. */
export const currencySupportActionResultReceipts = pricingSchema.table.withRLS(
  'currency_support_action_result_receipts',
  {
    currencySupportActionResultReceiptId: uuid('currency_support_action_result_receipt_id')
      .defaultRandom()
      .primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    intent: text('intent').notNull(),
    requestPayload: jsonb('request_payload').notNull(),
    resultPayload: jsonb('result_payload').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_currency_support_results_invocation_uk').on(table.tenantId, table.actionInvocationId),
    check(
      'pricing_currency_support_results_intent_ck',
      sql`${table.intent} in ('ESTABLISH_CURRENT', 'VALUE_ONLY_CURRENT', 'SCHEDULE_REVISION')`,
    ),
    check(
      'pricing_currency_support_results_payload_ck',
      sql`jsonb_typeof(${table.requestPayload}) = 'object' and jsonb_typeof(${table.resultPayload}) = 'object'`,
    ),
    check(
      'pricing_currency_support_results_outcome_ck',
      sql`${table.resultPayload}->>'outcome' in ('APPLIED', 'UNCHANGED')`,
    ),
    ...appendOnlyTenantRlsPolicies('pricing_currency_support_results_tenant', table.tenantId),
  ],
);

export const currencySupportRoots = pricingSchema.table.withRLS(
  'currency_support_roots',
  {
    currencySupportId: uuid('currency_support_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    createdByActionInvocationId: uuid('created_by_action_invocation_id').notNull(),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_currency_support_roots_tenant_uk').on(table.tenantId),
    unique('pricing_currency_support_roots_scope_id_uk').on(table.tenantId, table.currencySupportId),
    unique('pricing_currency_support_roots_invocation_uk').on(table.tenantId, table.createdByActionInvocationId),
    ...appendOnlyTenantRlsPolicies('pricing_currency_support_roots_tenant', table.tenantId),
  ],
);

export const currencySupportValueRevisions = pricingSchema.table.withRLS(
  'currency_support_value_revisions',
  {
    currencySupportRevisionId: uuid('currency_support_revision_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    currencySupportId: uuid('currency_support_id').notNull(),
    generation: integer('generation').notNull(),
    pricingRevision: text('pricing_revision').notNull(),
    supportedCurrencies: jsonb('supported_currencies').$type<readonly string[]>().notNull(),
    previousRevisionId: uuid('previous_revision_id'),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    reason: text('reason').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_currency_support_value_scope_id_uk').on(
      table.tenantId,
      table.currencySupportId,
      table.currencySupportRevisionId,
    ),
    unique('pricing_currency_support_value_generation_uk').on(
      table.tenantId,
      table.currencySupportId,
      table.generation,
    ),
    unique('pricing_currency_support_value_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.currencySupportId],
      foreignColumns: [currencySupportRoots.tenantId, currencySupportRoots.currencySupportId],
      name: 'pricing_currency_support_value_root_fk',
    }).onDelete('restrict'),
    check('pricing_currency_support_value_generation_ck', sql`${table.generation} > 0`),
    check(
      'pricing_currency_support_value_revision_ck',
      sql`${table.pricingRevision} ~ '^pricing-currency-support:[1-9][0-9]*$'`,
    ),
    check(
      'pricing_currency_support_value_currencies_ck',
      sql`jsonb_typeof(${table.supportedCurrencies}) = 'array' and jsonb_array_length(${table.supportedCurrencies}) > 0`,
    ),
    check(
      'pricing_currency_support_value_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...appendOnlyTenantRlsPolicies('pricing_currency_support_value_tenant', table.tenantId),
  ],
);

export const currencySupportScheduleRevisions = pricingSchema.table.withRLS(
  'currency_support_schedule_revisions',
  {
    currencySupportScheduleRevisionId: uuid('currency_support_schedule_revision_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    currencySupportId: uuid('currency_support_id').notNull(),
    scheduleRevision: integer('schedule_revision').notNull(),
    previousScheduleRevisionId: uuid('previous_schedule_revision_id'),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    scheduleAcknowledgement: jsonb('schedule_acknowledgement'),
    reason: text('reason').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_currency_support_schedule_scope_id_uk').on(
      table.tenantId,
      table.currencySupportId,
      table.currencySupportScheduleRevisionId,
    ),
    unique('pricing_currency_support_schedule_number_uk').on(
      table.tenantId,
      table.currencySupportId,
      table.scheduleRevision,
    ),
    unique('pricing_currency_support_schedule_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.currencySupportId],
      foreignColumns: [currencySupportRoots.tenantId, currencySupportRoots.currencySupportId],
      name: 'pricing_currency_support_schedule_root_fk',
    }).onDelete('restrict'),
    check('pricing_currency_support_schedule_number_ck', sql`${table.scheduleRevision} > 0`),
    check(
      'pricing_currency_support_schedule_acknowledgement_ck',
      sql`${table.scheduleAcknowledgement} is null or jsonb_typeof(${table.scheduleAcknowledgement}) = 'object'`,
    ),
    check(
      'pricing_currency_support_schedule_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...appendOnlyTenantRlsPolicies('pricing_currency_support_schedule_tenant', table.tenantId),
  ],
);

export const currencySupportScheduleEntries = pricingSchema.table.withRLS(
  'currency_support_schedule_entries',
  {
    currencySupportScheduleEntryId: uuid('currency_support_schedule_entry_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    currencySupportId: uuid('currency_support_id').notNull(),
    currencySupportRevisionId: uuid('currency_support_revision_id').notNull(),
    currencySupportScheduleRevisionId: uuid('currency_support_schedule_revision_id').notNull(),
    scheduleRevision: integer('schedule_revision').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
  },
  (table) => [
    unique('pricing_currency_support_entries_revision_uk').on(
      table.tenantId,
      table.currencySupportId,
      table.currencySupportScheduleRevisionId,
      table.currencySupportRevisionId,
    ),
    foreignKey({
      columns: [table.tenantId, table.currencySupportId, table.currencySupportRevisionId],
      foreignColumns: [
        currencySupportValueRevisions.tenantId,
        currencySupportValueRevisions.currencySupportId,
        currencySupportValueRevisions.currencySupportRevisionId,
      ],
      name: 'pricing_currency_support_entries_value_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.currencySupportId, table.currencySupportScheduleRevisionId],
      foreignColumns: [
        currencySupportScheduleRevisions.tenantId,
        currencySupportScheduleRevisions.currencySupportId,
        currencySupportScheduleRevisions.currencySupportScheduleRevisionId,
      ],
      name: 'pricing_currency_support_entries_schedule_fk',
    }).onDelete('restrict'),
    check(
      'pricing_currency_support_entries_period_ck',
      sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    index('pricing_currency_support_entries_at_idx').on(
      table.tenantId,
      table.currencySupportId,
      table.scheduleRevision,
      table.effectiveFrom,
      table.effectiveTo,
    ),
    ...appendOnlyTenantRlsPolicies('pricing_currency_support_entries_tenant', table.tenantId),
  ],
);

/** Immutable receipts for exact Tenant currency-support observations. */
export const currencySupportProofReceipts = pricingSchema.table.withRLS(
  'currency_support_proof_receipts',
  {
    currencySupportProofReceiptId: uuid('currency_support_proof_receipt_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    verificationRef: text('verification_ref').notNull(),
    predicateRef: text('predicate_ref').notNull(),
    currencySupportId: uuid('currency_support_id').notNull(),
    currencySupportRevisionId: uuid('currency_support_revision_id').notNull(),
    currencySupportScheduleRevisionId: uuid('currency_support_schedule_revision_id').notNull(),
    generation: integer('generation').notNull(),
    scheduleRevision: integer('schedule_revision').notNull(),
    pricingRevision: text('pricing_revision').notNull(),
    supportedCurrencies: jsonb('supported_currencies').$type<readonly string[]>().notNull(),
    factProofs: jsonb('fact_proofs')
      .$type<
        readonly {
          readonly factRef: string;
          readonly factRevisionRef: string;
          readonly verificationRef: string;
        }[]
      >()
      .notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    nextApplicabilityBoundary: timestamp('next_applicability_boundary', { withTimezone: true }),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('pricing_currency_support_proof_ref_uk').on(table.tenantId, table.verificationRef),
    foreignKey({
      columns: [table.tenantId, table.currencySupportId, table.currencySupportRevisionId],
      foreignColumns: [
        currencySupportValueRevisions.tenantId,
        currencySupportValueRevisions.currencySupportId,
        currencySupportValueRevisions.currencySupportRevisionId,
      ],
      name: 'pricing_currency_support_proof_value_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.currencySupportId, table.currencySupportScheduleRevisionId],
      foreignColumns: [
        currencySupportScheduleRevisions.tenantId,
        currencySupportScheduleRevisions.currencySupportId,
        currencySupportScheduleRevisions.currencySupportScheduleRevisionId,
      ],
      name: 'pricing_currency_support_proof_schedule_fk',
    }).onDelete('restrict'),
    check('pricing_currency_support_proof_generation_ck', sql`${table.generation} > 0`),
    check('pricing_currency_support_proof_schedule_ck', sql`${table.scheduleRevision} > 0`),
    check(
      'pricing_currency_support_proof_ref_ck',
      sql`${table.verificationRef} = btrim(${table.verificationRef}) and length(${table.verificationRef}) between 1 and 300`,
    ),
    check(
      'pricing_currency_support_proof_predicate_ck',
      sql`${table.predicateRef} = btrim(${table.predicateRef}) and length(${table.predicateRef}) between 1 and 1000`,
    ),
    check(
      'pricing_currency_support_proof_currencies_ck',
      sql`jsonb_typeof(${table.supportedCurrencies}) = 'array' and jsonb_array_length(${table.supportedCurrencies}) > 0`,
    ),
    check(
      'pricing_currency_support_proof_facts_ck',
      sql`jsonb_typeof(${table.factProofs}) = 'array' and jsonb_array_length(${table.factProofs}) = 1`,
    ),
    check(
      'pricing_currency_support_proof_period_ck',
      sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    check(
      'pricing_currency_support_proof_effective_ck',
      sql`${table.effectiveFrom} <= ${table.effectiveAt} and (${table.effectiveTo} is null or ${table.effectiveAt} < ${table.effectiveTo}) and ${table.effectiveAt} <= ${table.observedAt}`,
    ),
    check(
      'pricing_currency_support_proof_boundary_ck',
      sql`${table.nextApplicabilityBoundary} is null or ${table.nextApplicabilityBoundary} > ${table.observedAt}`,
    ),
    ...appendOnlyTenantRlsPolicies('pricing_currency_support_proof_tenant', table.tenantId, 'public'),
  ],
);

export const currencySupportScheduleHeads = pricingSchema.table.withRLS(
  'currency_support_schedule_heads',
  {
    currencySupportScheduleHeadId: uuid('currency_support_schedule_head_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    currencySupportId: uuid('currency_support_id').notNull(),
    currencySupportScheduleRevisionId: uuid('currency_support_schedule_revision_id').notNull(),
    scheduleRevision: integer('schedule_revision').notNull(),
  },
  (table) => [
    unique('pricing_currency_support_heads_tenant_uk').on(table.tenantId),
    unique('pricing_currency_support_heads_root_uk').on(table.tenantId, table.currencySupportId),
    foreignKey({
      columns: [table.tenantId, table.currencySupportId, table.currencySupportScheduleRevisionId],
      foreignColumns: [
        currencySupportScheduleRevisions.tenantId,
        currencySupportScheduleRevisions.currencySupportId,
        currencySupportScheduleRevisions.currencySupportScheduleRevisionId,
      ],
      name: 'pricing_currency_support_heads_revision_fk',
    }).onDelete('restrict'),
    check('pricing_currency_support_heads_revision_ck', sql`${table.scheduleRevision} > 0`),
    ...tenantRlsPolicies('pricing_currency_support_heads_tenant', table.tenantId),
  ],
);

/**
 * Immutable evidence that one governed compensation ended the exact schedule created by a
 * committed Currency Support recovery. The canonical root and every original revision remain
 * intact; compensation advances the schedule instead of reviving the legacy authority.
 */
export const currencySupportRecoveryCompensationReceipts = pricingSchema.table.withRLS(
  'currency_support_recovery_compensation_receipts',
  {
    currencySupportRecoveryCompensationReceiptId: uuid('currency_support_recovery_compensation_receipt_id')
      .defaultRandom()
      .primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    compensationActionInvocationId: uuid('compensation_action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    committedActionInvocationId: uuid('committed_action_invocation_id').notNull(),
    currencySupportId: uuid('currency_support_id').notNull(),
    committedCurrencySupportRevisionId: uuid('committed_currency_support_revision_id').notNull(),
    previousScheduleRevisionId: uuid('previous_schedule_revision_id').notNull(),
    compensationScheduleRevisionId: uuid('compensation_schedule_revision_id').notNull(),
    absentFrom: timestamp('absent_from', { withTimezone: true }).notNull(),
    requestPayload: jsonb('request_payload').notNull(),
    resultPayload: jsonb('result_payload').notNull(),
    reason: text('reason').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_currency_support_recovery_compensation_invocation_uk').on(
      table.tenantId,
      table.compensationActionInvocationId,
    ),
    unique('pricing_currency_support_recovery_compensation_commit_uk').on(
      table.tenantId,
      table.committedActionInvocationId,
    ),
    foreignKey({
      columns: [table.tenantId, table.committedActionInvocationId],
      foreignColumns: [
        currencySupportActionResultReceipts.tenantId,
        currencySupportActionResultReceipts.actionInvocationId,
      ],
      name: 'pricing_currency_support_recovery_compensation_commit_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.currencySupportId],
      foreignColumns: [currencySupportRoots.tenantId, currencySupportRoots.currencySupportId],
      name: 'pricing_currency_support_recovery_compensation_root_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.currencySupportId, table.committedCurrencySupportRevisionId],
      foreignColumns: [
        currencySupportValueRevisions.tenantId,
        currencySupportValueRevisions.currencySupportId,
        currencySupportValueRevisions.currencySupportRevisionId,
      ],
      name: 'pricing_currency_support_recovery_compensation_value_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.currencySupportId, table.previousScheduleRevisionId],
      foreignColumns: [
        currencySupportScheduleRevisions.tenantId,
        currencySupportScheduleRevisions.currencySupportId,
        currencySupportScheduleRevisions.currencySupportScheduleRevisionId,
      ],
      name: 'pricing_currency_support_recovery_compensation_previous_schedule_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.currencySupportId, table.compensationScheduleRevisionId],
      foreignColumns: [
        currencySupportScheduleRevisions.tenantId,
        currencySupportScheduleRevisions.currencySupportId,
        currencySupportScheduleRevisions.currencySupportScheduleRevisionId,
      ],
      name: 'pricing_currency_support_recovery_compensation_schedule_fk',
    }).onDelete('restrict'),
    check(
      'pricing_currency_support_recovery_compensation_invocation_ck',
      sql`${table.compensationActionInvocationId} <> ${table.committedActionInvocationId}`,
    ),
    check(
      'pricing_currency_support_recovery_compensation_payload_ck',
      sql`jsonb_typeof(${table.requestPayload}) = 'object' and jsonb_typeof(${table.resultPayload}) = 'object'`,
    ),
    check(
      'pricing_currency_support_recovery_compensation_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...appendOnlyTenantRlsPolicies('pricing_currency_support_recovery_compensation_tenant', table.tenantId),
  ],
);

export const prices = pricingSchema.table.withRLS(
  'prices',
  {
    priceId: uuid('price_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    catalogSelection: jsonb('catalog_selection').$type<PriceIdentityKey['catalogSelection']>().notNull(),
    channelId: text('channel_id').notNull(),
    marketId: text('market_id').notNull(),
    currencyCode: text('currency_code').notNull(),
    unitRef: jsonb('unit_ref').$type<PriceIdentityKey['unitBasis']['unitRef']>().notNull(),
    basisQuantity: numeric('basis_quantity', { precision: 38, scale: 9 }).notNull(),
    priceGroupSelector: jsonb('price_group_selector').$type<PriceGroupSelector>().notNull(),
    createdByActionInvocationId: uuid('created_by_action_invocation_id').notNull(),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_prices_scope_id_uk').on(table.tenantId, table.legalEntityId, table.priceId),
    unique('pricing_prices_tier_basis_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.priceId,
      table.currencyCode,
      table.basisQuantity,
      table.unitRef,
    ),
    unique('pricing_prices_invocation_uk').on(table.tenantId, table.createdByActionInvocationId),
    unique('pricing_prices_exact_identity_uk').on(
      table.tenantId,
      table.catalogSelection,
      table.legalEntityId,
      table.channelId,
      table.marketId,
      table.currencyCode,
      table.unitRef,
      table.basisQuantity,
      table.priceGroupSelector,
    ),
    check(
      'pricing_prices_catalog_selection_ck',
      sql`jsonb_typeof(${table.catalogSelection}) = 'object' and jsonb_typeof(${table.catalogSelection}->'productRef') = 'object' and jsonb_typeof(${table.catalogSelection}->'variantRef') = 'object'`,
    ),
    check(
      'pricing_prices_commercial_scope_ck',
      sql`${table.channelId} = btrim(${table.channelId}) and length(${table.channelId}) between 1 and 300 and ${table.channelId} <> '*' and ${table.marketId} = btrim(${table.marketId}) and length(${table.marketId}) between 1 and 300 and ${table.marketId} <> '*'`,
    ),
    check('pricing_prices_currency_ck', sql`${table.currencyCode} ~ '^[A-Z]{3}$'`),
    check(
      'pricing_prices_unit_basis_ck',
      sql`${table.basisQuantity} > 0 and jsonb_typeof(${table.unitRef}) = 'object' and ${table.unitRef}->>'resourceType' = 'commerce.catalog.product-unit'`,
    ),
    check(
      'pricing_prices_group_selector_ck',
      sql`jsonb_typeof(${table.priceGroupSelector}) = 'object' and ((${table.priceGroupSelector}->>'kind' = 'NO_GROUP' and not (${table.priceGroupSelector} ? 'priceGroupRef')) or (${table.priceGroupSelector}->>'kind' = 'PRICE_GROUP' and jsonb_typeof(${table.priceGroupSelector}->'priceGroupRef') = 'object'))`,
    ),
    ...appendOnlyTenantLegalEntityRlsPolicies('pricing_prices_scope', table.tenantId, table.legalEntityId),
  ],
);

/** Stable owner-private authority for one exact Price candidate-set predicate. */
export const priceCandidateSetRoots = pricingSchema.table.withRLS(
  'price_candidate_set_roots',
  {
    priceCandidateSetRootId: uuid('price_candidate_set_root_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    catalogSelection: jsonb('catalog_selection').$type<PriceIdentityKey['catalogSelection']>().notNull(),
    channelId: text('channel_id').notNull(),
    marketId: text('market_id').notNull(),
    currencyCode: text('currency_code').notNull(),
    unitRef: jsonb('unit_ref').$type<PriceIdentityKey['unitBasis']['unitRef']>().notNull(),
    basisQuantity: numeric('basis_quantity', { precision: 38, scale: 9 }).notNull(),
    priceGroupSelector: jsonb('price_group_selector').$type<PriceGroupSelector>().notNull(),
    createdByActionInvocationId: uuid('created_by_action_invocation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_price_candidate_set_roots_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.priceCandidateSetRootId,
    ),
    unique('pricing_price_candidate_set_roots_predicate_uk').on(
      table.tenantId,
      table.catalogSelection,
      table.legalEntityId,
      table.channelId,
      table.marketId,
      table.currencyCode,
      table.unitRef,
      table.basisQuantity,
      table.priceGroupSelector,
    ),
    check(
      'pricing_price_candidate_set_roots_catalog_ck',
      sql`jsonb_typeof(${table.catalogSelection}) = 'object' and ${table.catalogSelection} #>> '{productRef,tenantId}' = ${table.tenantId}::text and ${table.catalogSelection} #>> '{variantRef,tenantId}' = ${table.tenantId}::text`,
    ),
    check(
      'pricing_price_candidate_set_roots_scope_ck',
      sql`${table.channelId} = btrim(${table.channelId}) and length(${table.channelId}) between 1 and 300 and ${table.channelId} <> '*' and ${table.marketId} = btrim(${table.marketId}) and length(${table.marketId}) between 1 and 300 and ${table.marketId} <> '*'`,
    ),
    check('pricing_price_candidate_set_roots_currency_ck', sql`${table.currencyCode} ~ '^[A-Z]{3}$'`),
    check(
      'pricing_price_candidate_set_roots_basis_ck',
      sql`${table.basisQuantity} > 0 and jsonb_typeof(${table.unitRef}) = 'object' and ${table.unitRef}->>'resourceType' = 'commerce.catalog.product-unit'`,
    ),
    check(
      'pricing_price_candidate_set_roots_group_ck',
      sql`jsonb_typeof(${table.priceGroupSelector}) = 'object' and ((${table.priceGroupSelector}->>'kind' = 'NO_GROUP' and not (${table.priceGroupSelector} ? 'priceGroupRef')) or (${table.priceGroupSelector}->>'kind' = 'PRICE_GROUP' and jsonb_typeof(${table.priceGroupSelector}->'priceGroupRef') = 'object'))`,
    ),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_price_candidate_set_roots_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

/** Immutable monotonic revisions of one complete exact Price candidate set. */
export const priceCandidateSetRevisions = pricingSchema.table.withRLS(
  'price_candidate_set_revisions',
  {
    priceCandidateSetRevisionId: uuid('price_candidate_set_revision_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    priceCandidateSetRootId: uuid('price_candidate_set_root_id').notNull(),
    generation: integer('generation').notNull(),
    previousPriceCandidateSetRevisionId: uuid('previous_price_candidate_set_revision_id'),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    mutationKind: text('mutation_kind').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_price_candidate_set_revisions_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.priceCandidateSetRootId,
      table.priceCandidateSetRevisionId,
    ),
    unique('pricing_price_candidate_set_revisions_generation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.priceCandidateSetRootId,
      table.generation,
    ),
    unique('pricing_price_candidate_set_revisions_invocation_uk').on(
      table.tenantId,
      table.priceCandidateSetRootId,
      table.actionInvocationId,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.priceCandidateSetRootId],
      foreignColumns: [
        priceCandidateSetRoots.tenantId,
        priceCandidateSetRoots.legalEntityId,
        priceCandidateSetRoots.priceCandidateSetRootId,
      ],
      name: 'pricing_price_candidate_set_revisions_root_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.tenantId,
        table.legalEntityId,
        table.priceCandidateSetRootId,
        table.previousPriceCandidateSetRevisionId,
      ],
      foreignColumns: [
        table.tenantId,
        table.legalEntityId,
        table.priceCandidateSetRootId,
        table.priceCandidateSetRevisionId,
      ],
      name: 'pricing_price_candidate_set_revisions_previous_fk',
    }).onDelete('restrict'),
    check('pricing_price_candidate_set_revisions_generation_ck', sql`${table.generation} > 0`),
    check(
      'pricing_price_candidate_set_revisions_lineage_ck',
      sql`(${table.generation} = 1 and ${table.previousPriceCandidateSetRevisionId} is null and ${table.mutationKind} = 'PRICE_DEFINED') or (${table.generation} > 1 and ${table.previousPriceCandidateSetRevisionId} is not null and ${table.mutationKind} in ('PRICE_SCHEDULE_CHANGED', 'PRICE_SOURCE_CHANGED'))`,
    ),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_price_candidate_set_revisions_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

/** Mutable pointer to the latest immutable exact Price candidate-set revision. */
export const priceCandidateSetHeads = pricingSchema.table.withRLS(
  'price_candidate_set_heads',
  {
    priceCandidateSetHeadId: uuid('price_candidate_set_head_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    priceCandidateSetRootId: uuid('price_candidate_set_root_id').notNull(),
    priceCandidateSetRevisionId: uuid('price_candidate_set_revision_id').notNull(),
    generation: integer('generation').notNull(),
  },
  (table) => [
    unique('pricing_price_candidate_set_heads_root_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.priceCandidateSetRootId,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.priceCandidateSetRootId, table.priceCandidateSetRevisionId],
      foreignColumns: [
        priceCandidateSetRevisions.tenantId,
        priceCandidateSetRevisions.legalEntityId,
        priceCandidateSetRevisions.priceCandidateSetRootId,
        priceCandidateSetRevisions.priceCandidateSetRevisionId,
      ],
      name: 'pricing_price_candidate_set_heads_revision_fk',
    }).onDelete('restrict'),
    check('pricing_price_candidate_set_heads_generation_ck', sql`${table.generation} > 0`),
    ...tenantLegalEntityRlsPolicies('pricing_price_candidate_set_heads_scope', table.tenantId, table.legalEntityId),
  ],
);

export const priceRevisions = pricingSchema.table.withRLS(
  'price_revisions',
  {
    priceRevisionId: uuid('price_revision_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    priceId: uuid('price_id').notNull(),
    revisionNumber: integer('revision_number').notNull(),
    amount: numeric('amount', { precision: 38, scale: 9 }).notNull(),
    currencyCode: text('currency_code').notNull(),
    monetaryBoundary: text('monetary_boundary').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    previousRevisionId: uuid('previous_revision_id'),
    correctedRevisionId: uuid('corrected_revision_id'),
    transitionKind: text('transition_kind').default('INITIAL').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    reason: text('reason').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_price_revisions_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.priceId,
      table.priceRevisionId,
    ),
    unique('pricing_price_revisions_number_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.priceId,
      table.revisionNumber,
    ),
    unique('pricing_price_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.priceId],
      foreignColumns: [prices.tenantId, prices.legalEntityId, prices.priceId],
      name: 'pricing_price_revisions_price_fk',
    }).onDelete('restrict'),
    index('pricing_price_revisions_history_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.priceId,
      table.revisionNumber,
    ),
    check('pricing_price_revisions_number_ck', sql`${table.revisionNumber} > 0`),
    check('pricing_price_revisions_amount_ck', sql`${table.amount} >= 0`),
    check('pricing_price_revisions_currency_ck', sql`${table.currencyCode} ~ '^[A-Z]{3}$'`),
    check('pricing_price_revisions_boundary_ck', sql`${table.monetaryBoundary} = 'PRE_TAX'`),
    check(
      'pricing_price_revisions_period_ck',
      sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    check(
      'pricing_price_revisions_lineage_ck',
      sql`(${table.transitionKind} = 'INITIAL' and ${table.previousRevisionId} is null and ${table.correctedRevisionId} is null) or (${table.transitionKind} in ('VALUE_ONLY_CURRENT', 'SCHEDULED', 'RETIREMENT') and ${table.previousRevisionId} is not null and ${table.correctedRevisionId} is null) or (${table.transitionKind} = 'CORRECTION' and ${table.previousRevisionId} is not null and ${table.correctedRevisionId} is not null)`,
    ),
    check(
      'pricing_price_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...appendOnlyTenantLegalEntityRlsPolicies('pricing_price_revisions_scope', table.tenantId, table.legalEntityId),
  ],
);

/** Pricing is the sole operational authority for external Price source and mapping grants. */
export const externalPriceSourceAuthorityGrants = pricingSchema.table.withRLS(
  'external_price_source_authority_grants',
  {
    grantId: uuid('grant_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    sourceAuthorityRef: text('source_authority_ref').notNull(),
    sourceAuthorityVersion: text('source_authority_version').notNull(),
    mappingContractRef: text('mapping_contract_ref').notNull(),
    mappingContractVersion: text('mapping_contract_version').notNull(),
    exactIdentityKey: jsonb('exact_identity_key').$type<PriceIdentityKey>().notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    verificationRef: text('verification_ref').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_external_price_authority_identity_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.sourceAuthorityRef,
      table.sourceAuthorityVersion,
      table.mappingContractRef,
      table.mappingContractVersion,
      table.exactIdentityKey,
      table.effectiveFrom,
    ),
    index('pricing_external_price_authority_lookup_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.sourceAuthorityRef,
      table.sourceAuthorityVersion,
      table.mappingContractRef,
      table.mappingContractVersion,
      table.effectiveFrom,
    ),
    check(
      'pricing_external_price_authority_period_ck',
      sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    check(
      'pricing_external_price_authority_text_ck',
      sql`${table.sourceAuthorityRef} = btrim(${table.sourceAuthorityRef}) and length(${table.sourceAuthorityRef}) between 1 and 300 and ${table.sourceAuthorityVersion} = btrim(${table.sourceAuthorityVersion}) and length(${table.sourceAuthorityVersion}) between 1 and 100 and ${table.mappingContractRef} = btrim(${table.mappingContractRef}) and length(${table.mappingContractRef}) between 1 and 300 and ${table.mappingContractVersion} = btrim(${table.mappingContractVersion}) and length(${table.mappingContractVersion}) between 1 and 100 and ${table.verificationRef} = btrim(${table.verificationRef}) and length(${table.verificationRef}) between 1 and 300`,
    ),
    check(
      'pricing_external_price_authority_key_scope_ck',
      sql`jsonb_typeof(${table.exactIdentityKey}) = 'object' and ${table.exactIdentityKey}#>>'{catalogSelection,productRef,tenantId}' = ${table.tenantId}::text and ${table.exactIdentityKey}#>>'{catalogSelection,variantRef,tenantId}' = ${table.tenantId}::text and ${table.exactIdentityKey}#>>'{unitBasis,unitRef,tenantId}' = ${table.tenantId}::text and ${table.exactIdentityKey}#>>'{commercialScope,sellingLegalEntityId}' = ${table.legalEntityId}::text`,
    ),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_external_price_authority_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

/**
 * Immutable evidence explaining how one owner-qualified source fact mapped to one exact
 * canonical Price revision. Source delivery order and database write time are deliberately
 * absent from every identity constraint.
 */
export const priceSourceAssertions = pricingSchema.table.withRLS(
  'price_source_assertions',
  {
    sourceAssertionId: uuid('source_assertion_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    priceId: uuid('price_id').notNull(),
    priceRevisionId: uuid('price_revision_id').notNull(),
    sourceOwnerModuleId: text('source_owner_module_id').notNull(),
    sourceSystemRef: text('source_system_ref').notNull(),
    sourceRecordRef: text('source_record_ref').notNull(),
    sourceRecordVersion: text('source_record_version').notNull(),
    sourceChangeCorrelation: text('source_change_correlation').notNull(),
    sourceAuthorityRef: text('source_authority_ref').notNull(),
    sourceAuthorityVersion: text('source_authority_version').notNull(),
    mappingContractRef: text('mapping_contract_ref').notNull(),
    mappingContractVersion: text('mapping_contract_version').notNull(),
    sourceFactFingerprint: text('source_fact_fingerprint').notNull(),
    originalAssertion: jsonb('original_assertion').notNull(),
    preTaxNormalization: jsonb('pre_tax_normalization'),
    sourceEffectiveAt: timestamp('source_effective_at', { withTimezone: true }).notNull(),
    ownerBusinessEffectiveAt: timestamp('owner_business_effective_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull(),
    lineageKind: text('lineage_kind').notNull(),
    correctedSourceAssertionId: uuid('corrected_source_assertion_id'),
    supersededSourceAssertionId: uuid('superseded_source_assertion_id'),
    lineageActingPrincipalId: uuid('lineage_acting_principal_id'),
    lineageReason: text('lineage_reason'),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    recordedByPrincipalId: uuid('recorded_by_principal_id').notNull(),
    requestCorrelationId: text('request_correlation_id').notNull(),
    storedAt: timestamp('stored_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_price_source_assertions_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.priceId,
      table.sourceAssertionId,
    ),
    unique('pricing_price_source_assertions_lineage_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.sourceAssertionId,
    ),
    unique('pricing_price_source_assertions_owner_fact_uk').on(
      table.tenantId,
      table.sourceOwnerModuleId,
      table.sourceSystemRef,
      table.sourceRecordRef,
      table.sourceRecordVersion,
      table.sourceChangeCorrelation,
      table.mappingContractRef,
      table.mappingContractVersion,
    ),
    unique('pricing_price_source_assertions_invocation_uk').on(table.tenantId, table.actionInvocationId, table.priceId),
    unique('pricing_price_source_assertions_fingerprint_uk').on(table.tenantId, table.sourceFactFingerprint),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.priceId, table.priceRevisionId],
      foreignColumns: [
        priceRevisions.tenantId,
        priceRevisions.legalEntityId,
        priceRevisions.priceId,
        priceRevisions.priceRevisionId,
      ],
      name: 'pricing_price_source_assertions_revision_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.correctedSourceAssertionId],
      foreignColumns: [table.tenantId, table.legalEntityId, table.sourceAssertionId],
      name: 'pricing_price_source_assertions_corrected_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.supersededSourceAssertionId],
      foreignColumns: [table.tenantId, table.legalEntityId, table.sourceAssertionId],
      name: 'pricing_price_source_assertions_superseded_fk',
    }).onDelete('restrict'),
    index('pricing_price_source_assertions_revision_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.priceId,
      table.priceRevisionId,
    ),
    check(
      'pricing_price_source_assertions_source_identity_ck',
      sql`${table.sourceOwnerModuleId} = btrim(${table.sourceOwnerModuleId}) and length(${table.sourceOwnerModuleId}) between 1 and 300 and ${table.sourceOwnerModuleId} <> '*' and ${table.sourceSystemRef} = btrim(${table.sourceSystemRef}) and length(${table.sourceSystemRef}) between 1 and 300 and ${table.sourceSystemRef} <> '*' and ${table.sourceRecordRef} = btrim(${table.sourceRecordRef}) and length(${table.sourceRecordRef}) between 1 and 300 and ${table.sourceRecordRef} <> '*' and ${table.sourceRecordVersion} = btrim(${table.sourceRecordVersion}) and length(${table.sourceRecordVersion}) between 1 and 300 and ${table.sourceRecordVersion} <> '*' and ${table.sourceChangeCorrelation} = btrim(${table.sourceChangeCorrelation}) and length(${table.sourceChangeCorrelation}) between 1 and 300 and ${table.sourceChangeCorrelation} <> '*'`,
    ),
    check(
      'pricing_price_source_assertions_authority_mapping_ck',
      sql`${table.sourceAuthorityRef} = btrim(${table.sourceAuthorityRef}) and length(${table.sourceAuthorityRef}) between 1 and 300 and ${table.sourceAuthorityRef} <> '*' and ${table.sourceAuthorityVersion} = btrim(${table.sourceAuthorityVersion}) and length(${table.sourceAuthorityVersion}) between 1 and 300 and ${table.sourceAuthorityVersion} <> '*' and ${table.mappingContractRef} = btrim(${table.mappingContractRef}) and length(${table.mappingContractRef}) between 1 and 300 and ${table.mappingContractRef} <> '*' and ${table.mappingContractVersion} = btrim(${table.mappingContractVersion}) and length(${table.mappingContractVersion}) between 1 and 300 and ${table.mappingContractVersion} <> '*'`,
    ),
    check(
      'pricing_price_source_assertions_original_ck',
      sql`jsonb_typeof(${table.originalAssertion}) = 'object' and jsonb_typeof(${table.originalAssertion}->'monetaryAmount') = 'object' and (${table.originalAssertion}->'monetaryAmount'->>'amount') ~ '^(0|[1-9][0-9]*)(\\.[0-9]+)?$' and (${table.originalAssertion}->'monetaryAmount'->>'currencyCode') ~ '^[A-Z]{3}$' and ${table.originalAssertion}->>'monetaryBoundary' in ('PRE_TAX', 'TAX_INCLUSIVE') and jsonb_typeof(${table.originalAssertion}->'unitBasis') = 'object' and (${table.originalAssertion}->'unitBasis'->>'quantity') ~ '^(0|[1-9][0-9]*)(\\.[0-9]+)?$' and (${table.originalAssertion}->'unitBasis'->>'quantity')::numeric > 0 and jsonb_typeof(${table.originalAssertion}->'unitBasis'->'unitRef') = 'object'`,
    ),
    check(
      'pricing_price_source_assertions_normalization_ck',
      sql`(${table.originalAssertion}->>'monetaryBoundary' = 'PRE_TAX' and ${table.preTaxNormalization} is null) or (${table.originalAssertion}->>'monetaryBoundary' = 'TAX_INCLUSIVE' and jsonb_typeof(${table.preTaxNormalization}) = 'object' and ${table.preTaxNormalization}->'authority'->>'sourceAuthorityRef' = ${table.sourceAuthorityRef} and ${table.preTaxNormalization}->'authority'->>'sourceAuthorityVersion' = ${table.sourceAuthorityVersion} and (${table.preTaxNormalization}->'normalizedMonetaryAmount'->>'amount') ~ '^(0|[1-9][0-9]*)(\\.[0-9]+)?$' and (${table.preTaxNormalization}->'normalizedMonetaryAmount'->>'currencyCode') ~ '^[A-Z]{3}$')`,
    ),
    check(
      'pricing_price_source_assertions_lineage_ck',
      sql`(${table.lineageKind} = 'INITIAL' and ${table.correctedSourceAssertionId} is null and ${table.supersededSourceAssertionId} is null and ${table.lineageActingPrincipalId} is null and ${table.lineageReason} is null) or (${table.lineageKind} = 'CORRECTION' and ${table.correctedSourceAssertionId} is not null and ${table.supersededSourceAssertionId} is null and ${table.lineageActingPrincipalId} is not null and ${table.lineageReason} = btrim(${table.lineageReason}) and length(${table.lineageReason}) between 1 and 1000) or (${table.lineageKind} = 'SUPERSESSION' and ${table.correctedSourceAssertionId} is null and ${table.supersededSourceAssertionId} is not null and ${table.lineageActingPrincipalId} is not null and ${table.lineageReason} = btrim(${table.lineageReason}) and length(${table.lineageReason}) between 1 and 1000)`,
    ),
    check(
      'pricing_price_source_assertions_no_self_lineage_ck',
      sql`${table.correctedSourceAssertionId} is distinct from ${table.sourceAssertionId} and ${table.supersededSourceAssertionId} is distinct from ${table.sourceAssertionId}`,
    ),
    check(
      'pricing_price_source_assertions_correlation_ck',
      sql`${table.requestCorrelationId} = btrim(${table.requestCorrelationId}) and length(${table.requestCorrelationId}) between 1 and 500`,
    ),
    check('pricing_price_source_assertions_fingerprint_ck', sql`${table.sourceFactFingerprint} ~ '^[0-9a-f]{64}$'`),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_price_source_assertions_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

/** Immutable arrival evidence; repeated delivery never changes the canonical source fact. */
export const priceSourceAssertionDeliveries = pricingSchema.table.withRLS(
  'price_source_assertion_deliveries',
  {
    sourceAssertionDeliveryId: uuid('source_assertion_delivery_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    priceId: uuid('price_id').notNull(),
    sourceAssertionId: uuid('source_assertion_id').notNull(),
    deliveredSourceAssertionId: uuid('delivered_source_assertion_id').notNull(),
    deliveredEvidence: jsonb('delivered_evidence').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    recordedByPrincipalId: uuid('recorded_by_principal_id').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull(),
    requestCorrelationId: text('request_correlation_id').notNull(),
    storedAt: timestamp('stored_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_price_source_deliveries_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.sourceAssertionDeliveryId,
    ),
    unique('pricing_price_source_deliveries_invocation_uk').on(table.tenantId, table.actionInvocationId, table.priceId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.priceId, table.sourceAssertionId],
      foreignColumns: [
        priceSourceAssertions.tenantId,
        priceSourceAssertions.legalEntityId,
        priceSourceAssertions.priceId,
        priceSourceAssertions.sourceAssertionId,
      ],
      name: 'pricing_price_source_deliveries_assertion_fk',
    }).onDelete('restrict'),
    index('pricing_price_source_deliveries_assertion_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.priceId,
      table.sourceAssertionId,
      table.storedAt,
    ),
    check(
      'pricing_price_source_deliveries_correlation_ck',
      sql`${table.requestCorrelationId} = btrim(${table.requestCorrelationId}) and length(${table.requestCorrelationId}) between 1 and 500`,
    ),
    check(
      'pricing_price_source_deliveries_evidence_ck',
      sql`jsonb_typeof(${table.deliveredEvidence}) = 'object' and (${table.deliveredEvidence}->>'sourceFactFingerprint') ~ '^[0-9a-f]{64}$'`,
    ),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_price_source_deliveries_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

export const priceScheduleRevisions = pricingSchema.table.withRLS(
  'price_schedule_revisions',
  {
    priceScheduleRevisionId: uuid('price_schedule_revision_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    priceId: uuid('price_id').notNull(),
    scheduleRevision: integer('schedule_revision').notNull(),
    previousScheduleRevisionId: uuid('previous_schedule_revision_id'),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    reason: text('reason').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_price_schedule_revisions_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.priceId,
      table.priceScheduleRevisionId,
    ),
    unique('pricing_price_schedule_revisions_number_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.priceId,
      table.scheduleRevision,
    ),
    unique('pricing_price_schedule_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    check('pricing_price_schedule_revisions_number_ck', sql`${table.scheduleRevision} > 0`),
    check(
      'pricing_price_schedule_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_price_schedule_revisions_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

export const priceScheduleEntries = pricingSchema.table.withRLS(
  'price_schedule_entries',
  {
    priceScheduleEntryId: uuid('price_schedule_entry_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    priceId: uuid('price_id').notNull(),
    priceRevisionId: uuid('price_revision_id').notNull(),
    priceScheduleRevisionId: uuid('price_schedule_revision_id').notNull(),
    scheduleRevision: integer('schedule_revision').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
  },
  (table) => [
    unique('pricing_price_schedule_entries_revision_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.priceId,
      table.priceScheduleRevisionId,
      table.priceRevisionId,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.priceId, table.priceRevisionId],
      foreignColumns: [
        priceRevisions.tenantId,
        priceRevisions.legalEntityId,
        priceRevisions.priceId,
        priceRevisions.priceRevisionId,
      ],
      name: 'pricing_price_schedule_entries_revision_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.priceId, table.priceScheduleRevisionId],
      foreignColumns: [
        priceScheduleRevisions.tenantId,
        priceScheduleRevisions.legalEntityId,
        priceScheduleRevisions.priceId,
        priceScheduleRevisions.priceScheduleRevisionId,
      ],
      name: 'pricing_price_schedule_entries_schedule_fk',
    }).onDelete('restrict'),
    check(
      'pricing_price_schedule_entries_period_ck',
      sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    index('pricing_price_schedule_entries_at_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.priceId,
      table.scheduleRevision,
      table.effectiveFrom,
      table.effectiveTo,
    ),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_price_schedule_entries_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

export const priceScheduleAcknowledgements = pricingSchema.table.withRLS(
  'price_schedule_acknowledgements',
  {
    priceScheduleAcknowledgementId: uuid('price_schedule_acknowledgement_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    priceId: uuid('price_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    acknowledgement: jsonb('acknowledgement').$type<PriceScheduleAcknowledgement>().notNull(),
    issuedByPrincipalId: uuid('issued_by_principal_id').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_price_schedule_acknowledgements_fingerprint_uk').on(table.tenantId, table.fingerprint),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.priceId],
      foreignColumns: [prices.tenantId, prices.legalEntityId, prices.priceId],
      name: 'pricing_price_schedule_acknowledgements_price_fk',
    }).onDelete('restrict'),
    check('pricing_price_schedule_acknowledgements_fingerprint_ck', sql`${table.fingerprint} ~ '^[0-9a-f]{64}$'`),
    check(
      'pricing_price_schedule_acknowledgements_payload_ck',
      sql`jsonb_typeof(${table.acknowledgement}) = 'object' and ${table.acknowledgement}->>'fingerprint' = ${table.fingerprint}`,
    ),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_price_schedule_acknowledgements_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

export const priceScheduleHeads = pricingSchema.table.withRLS(
  'price_schedule_heads',
  {
    priceScheduleHeadId: uuid('price_schedule_head_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    priceId: uuid('price_id').notNull(),
    priceScheduleRevisionId: uuid('price_schedule_revision_id').notNull(),
    scheduleRevision: integer('schedule_revision').notNull(),
  },
  (table) => [
    unique('pricing_price_schedule_heads_scope_price_uk').on(table.tenantId, table.legalEntityId, table.priceId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.priceId, table.priceScheduleRevisionId],
      foreignColumns: [
        priceScheduleRevisions.tenantId,
        priceScheduleRevisions.legalEntityId,
        priceScheduleRevisions.priceId,
        priceScheduleRevisions.priceScheduleRevisionId,
      ],
      name: 'pricing_price_schedule_heads_revision_fk',
    }).onDelete('restrict'),
    check('pricing_price_schedule_heads_revision_ck', sql`${table.scheduleRevision} > 0`),
    ...tenantLegalEntityRlsPolicies('pricing_price_schedule_heads_scope', table.tenantId, table.legalEntityId),
  ],
);

// #756 compatibility projection: synchronized from the authoritative schedule head.
// It remains internal during expand/deploy; runtime has no direct table privileges.
export const priceCurrentRevisions = pricingSchema.table.withRLS(
  'price_current_revisions',
  {
    priceCurrentRevisionId: uuid('price_current_revision_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    priceId: uuid('price_id').notNull(),
    priceRevisionId: uuid('price_revision_id').notNull(),
    revisionNumber: integer('revision_number').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    boundByActionInvocationId: uuid('bound_by_action_invocation_id').notNull(),
    boundAt: timestamp('bound_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => {
    const predicate = sql`${table.tenantId} = nullif(current_setting('ontos.tenant_id', true), '')::uuid and ${table.legalEntityId} = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid`;
    return [
      unique('pricing_price_current_scope_price_uk').on(table.tenantId, table.legalEntityId, table.priceId),
      unique('pricing_price_current_scope_revision_uk').on(
        table.tenantId,
        table.legalEntityId,
        table.priceId,
        table.priceRevisionId,
      ),
      foreignKey({
        columns: [table.tenantId, table.legalEntityId, table.priceId, table.priceRevisionId],
        foreignColumns: [
          priceRevisions.tenantId,
          priceRevisions.legalEntityId,
          priceRevisions.priceId,
          priceRevisions.priceRevisionId,
        ],
        name: 'pricing_price_current_revision_fk',
      }).onDelete('restrict'),
      check('pricing_price_current_revision_number_ck', sql`${table.revisionNumber} > 0`),
      pgPolicy('pricing_price_current_scope_select', { for: 'select', to: 'ontos_runtime', using: predicate }),
      pgPolicy('pricing_price_current_scope_insert', {
        for: 'insert',
        to: 'ontos_runtime',
        withCheck: sql`false`,
      }),
      pgPolicy('pricing_price_current_scope_update', {
        for: 'update',
        to: 'ontos_runtime',
        using: sql`false`,
        withCheck: sql`false`,
      }),
      pgPolicy('pricing_price_current_scope_delete', { for: 'delete', to: 'ontos_runtime', using: sql`false` }),
    ];
  },
);

export const priceInvocationReceipts = pricingSchema.table.withRLS(
  'price_invocation_receipts',
  {
    priceInvocationReceiptId: uuid('price_invocation_receipt_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    requestedPriceId: uuid('requested_price_id').notNull(),
    resolvedPriceId: uuid('resolved_price_id').notNull(),
    resolvedPriceRevisionId: uuid('resolved_price_revision_id').notNull(),
    catalogSelection: jsonb('catalog_selection').$type<PriceIdentityKey['catalogSelection']>().notNull(),
    channelId: text('channel_id').notNull(),
    marketId: text('market_id').notNull(),
    currencyCode: text('currency_code').notNull(),
    unitRef: jsonb('unit_ref').$type<PriceIdentityKey['unitBasis']['unitRef']>().notNull(),
    basisQuantity: numeric('basis_quantity', { precision: 38, scale: 9 }).notNull(),
    priceGroupSelector: jsonb('price_group_selector').$type<PriceGroupSelector>().notNull(),
    amount: numeric('amount', { precision: 38, scale: 9 }).notNull(),
    monetaryBoundary: text('monetary_boundary').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    reason: text('reason').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_price_invocation_receipts_action_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.resolvedPriceId, table.resolvedPriceRevisionId],
      foreignColumns: [
        priceRevisions.tenantId,
        priceRevisions.legalEntityId,
        priceRevisions.priceId,
        priceRevisions.priceRevisionId,
      ],
      name: 'pricing_price_invocation_receipts_revision_fk',
    }).onDelete('restrict'),
    index('pricing_price_invocation_receipts_resolved_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.resolvedPriceId,
      table.resolvedPriceRevisionId,
    ),
    check(
      'pricing_price_invocation_receipts_catalog_selection_ck',
      sql`jsonb_typeof(${table.catalogSelection}) = 'object' and jsonb_typeof(${table.catalogSelection}->'productRef') = 'object' and jsonb_typeof(${table.catalogSelection}->'variantRef') = 'object'`,
    ),
    check(
      'pricing_price_invocation_receipts_dimensions_ck',
      sql`${table.channelId} = btrim(${table.channelId}) and length(${table.channelId}) between 1 and 300 and ${table.channelId} <> '*' and ${table.marketId} = btrim(${table.marketId}) and length(${table.marketId}) between 1 and 300 and ${table.marketId} <> '*'`,
    ),
    check('pricing_price_invocation_receipts_currency_ck', sql`${table.currencyCode} ~ '^[A-Z]{3}$'`),
    check(
      'pricing_price_invocation_receipts_values_ck',
      sql`${table.basisQuantity} > 0 and ${table.amount} >= 0 and ${table.monetaryBoundary} = 'PRE_TAX'`,
    ),
    check(
      'pricing_price_invocation_receipts_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_price_invocation_receipts_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

/** Tenant-wide invocation claim that prevents one Price/Fee Action identity from crossing SLE scope. */
export const priceFeeActionInvocationClaims = pricingSchema.table.withRLS(
  'price_fee_action_invocation_claims',
  {
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    actionKind: text('action_kind').notNull(),
    canonicalRequestPayload: jsonb('canonical_request_payload').notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.actionInvocationId],
      name: 'pricing_price_fee_action_claims_pk',
    }),
    unique('pricing_price_fee_action_claims_scope_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.actionInvocationId,
    ),
    check(
      'pricing_price_fee_action_claims_kind_ck',
      sql`${table.actionKind} in ('DEFINE_PRICE', 'REVISE_PRICE', 'DEFINE_COMMERCIAL_FEE', 'REVISE_COMMERCIAL_FEE', 'MANAGE_COMMERCIAL_FEE_REVISION')`,
    ),
    check('pricing_price_fee_action_claims_payload_ck', sql`jsonb_typeof(${table.canonicalRequestPayload}) = 'object'`),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_price_fee_action_claims_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

/** Exact committed owner results for Price and Fee Action recovery by the original invocation. */
export const priceFeeActionResultReceipts = pricingSchema.table.withRLS(
  'price_fee_action_result_receipts',
  {
    priceFeeActionResultReceiptId: uuid('price_fee_action_result_receipt_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actionKind: text('action_kind').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    requestPayload: jsonb('request_payload').notNull(),
    resultPayload: jsonb('result_payload').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_price_fee_action_results_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.actionInvocationId],
      foreignColumns: [
        priceFeeActionInvocationClaims.tenantId,
        priceFeeActionInvocationClaims.legalEntityId,
        priceFeeActionInvocationClaims.actionInvocationId,
      ],
      name: 'pricing_price_fee_action_results_claim_fk',
    }).onDelete('restrict'),
    check(
      'pricing_price_fee_action_results_kind_ck',
      sql`${table.actionKind} in ('DEFINE_PRICE', 'REVISE_PRICE', 'DEFINE_COMMERCIAL_FEE', 'REVISE_COMMERCIAL_FEE', 'MANAGE_COMMERCIAL_FEE_REVISION')`,
    ),
    check(
      'pricing_price_fee_action_results_payload_ck',
      sql`jsonb_typeof(${table.requestPayload}) = 'object' and jsonb_typeof(${table.resultPayload}) = 'object'`,
    ),
    check(
      'pricing_price_fee_action_results_outcome_ck',
      sql`case
      when ${table.actionKind} = 'DEFINE_PRICE' then ${table.resultPayload}->>'outcome' in ('CREATED', 'REUSED', 'CONFLICT')
      when ${table.actionKind} = 'REVISE_PRICE' then ${table.resultPayload}->>'outcome' in ('REVISED', 'UNCHANGED', 'CONFLICT')
      when ${table.actionKind} = 'DEFINE_COMMERCIAL_FEE' then ${table.resultPayload}->>'outcome' in ('COMMERCIAL_FEE_CREATED', 'COMMERCIAL_FEE_REUSED')
      else ${table.resultPayload}->>'outcome' in ('COMMERCIAL_FEE_REVISED', 'COMMERCIAL_FEE_UNCHANGED')
    end`,
    ),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_price_fee_action_results_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

/** Stable owner-private identity for one exact Variant-scoped Pricing Commercial Fee meaning. */
export const fees = pricingSchema.table.withRLS(
  'fees',
  {
    feeId: uuid('fee_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    family: text('family').notNull(),
    productRef: jsonb('product_ref').$type<PricingCommercialFeeCatalogTargetEvidence['productRef']>().notNull(),
    variantRef: jsonb('variant_ref').$type<PricingCommercialFeeIdentityKey['target']['variantRef']>().notNull(),
    channelId: text('channel_id').notNull(),
    marketId: text('market_id').notNull(),
    calculationBasis: text('calculation_basis').notNull(),
    basisQuantity: numeric('basis_quantity', { precision: 38, scale: 9 }),
    unitRef:
      jsonb('unit_ref').$type<
        Extract<
          PricingCommercialFeeIdentityKey['calculationBasis'],
          { readonly kind: 'FIXED_PER_UNIT' }
        >['unitBasis']['unitRef']
      >(),
    currencyCode: text('currency_code').notNull(),
    monetaryBoundary: text('monetary_boundary').notNull(),
    createdByActionInvocationId: uuid('created_by_action_invocation_id').notNull(),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_fees_scope_id_uk').on(table.tenantId, table.legalEntityId, table.feeId),
    unique('pricing_fees_scope_currency_uk').on(table.tenantId, table.legalEntityId, table.feeId, table.currencyCode),
    unique('pricing_fees_identity_uk')
      .on(
        table.tenantId,
        table.legalEntityId,
        table.family,
        table.variantRef,
        table.channelId,
        table.marketId,
        table.calculationBasis,
        table.basisQuantity,
        table.unitRef,
        table.currencyCode,
        table.monetaryBoundary,
      )
      .nullsNotDistinct(),
    unique('pricing_fees_invocation_uk').on(table.tenantId, table.createdByActionInvocationId),
    check('pricing_fees_family_ck', sql`${table.family} in ('RECYCLING_FEE', 'COPYRIGHT_FEE')`),
    check(
      'pricing_fees_variant_ck',
      sql`jsonb_typeof(${table.productRef}) = 'object' and ${table.productRef} = jsonb_build_object('moduleId', 'commerce.catalog', 'resourceId', ((${table.productRef}->>'resourceId')::uuid)::text, 'resourceType', 'commerce.catalog.product', 'tenantId', ${table.tenantId}::text) and jsonb_typeof(${table.variantRef}) = 'object' and ${table.variantRef} = jsonb_build_object('moduleId', 'commerce.catalog', 'resourceId', ((${table.variantRef}->>'resourceId')::uuid)::text, 'resourceType', 'commerce.catalog.variant', 'tenantId', ${table.tenantId}::text)`,
    ),
    check(
      'pricing_fees_scope_ck',
      sql`${table.channelId} in ('B2C', 'B2B') and ${table.marketId} = btrim(${table.marketId}) and length(${table.marketId}) between 1 and 300 and ${table.marketId} <> '*'`,
    ),
    check(
      'pricing_fees_basis_ck',
      sql`(${table.calculationBasis} = 'FIXED_PER_LINE' and ${table.basisQuantity} is null and ${table.unitRef} is null) or (${table.calculationBasis} = 'FIXED_PER_UNIT' and ${table.basisQuantity} > 0 and jsonb_typeof(${table.unitRef}) = 'object' and ${table.unitRef} = jsonb_build_object('moduleId', 'commerce.catalog', 'resourceId', ((${table.unitRef}->>'resourceId')::uuid)::text, 'resourceType', 'commerce.catalog.product-unit', 'tenantId', ${table.tenantId}::text))`,
    ),
    check('pricing_fees_currency_ck', sql`${table.currencyCode} ~ '^[A-Z]{3}$'`),
    check('pricing_fees_boundary_ck', sql`${table.monetaryBoundary} = 'PRE_TAX'`),
    ...appendOnlyTenantLegalEntityRlsPolicies('pricing_fees_scope', table.tenantId, table.legalEntityId),
  ],
);

/** Stable owner-private authority for every Fee applicable to one exact Variant predicate. */
export const feeSetRoots = pricingSchema.table.withRLS(
  'fee_set_roots',
  {
    feeSetRootId: uuid('fee_set_root_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    variantRef: jsonb('variant_ref').$type<PricingCommercialFeeIdentityKey['target']['variantRef']>().notNull(),
    channelId: text('channel_id').notNull(),
    marketId: text('market_id').notNull(),
    currencyCode: text('currency_code').notNull(),
    monetaryBoundary: text('monetary_boundary').notNull(),
    createdByActionInvocationId: uuid('created_by_action_invocation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_fee_set_roots_scope_id_uk').on(table.tenantId, table.legalEntityId, table.feeSetRootId),
    unique('pricing_fee_set_roots_predicate_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.variantRef,
      table.channelId,
      table.marketId,
      table.currencyCode,
      table.monetaryBoundary,
    ),
    check(
      'pricing_fee_set_roots_variant_ck',
      sql`jsonb_typeof(${table.variantRef}) = 'object' and ${table.variantRef} = jsonb_build_object('moduleId', 'commerce.catalog', 'resourceId', ((${table.variantRef}->>'resourceId')::uuid)::text, 'resourceType', 'commerce.catalog.variant', 'tenantId', ${table.tenantId}::text)`,
    ),
    check(
      'pricing_fee_set_roots_scope_ck',
      sql`${table.channelId} in ('B2C', 'B2B') and ${table.marketId} = btrim(${table.marketId}) and length(${table.marketId}) between 1 and 300 and ${table.marketId} <> '*'`,
    ),
    check('pricing_fee_set_roots_currency_ck', sql`${table.currencyCode} ~ '^[A-Z]{3}$'`),
    check('pricing_fee_set_roots_boundary_ck', sql`${table.monetaryBoundary} = 'PRE_TAX'`),
    ...appendOnlyTenantLegalEntityRlsPolicies('pricing_fee_set_roots_scope', table.tenantId, table.legalEntityId),
  ],
);

/** Immutable monotonic revisions of one complete Commercial Fee set. */
export const feeSetRevisions = pricingSchema.table.withRLS(
  'fee_set_revisions',
  {
    feeSetRevisionId: uuid('fee_set_revision_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    feeSetRootId: uuid('fee_set_root_id').notNull(),
    generation: integer('generation').notNull(),
    previousFeeSetRevisionId: uuid('previous_fee_set_revision_id'),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    mutationKind: text('mutation_kind').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_fee_set_revisions_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.feeSetRootId,
      table.feeSetRevisionId,
    ),
    unique('pricing_fee_set_revisions_generation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.feeSetRootId,
      table.generation,
    ),
    unique('pricing_fee_set_revisions_invocation_uk').on(table.tenantId, table.feeSetRootId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.feeSetRootId],
      foreignColumns: [feeSetRoots.tenantId, feeSetRoots.legalEntityId, feeSetRoots.feeSetRootId],
      name: 'pricing_fee_set_revisions_root_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.feeSetRootId, table.previousFeeSetRevisionId],
      foreignColumns: [table.tenantId, table.legalEntityId, table.feeSetRootId, table.feeSetRevisionId],
      name: 'pricing_fee_set_revisions_previous_fk',
    }).onDelete('restrict'),
    check('pricing_fee_set_revisions_generation_ck', sql`${table.generation} > 0`),
    check(
      'pricing_fee_set_revisions_lineage_ck',
      sql`(${table.generation} = 1 and ${table.previousFeeSetRevisionId} is null and ${table.mutationKind} in ('PRICE_PREDICATE_INITIALIZED', 'FEE_DEFINED')) or (${table.generation} > 1 and ${table.previousFeeSetRevisionId} is not null and ${table.mutationKind} in ('FEE_DEFINED', 'FEE_SCHEDULE_CHANGED'))`,
    ),
    ...appendOnlyTenantLegalEntityRlsPolicies('pricing_fee_set_revisions_scope', table.tenantId, table.legalEntityId),
  ],
);

/** Mutable pointer to the latest immutable Commercial Fee set revision. */
export const feeSetHeads = pricingSchema.table.withRLS(
  'fee_set_heads',
  {
    feeSetHeadId: uuid('fee_set_head_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    feeSetRootId: uuid('fee_set_root_id').notNull(),
    feeSetRevisionId: uuid('fee_set_revision_id').notNull(),
    generation: integer('generation').notNull(),
  },
  (table) => [
    unique('pricing_fee_set_heads_root_uk').on(table.tenantId, table.legalEntityId, table.feeSetRootId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.feeSetRootId, table.feeSetRevisionId],
      foreignColumns: [
        feeSetRevisions.tenantId,
        feeSetRevisions.legalEntityId,
        feeSetRevisions.feeSetRootId,
        feeSetRevisions.feeSetRevisionId,
      ],
      name: 'pricing_fee_set_heads_revision_fk',
    }).onDelete('restrict'),
    check('pricing_fee_set_heads_generation_ck', sql`${table.generation} > 0`),
    ...tenantLegalEntityRlsPolicies('pricing_fee_set_heads_scope', table.tenantId, table.legalEntityId),
  ],
);

/** Durable exact-command binding for successful Fee no-op Actions without advancing business revisions. */
export const feeActionInvocationReceipts = pricingSchema.table.withRLS(
  'fee_action_invocation_receipts',
  {
    feeActionInvocationReceiptId: uuid('fee_action_invocation_receipt_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    feeId: uuid('fee_id').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    commandFingerprint: text('command_fingerprint').notNull(),
    outcome: text('outcome').notNull(),
    resultScheduleRevision: integer('result_schedule_revision').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_fee_action_invocation_receipts_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.feeId],
      foreignColumns: [fees.tenantId, fees.legalEntityId, fees.feeId],
      name: 'pricing_fee_action_invocation_receipts_fee_fk',
    }).onDelete('restrict'),
    check('pricing_fee_action_invocation_receipts_fingerprint_ck', sql`${table.commandFingerprint} ~ '^[0-9a-f]{64}$'`),
    check('pricing_fee_action_invocation_receipts_outcome_ck', sql`${table.outcome} = 'COMMERCIAL_FEE_UNCHANGED'`),
    check('pricing_fee_action_invocation_receipts_schedule_ck', sql`${table.resultScheduleRevision} > 0`),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_fee_action_invocation_receipts_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

/** Immutable Fee value revisions. Effectivity lives only in the versioned schedule. */
export const feeRevisions = pricingSchema.table.withRLS(
  'fee_revisions',
  {
    feeRevisionId: uuid('fee_revision_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    feeId: uuid('fee_id').notNull(),
    revisionNumber: integer('revision_number').notNull(),
    amount: numeric('amount', { precision: 38, scale: 9 }).notNull(),
    currencyCode: text('currency_code').notNull(),
    catalogTargetEvidence: jsonb('catalog_target_evidence')
      .$type<PricingCommercialFeeCatalogTargetEvidence>()
      .notNull(),
    previousRevisionId: uuid('previous_revision_id'),
    correctedRevisionId: uuid('corrected_revision_id'),
    transitionKind: text('transition_kind').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    reason: text('reason').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_fee_revisions_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.feeId,
      table.feeRevisionId,
    ),
    unique('pricing_fee_revisions_number_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.feeId,
      table.revisionNumber,
    ),
    unique('pricing_fee_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.feeId],
      foreignColumns: [fees.tenantId, fees.legalEntityId, fees.feeId],
      name: 'pricing_fee_revisions_fee_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.feeId, table.currencyCode],
      foreignColumns: [fees.tenantId, fees.legalEntityId, fees.feeId, fees.currencyCode],
      name: 'pricing_fee_revisions_currency_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.feeId, table.previousRevisionId],
      foreignColumns: [table.tenantId, table.legalEntityId, table.feeId, table.feeRevisionId],
      name: 'pricing_fee_revisions_previous_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.feeId, table.correctedRevisionId],
      foreignColumns: [table.tenantId, table.legalEntityId, table.feeId, table.feeRevisionId],
      name: 'pricing_fee_revisions_corrected_fk',
    }).onDelete('restrict'),
    check('pricing_fee_revisions_number_ck', sql`${table.revisionNumber} > 0`),
    check('pricing_fee_revisions_amount_ck', sql`${table.amount} >= 0`),
    check('pricing_fee_revisions_currency_ck', sql`${table.currencyCode} ~ '^[A-Z]{3}$'`),
    check(
      'pricing_fee_revisions_catalog_evidence_ck',
      sql`jsonb_typeof(${table.catalogTargetEvidence}) = 'object' and ${table.catalogTargetEvidence}->>'capturedAt' is not null and ${table.catalogTargetEvidence}->>'catalogOwnerRevision' is not null and ${table.catalogTargetEvidence}->>'snapshotId' is not null and ${table.catalogTargetEvidence}->>'targetId' is not null and ${table.catalogTargetEvidence}->'productRef' = jsonb_build_object('moduleId', 'commerce.catalog', 'resourceId', ((${table.catalogTargetEvidence}#>>'{productRef,resourceId}')::uuid)::text, 'resourceType', 'commerce.catalog.product', 'tenantId', ${table.tenantId}::text) and ${table.catalogTargetEvidence}->'variantRef' = jsonb_build_object('moduleId', 'commerce.catalog', 'resourceId', ((${table.catalogTargetEvidence}#>>'{variantRef,resourceId}')::uuid)::text, 'resourceType', 'commerce.catalog.variant', 'tenantId', ${table.tenantId}::text)`,
    ),
    check(
      'pricing_fee_revisions_lineage_ck',
      sql`(${table.transitionKind} = 'INITIAL' and ${table.previousRevisionId} is null and ${table.correctedRevisionId} is null) or (${table.transitionKind} in ('VALUE_ONLY_CURRENT', 'SCHEDULED', 'RETIREMENT') and ${table.previousRevisionId} is not null and ${table.correctedRevisionId} is null) or (${table.transitionKind} = 'CORRECTION' and ${table.previousRevisionId} is not null and ${table.correctedRevisionId} is not null)`,
    ),
    check(
      'pricing_fee_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...appendOnlyTenantLegalEntityRlsPolicies('pricing_fee_revisions_scope', table.tenantId, table.legalEntityId),
  ],
);

export const feeScheduleRevisions = pricingSchema.table.withRLS(
  'fee_schedule_revisions',
  {
    feeScheduleRevisionId: uuid('fee_schedule_revision_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    feeId: uuid('fee_id').notNull(),
    scheduleRevision: integer('schedule_revision').notNull(),
    previousScheduleRevisionId: uuid('previous_schedule_revision_id'),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    commandFingerprint: text('command_fingerprint').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    reason: text('reason').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_fee_schedule_revisions_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.feeId,
      table.feeScheduleRevisionId,
    ),
    unique('pricing_fee_schedule_revisions_number_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.feeId,
      table.scheduleRevision,
    ),
    unique('pricing_fee_schedule_revisions_entry_fk_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.feeId,
      table.feeScheduleRevisionId,
      table.scheduleRevision,
    ),
    unique('pricing_fee_schedule_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    check('pricing_fee_schedule_revisions_command_fingerprint_ck', sql`${table.commandFingerprint} ~ '^[0-9a-f]{64}$'`),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.feeId],
      foreignColumns: [fees.tenantId, fees.legalEntityId, fees.feeId],
      name: 'pricing_fee_schedule_revisions_fee_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.feeId, table.previousScheduleRevisionId],
      foreignColumns: [table.tenantId, table.legalEntityId, table.feeId, table.feeScheduleRevisionId],
      name: 'pricing_fee_schedule_revisions_previous_fk',
    }).onDelete('restrict'),
    check('pricing_fee_schedule_revisions_number_ck', sql`${table.scheduleRevision} > 0`),
    check(
      'pricing_fee_schedule_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_fee_schedule_revisions_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

export const feeScheduleEntries = pricingSchema.table.withRLS(
  'fee_schedule_entries',
  {
    feeScheduleEntryId: uuid('fee_schedule_entry_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    feeId: uuid('fee_id').notNull(),
    feeRevisionId: uuid('fee_revision_id').notNull(),
    feeScheduleRevisionId: uuid('fee_schedule_revision_id').notNull(),
    scheduleRevision: integer('schedule_revision').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
  },
  (table) => [
    unique('pricing_fee_schedule_entries_revision_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.feeId,
      table.feeScheduleRevisionId,
      table.feeRevisionId,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.feeId, table.feeRevisionId],
      foreignColumns: [
        feeRevisions.tenantId,
        feeRevisions.legalEntityId,
        feeRevisions.feeId,
        feeRevisions.feeRevisionId,
      ],
      name: 'pricing_fee_schedule_entries_revision_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.feeId, table.feeScheduleRevisionId, table.scheduleRevision],
      foreignColumns: [
        feeScheduleRevisions.tenantId,
        feeScheduleRevisions.legalEntityId,
        feeScheduleRevisions.feeId,
        feeScheduleRevisions.feeScheduleRevisionId,
        feeScheduleRevisions.scheduleRevision,
      ],
      name: 'pricing_fee_schedule_entries_schedule_fk',
    }).onDelete('restrict'),
    check(
      'pricing_fee_schedule_entries_period_ck',
      sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    index('pricing_fee_schedule_entries_at_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.feeId,
      table.scheduleRevision,
      table.effectiveFrom,
      table.effectiveTo,
    ),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_fee_schedule_entries_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

export const feeScheduleAcknowledgements = pricingSchema.table.withRLS(
  'fee_schedule_acknowledgements',
  {
    feeScheduleAcknowledgementId: uuid('fee_schedule_acknowledgement_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    feeId: uuid('fee_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    acknowledgement: jsonb('acknowledgement').$type<PricingCommercialFeeScheduleAcknowledgement>().notNull(),
    issuedByPrincipalId: uuid('issued_by_principal_id').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_fee_schedule_acknowledgements_fingerprint_uk').on(table.tenantId, table.fingerprint),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.feeId],
      foreignColumns: [fees.tenantId, fees.legalEntityId, fees.feeId],
      name: 'pricing_fee_schedule_acknowledgements_fee_fk',
    }).onDelete('restrict'),
    check('pricing_fee_schedule_acknowledgements_fingerprint_ck', sql`${table.fingerprint} ~ '^[0-9a-f]{64}$'`),
    check(
      'pricing_fee_schedule_acknowledgements_payload_ck',
      sql`jsonb_typeof(${table.acknowledgement}) = 'object' and ${table.acknowledgement}->>'fingerprint' = ${table.fingerprint}`,
    ),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_fee_schedule_acknowledgements_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

export const feeScheduleHeads = pricingSchema.table.withRLS(
  'fee_schedule_heads',
  {
    feeScheduleHeadId: uuid('fee_schedule_head_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    feeId: uuid('fee_id').notNull(),
    feeScheduleRevisionId: uuid('fee_schedule_revision_id').notNull(),
    scheduleRevision: integer('schedule_revision').notNull(),
  },
  (table) => [
    unique('pricing_fee_schedule_heads_fee_uk').on(table.tenantId, table.legalEntityId, table.feeId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.feeId, table.feeScheduleRevisionId, table.scheduleRevision],
      foreignColumns: [
        feeScheduleRevisions.tenantId,
        feeScheduleRevisions.legalEntityId,
        feeScheduleRevisions.feeId,
        feeScheduleRevisions.feeScheduleRevisionId,
        feeScheduleRevisions.scheduleRevision,
      ],
      name: 'pricing_fee_schedule_heads_revision_fk',
    }).onDelete('restrict'),
    check('pricing_fee_schedule_heads_revision_ck', sql`${table.scheduleRevision} > 0`),
    ...tenantLegalEntityRlsPolicies('pricing_fee_schedule_heads_scope', table.tenantId, table.legalEntityId),
  ],
);

/** Stable owner-private authority for the complete Quantity Tier set of one exact Price. */
/** Exact Quantity Tier Action results for principal-bound original-invocation lookup. */
export const quantityTierActionResultReceipts = pricingSchema.table.withRLS(
  'quantity_tier_action_result_receipts',
  {
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    actionKind: text('action_kind').notNull(),
    requestPayload: jsonb('request_payload').notNull(),
    resultPayload: jsonb('result_payload').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.actionInvocationId],
      name: 'pricing_quantity_tier_action_results_pk',
    }),
    check('pricing_quantity_tier_action_results_kind_ck', sql`${table.actionKind} in ('DEFINE', 'REVISE')`),
    check('pricing_quantity_tier_action_results_request_ck', sql`jsonb_typeof(${table.requestPayload}) = 'object'`),
    check('pricing_quantity_tier_action_results_result_ck', sql`jsonb_typeof(${table.resultPayload}) = 'object'`),
    pgPolicy('pricing_quantity_tier_action_results_scope_select', {
      for: 'select',
      to: 'ontos_runtime',
      using: sql`${table.tenantId} = nullif(current_setting('ontos.tenant_id', true), '')::uuid and ${table.legalEntityId} = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid`,
    }),
    pgPolicy('pricing_quantity_tier_action_results_scope_insert', {
      for: 'insert',
      to: 'ontos_runtime',
      withCheck: sql`${table.tenantId} = nullif(current_setting('ontos.tenant_id', true), '')::uuid and ${table.legalEntityId} = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid`,
    }),
  ],
);

export const quantityTierSetRoots = pricingSchema.table.withRLS(
  'quantity_tier_set_roots',
  {
    quantityTierSetRootId: uuid('quantity_tier_set_root_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    priceId: uuid('price_id').notNull(),
    createdByActionInvocationId: uuid('created_by_action_invocation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_quantity_tier_set_roots_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.priceId,
      table.quantityTierSetRootId,
    ),
    unique('pricing_quantity_tier_set_roots_price_uk').on(table.tenantId, table.legalEntityId, table.priceId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.priceId],
      foreignColumns: [prices.tenantId, prices.legalEntityId, prices.priceId],
      name: 'pricing_quantity_tier_set_roots_price_fk',
    }).onDelete('restrict'),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_quantity_tier_set_roots_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

/** Immutable monotonic generations for the complete Tier set owned by one exact Price. */
export const quantityTierSetRevisions = pricingSchema.table.withRLS(
  'quantity_tier_set_revisions',
  {
    quantityTierSetRevisionId: uuid('quantity_tier_set_revision_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    priceId: uuid('price_id').notNull(),
    quantityTierSetRootId: uuid('quantity_tier_set_root_id').notNull(),
    generation: integer('generation').notNull(),
    previousQuantityTierSetRevisionId: uuid('previous_quantity_tier_set_revision_id'),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    mutationKind: text('mutation_kind').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_quantity_tier_set_revisions_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.priceId,
      table.quantityTierSetRootId,
      table.quantityTierSetRevisionId,
    ),
    unique('pricing_quantity_tier_set_revisions_generation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.quantityTierSetRootId,
      table.generation,
    ),
    unique('pricing_quantity_tier_set_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.priceId, table.quantityTierSetRootId],
      foreignColumns: [
        quantityTierSetRoots.tenantId,
        quantityTierSetRoots.legalEntityId,
        quantityTierSetRoots.priceId,
        quantityTierSetRoots.quantityTierSetRootId,
      ],
      name: 'pricing_quantity_tier_set_revisions_root_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.tenantId,
        table.legalEntityId,
        table.priceId,
        table.quantityTierSetRootId,
        table.previousQuantityTierSetRevisionId,
      ],
      foreignColumns: [
        table.tenantId,
        table.legalEntityId,
        table.priceId,
        table.quantityTierSetRootId,
        table.quantityTierSetRevisionId,
      ],
      name: 'pricing_quantity_tier_set_revisions_previous_fk',
    }).onDelete('restrict'),
    check('pricing_quantity_tier_set_revisions_generation_ck', sql`${table.generation} > 0`),
    check(
      'pricing_quantity_tier_set_revisions_lineage_ck',
      sql`(${table.generation} = 1 and ${table.previousQuantityTierSetRevisionId} is null and ${table.mutationKind} = 'PRICE_CREATED') or (${table.generation} > 1 and ${table.previousQuantityTierSetRevisionId} is not null and ${table.mutationKind} in ('TIER_DEFINED', 'TIER_REVISED'))`,
    ),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_quantity_tier_set_revisions_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

/** Mutable pointer to the latest immutable complete-set generation. */
export const quantityTierSetHeads = pricingSchema.table.withRLS(
  'quantity_tier_set_heads',
  {
    quantityTierSetHeadId: uuid('quantity_tier_set_head_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    priceId: uuid('price_id').notNull(),
    quantityTierSetRootId: uuid('quantity_tier_set_root_id').notNull(),
    quantityTierSetRevisionId: uuid('quantity_tier_set_revision_id').notNull(),
    generation: integer('generation').notNull(),
  },
  (table) => [
    unique('pricing_quantity_tier_set_heads_price_uk').on(table.tenantId, table.legalEntityId, table.priceId),
    foreignKey({
      columns: [
        table.tenantId,
        table.legalEntityId,
        table.priceId,
        table.quantityTierSetRootId,
        table.quantityTierSetRevisionId,
      ],
      foreignColumns: [
        quantityTierSetRevisions.tenantId,
        quantityTierSetRevisions.legalEntityId,
        quantityTierSetRevisions.priceId,
        quantityTierSetRevisions.quantityTierSetRootId,
        quantityTierSetRevisions.quantityTierSetRevisionId,
      ],
      name: 'pricing_quantity_tier_set_heads_revision_fk',
    }).onDelete('restrict'),
    check('pricing_quantity_tier_set_heads_generation_ck', sql`${table.generation} > 0`),
    ...tenantLegalEntityRlsPolicies('pricing_quantity_tier_set_heads_scope', table.tenantId, table.legalEntityId),
  ],
);

/** Stable owner-private identity for one threshold and one exact Price quantity basis. */
export const quantityTiers = pricingSchema.table.withRLS(
  'quantity_tiers',
  {
    quantityTierId: uuid('quantity_tier_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    priceId: uuid('price_id').notNull(),
    thresholdQuantity: numeric('threshold_quantity', { precision: 38, scale: 9 }).notNull(),
    catalogQuantityBasis: jsonb('catalog_quantity_basis')
      .$type<QuantityTierQuantityBasis['catalogQuantityBasis']>()
      .notNull(),
    priceCurrencyCode: text('price_currency_code').notNull(),
    priceBasisQuantity: numeric('price_basis_quantity', { precision: 38, scale: 9 }).notNull(),
    priceUnitRef: jsonb('price_unit_ref').$type<QuantityTierQuantityBasis['priceUnitBasis']['unitRef']>().notNull(),
    createdByActionInvocationId: uuid('created_by_action_invocation_id').notNull(),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_quantity_tiers_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.priceId,
      table.quantityTierId,
    ),
    unique('pricing_quantity_tiers_identity_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.priceId,
      table.thresholdQuantity,
      table.catalogQuantityBasis,
      table.priceBasisQuantity,
      table.priceUnitRef,
    ),
    unique('pricing_quantity_tiers_scope_currency_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.priceId,
      table.quantityTierId,
      table.priceCurrencyCode,
    ),
    unique('pricing_quantity_tiers_invocation_uk').on(table.tenantId, table.createdByActionInvocationId),
    foreignKey({
      columns: [
        table.tenantId,
        table.legalEntityId,
        table.priceId,
        table.priceCurrencyCode,
        table.priceBasisQuantity,
        table.priceUnitRef,
      ],
      foreignColumns: [
        prices.tenantId,
        prices.legalEntityId,
        prices.priceId,
        prices.currencyCode,
        prices.basisQuantity,
        prices.unitRef,
      ],
      name: 'pricing_quantity_tiers_price_basis_fk',
    }).onDelete('restrict'),
    check('pricing_quantity_tiers_threshold_ck', sql`${table.thresholdQuantity} > 0`),
    check('pricing_quantity_tiers_currency_ck', sql`${table.priceCurrencyCode} ~ '^[A-Z]{3}$'`),
    check('pricing_quantity_tiers_price_basis_quantity_ck', sql`${table.priceBasisQuantity} > 0`),
    check(
      'pricing_quantity_tiers_catalog_basis_ck',
      sql`jsonb_typeof(${table.catalogQuantityBasis}) = 'object' and jsonb_typeof(${table.catalogQuantityBasis}->'targetRef') = 'object' and jsonb_typeof(${table.catalogQuantityBasis}->'unitRef') = 'object' and (${table.catalogQuantityBasis}->>'targetDivisibilityRevision')::numeric > 0 and (${table.catalogQuantityBasis}->>'unitRuleRevision')::numeric > 0 and ${table.catalogQuantityBasis}->'unitRef' = ${table.priceUnitRef}`,
    ),
    check(
      'pricing_quantity_tiers_price_unit_ck',
      sql`jsonb_typeof(${table.priceUnitRef}) = 'object' and ${table.priceUnitRef}->>'resourceType' = 'commerce.catalog.product-unit'`,
    ),
    ...appendOnlyTenantLegalEntityRlsPolicies('pricing_quantity_tiers_scope', table.tenantId, table.legalEntityId),
  ],
);

/** Immutable value revisions. Effectivity lives only in the versioned schedule. */
export const quantityTierRevisions = pricingSchema.table.withRLS(
  'quantity_tier_revisions',
  {
    quantityTierRevisionId: uuid('quantity_tier_revision_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    priceId: uuid('price_id').notNull(),
    quantityTierId: uuid('quantity_tier_id').notNull(),
    revisionNumber: integer('revision_number').notNull(),
    resultingAmount: numeric('resulting_amount', { precision: 38, scale: 9 }).notNull(),
    currencyCode: text('currency_code').notNull(),
    previousRevisionId: uuid('previous_revision_id'),
    correctedRevisionId: uuid('corrected_revision_id'),
    transitionKind: text('transition_kind').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    reason: text('reason').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_quantity_tier_revisions_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.priceId,
      table.quantityTierId,
      table.quantityTierRevisionId,
    ),
    unique('pricing_quantity_tier_revisions_number_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.quantityTierId,
      table.revisionNumber,
    ),
    unique('pricing_quantity_tier_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.priceId, table.quantityTierId],
      foreignColumns: [
        quantityTiers.tenantId,
        quantityTiers.legalEntityId,
        quantityTiers.priceId,
        quantityTiers.quantityTierId,
      ],
      name: 'pricing_quantity_tier_revisions_tier_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.priceId, table.quantityTierId, table.currencyCode],
      foreignColumns: [
        quantityTiers.tenantId,
        quantityTiers.legalEntityId,
        quantityTiers.priceId,
        quantityTiers.quantityTierId,
        quantityTiers.priceCurrencyCode,
      ],
      name: 'pricing_quantity_tier_revisions_currency_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.priceId, table.quantityTierId, table.previousRevisionId],
      foreignColumns: [
        table.tenantId,
        table.legalEntityId,
        table.priceId,
        table.quantityTierId,
        table.quantityTierRevisionId,
      ],
      name: 'pricing_quantity_tier_revisions_previous_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.priceId, table.quantityTierId, table.correctedRevisionId],
      foreignColumns: [
        table.tenantId,
        table.legalEntityId,
        table.priceId,
        table.quantityTierId,
        table.quantityTierRevisionId,
      ],
      name: 'pricing_quantity_tier_revisions_corrected_fk',
    }).onDelete('restrict'),
    check('pricing_quantity_tier_revisions_number_ck', sql`${table.revisionNumber} > 0`),
    check('pricing_quantity_tier_revisions_amount_ck', sql`${table.resultingAmount} >= 0`),
    check('pricing_quantity_tier_revisions_currency_ck', sql`${table.currencyCode} ~ '^[A-Z]{3}$'`),
    check(
      'pricing_quantity_tier_revisions_lineage_ck',
      sql`(${table.transitionKind} = 'INITIAL' and ${table.previousRevisionId} is null and ${table.correctedRevisionId} is null) or (${table.transitionKind} in ('VALUE_ONLY_CURRENT', 'SCHEDULED', 'RETIREMENT') and ${table.previousRevisionId} is not null and ${table.correctedRevisionId} is null) or (${table.transitionKind} = 'CORRECTION' and ${table.previousRevisionId} is not null and ${table.correctedRevisionId} is not null)`,
    ),
    check(
      'pricing_quantity_tier_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_quantity_tier_revisions_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

export const quantityTierScheduleRevisions = pricingSchema.table.withRLS(
  'quantity_tier_schedule_revisions',
  {
    quantityTierScheduleRevisionId: uuid('quantity_tier_schedule_revision_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    priceId: uuid('price_id').notNull(),
    quantityTierId: uuid('quantity_tier_id').notNull(),
    scheduleRevision: integer('schedule_revision').notNull(),
    previousScheduleRevisionId: uuid('previous_schedule_revision_id'),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    reason: text('reason').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_quantity_tier_schedule_revisions_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.priceId,
      table.quantityTierId,
      table.quantityTierScheduleRevisionId,
    ),
    unique('pricing_quantity_tier_schedule_revisions_number_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.quantityTierId,
      table.scheduleRevision,
    ),
    unique('pricing_quantity_tier_schedule_revisions_entry_fk_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.priceId,
      table.quantityTierId,
      table.quantityTierScheduleRevisionId,
      table.scheduleRevision,
    ),
    unique('pricing_quantity_tier_schedule_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.priceId, table.quantityTierId],
      foreignColumns: [
        quantityTiers.tenantId,
        quantityTiers.legalEntityId,
        quantityTiers.priceId,
        quantityTiers.quantityTierId,
      ],
      name: 'pricing_quantity_tier_schedule_revisions_tier_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.tenantId,
        table.legalEntityId,
        table.priceId,
        table.quantityTierId,
        table.previousScheduleRevisionId,
      ],
      foreignColumns: [
        table.tenantId,
        table.legalEntityId,
        table.priceId,
        table.quantityTierId,
        table.quantityTierScheduleRevisionId,
      ],
      name: 'pricing_quantity_tier_schedule_revisions_previous_fk',
    }).onDelete('restrict'),
    check('pricing_quantity_tier_schedule_revisions_number_ck', sql`${table.scheduleRevision} > 0`),
    check(
      'pricing_quantity_tier_schedule_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_quantity_tier_schedule_revisions_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

export const quantityTierScheduleEntries = pricingSchema.table.withRLS(
  'quantity_tier_schedule_entries',
  {
    quantityTierScheduleEntryId: uuid('quantity_tier_schedule_entry_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    priceId: uuid('price_id').notNull(),
    quantityTierId: uuid('quantity_tier_id').notNull(),
    quantityTierRevisionId: uuid('quantity_tier_revision_id').notNull(),
    quantityTierScheduleRevisionId: uuid('quantity_tier_schedule_revision_id').notNull(),
    scheduleRevision: integer('schedule_revision').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
  },
  (table) => [
    unique('pricing_quantity_tier_schedule_entries_revision_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.quantityTierId,
      table.quantityTierScheduleRevisionId,
      table.quantityTierRevisionId,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.priceId, table.quantityTierId, table.quantityTierRevisionId],
      foreignColumns: [
        quantityTierRevisions.tenantId,
        quantityTierRevisions.legalEntityId,
        quantityTierRevisions.priceId,
        quantityTierRevisions.quantityTierId,
        quantityTierRevisions.quantityTierRevisionId,
      ],
      name: 'pricing_quantity_tier_schedule_entries_revision_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.tenantId,
        table.legalEntityId,
        table.priceId,
        table.quantityTierId,
        table.quantityTierScheduleRevisionId,
        table.scheduleRevision,
      ],
      foreignColumns: [
        quantityTierScheduleRevisions.tenantId,
        quantityTierScheduleRevisions.legalEntityId,
        quantityTierScheduleRevisions.priceId,
        quantityTierScheduleRevisions.quantityTierId,
        quantityTierScheduleRevisions.quantityTierScheduleRevisionId,
        quantityTierScheduleRevisions.scheduleRevision,
      ],
      name: 'pricing_quantity_tier_schedule_entries_schedule_fk',
    }).onDelete('restrict'),
    check(
      'pricing_quantity_tier_schedule_entries_period_ck',
      sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    index('pricing_quantity_tier_schedule_entries_at_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.quantityTierId,
      table.scheduleRevision,
      table.effectiveFrom,
      table.effectiveTo,
    ),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_quantity_tier_schedule_entries_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

export const quantityTierScheduleAcknowledgements = pricingSchema.table.withRLS(
  'quantity_tier_schedule_acknowledgements',
  {
    quantityTierScheduleAcknowledgementId: uuid('quantity_tier_schedule_acknowledgement_id')
      .defaultRandom()
      .primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    priceId: uuid('price_id').notNull(),
    quantityTierId: uuid('quantity_tier_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    acknowledgement: jsonb('acknowledgement').$type<QuantityTierScheduleAcknowledgement>().notNull(),
    issuedByPrincipalId: uuid('issued_by_principal_id').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_quantity_tier_schedule_acknowledgements_fingerprint_uk').on(table.tenantId, table.fingerprint),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.priceId, table.quantityTierId],
      foreignColumns: [
        quantityTiers.tenantId,
        quantityTiers.legalEntityId,
        quantityTiers.priceId,
        quantityTiers.quantityTierId,
      ],
      name: 'pricing_quantity_tier_schedule_acknowledgements_tier_fk',
    }).onDelete('restrict'),
    check(
      'pricing_quantity_tier_schedule_acknowledgements_fingerprint_ck',
      sql`${table.fingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'pricing_quantity_tier_schedule_acknowledgements_payload_ck',
      sql`jsonb_typeof(${table.acknowledgement}) = 'object' and ${table.acknowledgement}->>'fingerprint' = ${table.fingerprint}`,
    ),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_quantity_tier_schedule_acknowledgements_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

export const quantityTierScheduleHeads = pricingSchema.table.withRLS(
  'quantity_tier_schedule_heads',
  {
    quantityTierScheduleHeadId: uuid('quantity_tier_schedule_head_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    priceId: uuid('price_id').notNull(),
    quantityTierId: uuid('quantity_tier_id').notNull(),
    quantityTierScheduleRevisionId: uuid('quantity_tier_schedule_revision_id').notNull(),
    scheduleRevision: integer('schedule_revision').notNull(),
  },
  (table) => [
    unique('pricing_quantity_tier_schedule_heads_tier_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.quantityTierId,
    ),
    foreignKey({
      columns: [
        table.tenantId,
        table.legalEntityId,
        table.priceId,
        table.quantityTierId,
        table.quantityTierScheduleRevisionId,
        table.scheduleRevision,
      ],
      foreignColumns: [
        quantityTierScheduleRevisions.tenantId,
        quantityTierScheduleRevisions.legalEntityId,
        quantityTierScheduleRevisions.priceId,
        quantityTierScheduleRevisions.quantityTierId,
        quantityTierScheduleRevisions.quantityTierScheduleRevisionId,
        quantityTierScheduleRevisions.scheduleRevision,
      ],
      name: 'pricing_quantity_tier_schedule_heads_revision_fk',
    }).onDelete('restrict'),
    check('pricing_quantity_tier_schedule_heads_revision_ck', sql`${table.scheduleRevision} > 0`),
    ...tenantLegalEntityRlsPolicies('pricing_quantity_tier_schedule_heads_scope', table.tenantId, table.legalEntityId),
  ],
);

/** One durable complete-set authority for all contractual Discounts in one Tenant/SLE. */
export const contractualDiscountSetRoots = pricingSchema.table.withRLS(
  'contractual_discount_set_roots',
  {
    contractualDiscountSetRootId: uuid('contractual_discount_set_root_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    createdByActionInvocationId: uuid('created_by_action_invocation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_contractual_discount_set_roots_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.contractualDiscountSetRootId,
    ),
    unique('pricing_contractual_discount_set_roots_scope_uk').on(table.tenantId, table.legalEntityId),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_contractual_discount_set_roots_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

export const contractualDiscountSetRevisions = pricingSchema.table.withRLS(
  'contractual_discount_set_revisions',
  {
    contractualDiscountSetRevisionId: uuid('contractual_discount_set_revision_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    contractualDiscountSetRootId: uuid('contractual_discount_set_root_id').notNull(),
    generation: integer('generation').notNull(),
    previousContractualDiscountSetRevisionId: uuid('previous_contractual_discount_set_revision_id'),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    mutationKind: text('mutation_kind').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_contractual_discount_set_revisions_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.contractualDiscountSetRootId,
      table.contractualDiscountSetRevisionId,
    ),
    unique('pricing_contractual_discount_set_revisions_generation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.contractualDiscountSetRootId,
      table.generation,
    ),
    unique('pricing_contractual_discount_set_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.contractualDiscountSetRootId],
      foreignColumns: [
        contractualDiscountSetRoots.tenantId,
        contractualDiscountSetRoots.legalEntityId,
        contractualDiscountSetRoots.contractualDiscountSetRootId,
      ],
      name: 'pricing_contractual_discount_set_revisions_root_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.tenantId,
        table.legalEntityId,
        table.contractualDiscountSetRootId,
        table.previousContractualDiscountSetRevisionId,
      ],
      foreignColumns: [
        table.tenantId,
        table.legalEntityId,
        table.contractualDiscountSetRootId,
        table.contractualDiscountSetRevisionId,
      ],
      name: 'pricing_contractual_discount_set_revisions_previous_fk',
    }).onDelete('restrict'),
    check('pricing_contractual_discount_set_revisions_generation_ck', sql`${table.generation} > 0`),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_contractual_discount_set_revisions_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

export const contractualDiscountSetHeads = pricingSchema.table.withRLS(
  'contractual_discount_set_heads',
  {
    contractualDiscountSetHeadId: uuid('contractual_discount_set_head_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    contractualDiscountSetRootId: uuid('contractual_discount_set_root_id').notNull(),
    contractualDiscountSetRevisionId: uuid('contractual_discount_set_revision_id').notNull(),
    generation: integer('generation').notNull(),
  },
  (table) => [
    unique('pricing_contractual_discount_set_heads_scope_uk').on(table.tenantId, table.legalEntityId),
    foreignKey({
      columns: [
        table.tenantId,
        table.legalEntityId,
        table.contractualDiscountSetRootId,
        table.contractualDiscountSetRevisionId,
      ],
      foreignColumns: [
        contractualDiscountSetRevisions.tenantId,
        contractualDiscountSetRevisions.legalEntityId,
        contractualDiscountSetRevisions.contractualDiscountSetRootId,
        contractualDiscountSetRevisions.contractualDiscountSetRevisionId,
      ],
      name: 'pricing_contractual_discount_set_heads_revision_fk',
    }).onDelete('restrict'),
    check('pricing_contractual_discount_set_heads_generation_ck', sql`${table.generation} > 0`),
    ...tenantLegalEntityRlsPolicies(
      'pricing_contractual_discount_set_heads_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

export const contractualDiscounts = pricingSchema.table.withRLS(
  'contractual_discounts',
  {
    discountId: uuid('discount_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    identityRef: text('identity_ref').notNull(),
    identityKey: jsonb('identity_key').$type<PricingDiscountIdentityKey>().notNull(),
    createdByActionInvocationId: uuid('created_by_action_invocation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_contractual_discounts_scope_id_uk').on(table.tenantId, table.legalEntityId, table.discountId),
    unique('pricing_contractual_discounts_identity_uk').on(table.tenantId, table.legalEntityId, table.identityRef),
    unique('pricing_contractual_discounts_invocation_uk').on(table.tenantId, table.createdByActionInvocationId),
    check('pricing_contractual_discounts_identity_ref_ck', sql`length(${table.identityRef}) = 64`),
    check('pricing_contractual_discounts_identity_payload_ck', sql`jsonb_typeof(${table.identityKey}) = 'object'`),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_contractual_discounts_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

/** Immutable full schedule snapshots; this avoids history loss during correction or retirement. */
export const contractualDiscountRevisions = pricingSchema.table.withRLS(
  'contractual_discount_revisions',
  {
    contractualDiscountRevisionId: uuid('contractual_discount_revision_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    discountId: uuid('discount_id').notNull(),
    scheduleRevision: integer('schedule_revision').notNull(),
    previousContractualDiscountRevisionId: uuid('previous_contractual_discount_revision_id'),
    schedule: jsonb('schedule').$type<PricingDiscountScheduleSnapshot>().notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    commandFingerprint: text('command_fingerprint').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    reason: text('reason').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_contractual_discount_revisions_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.discountId,
      table.contractualDiscountRevisionId,
    ),
    unique('pricing_contractual_discount_revisions_number_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.discountId,
      table.scheduleRevision,
    ),
    unique('pricing_contractual_discount_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.discountId],
      foreignColumns: [
        contractualDiscounts.tenantId,
        contractualDiscounts.legalEntityId,
        contractualDiscounts.discountId,
      ],
      name: 'pricing_contractual_discount_revisions_discount_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.discountId, table.previousContractualDiscountRevisionId],
      foreignColumns: [table.tenantId, table.legalEntityId, table.discountId, table.contractualDiscountRevisionId],
      name: 'pricing_contractual_discount_revisions_previous_fk',
    }).onDelete('restrict'),
    check('pricing_contractual_discount_revisions_number_ck', sql`${table.scheduleRevision} > 0`),
    check('pricing_contractual_discount_revisions_schedule_ck', sql`jsonb_typeof(${table.schedule}) = 'object'`),
    check('pricing_contractual_discount_revisions_fingerprint_ck', sql`${table.commandFingerprint} ~ '^[0-9a-f]{64}$'`),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_contractual_discount_revisions_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

export const contractualDiscountScheduleHeads = pricingSchema.table.withRLS(
  'contractual_discount_schedule_heads',
  {
    contractualDiscountScheduleHeadId: uuid('contractual_discount_schedule_head_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    discountId: uuid('discount_id').notNull(),
    contractualDiscountRevisionId: uuid('contractual_discount_revision_id').notNull(),
    scheduleRevision: integer('schedule_revision').notNull(),
  },
  (table) => [
    unique('pricing_contractual_discount_schedule_heads_discount_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.discountId,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.discountId, table.contractualDiscountRevisionId],
      foreignColumns: [
        contractualDiscountRevisions.tenantId,
        contractualDiscountRevisions.legalEntityId,
        contractualDiscountRevisions.discountId,
        contractualDiscountRevisions.contractualDiscountRevisionId,
      ],
      name: 'pricing_contractual_discount_schedule_heads_revision_fk',
    }).onDelete('restrict'),
    check('pricing_contractual_discount_schedule_heads_revision_ck', sql`${table.scheduleRevision} > 0`),
    ...tenantLegalEntityRlsPolicies(
      'pricing_contractual_discount_schedule_heads_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

export const contractualDiscountActionInvocationReceipts = pricingSchema.table.withRLS(
  'contractual_discount_action_invocation_receipts',
  {
    contractualDiscountActionInvocationReceiptId: uuid('contractual_discount_action_invocation_receipt_id')
      .defaultRandom()
      .primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id'),
    commandFingerprint: text('command_fingerprint').notNull(),
    outcome: jsonb('outcome').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_contractual_discount_action_receipts_invocation_uk').on(table.tenantId, table.actionInvocationId),
    check(
      'pricing_contractual_discount_action_receipts_fingerprint_ck',
      sql`${table.commandFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check('pricing_contractual_discount_action_receipts_outcome_ck', sql`jsonb_typeof(${table.outcome}) = 'object'`),
    check('pricing_contractual_discount_receipts_principal_ck', sql`${table.actingPrincipalId} is not null`),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_contractual_discount_action_receipts_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

export const contractualDiscountScheduleAcknowledgements = pricingSchema.table.withRLS(
  'contractual_discount_schedule_acknowledgements',
  {
    contractualDiscountScheduleAcknowledgementId: uuid('contractual_discount_schedule_acknowledgement_id')
      .defaultRandom()
      .primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    discountId: uuid('discount_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    acknowledgement: jsonb('acknowledgement').$type<PricingDiscountScheduleAcknowledgement>().notNull(),
    issuedByPrincipalId: uuid('issued_by_principal_id').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_discount_schedule_ack_fingerprint_uk').on(table.tenantId, table.fingerprint),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.discountId],
      foreignColumns: [
        contractualDiscounts.tenantId,
        contractualDiscounts.legalEntityId,
        contractualDiscounts.discountId,
      ],
      name: 'pricing_contractual_discount_schedule_acknowledgements_discount_fk',
    }).onDelete('restrict'),
    check('pricing_discount_schedule_ack_fingerprint_ck', sql`${table.fingerprint} ~ '^[0-9a-f]{64}$'`),
    check(
      'pricing_discount_schedule_ack_payload_ck',
      sql`jsonb_typeof(${table.acknowledgement}) = 'object' and ${table.acknowledgement}->>'fingerprint' = ${table.fingerprint}`,
    ),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_contractual_discount_schedule_acknowledgements_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

/** ZERO_FLOOR uses one complete-set generation for each Tenant/SLE governance boundary. */
export const zeroFloorSetRoots = pricingSchema.table.withRLS(
  'zero_floor_set_roots',
  {
    zeroFloorSetRootId: uuid('zero_floor_set_root_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    createdByActionInvocationId: text('created_by_action_invocation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_zero_floor_set_roots_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.zeroFloorSetRootId,
    ),
    unique('pricing_zero_floor_set_roots_scope_uk').on(table.tenantId, table.legalEntityId),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_zero_floor_set_roots_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

export const zeroFloorSetRevisions = pricingSchema.table.withRLS(
  'zero_floor_set_revisions',
  {
    zeroFloorSetRevisionId: uuid('zero_floor_set_revision_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    zeroFloorSetRootId: uuid('zero_floor_set_root_id').notNull(),
    generation: integer('generation').notNull(),
    previousZeroFloorSetRevisionId: uuid('previous_zero_floor_set_revision_id'),
    actionInvocationId: text('action_invocation_id').notNull(),
    mutationKind: text('mutation_kind').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_zero_floor_set_revisions_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.zeroFloorSetRootId,
      table.zeroFloorSetRevisionId,
    ),
    unique('pricing_zero_floor_set_revisions_generation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.zeroFloorSetRootId,
      table.generation,
    ),
    unique('pricing_zero_floor_set_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.zeroFloorSetRootId],
      foreignColumns: [
        zeroFloorSetRoots.tenantId,
        zeroFloorSetRoots.legalEntityId,
        zeroFloorSetRoots.zeroFloorSetRootId,
      ],
      name: 'pricing_zero_floor_set_revisions_root_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.zeroFloorSetRootId, table.previousZeroFloorSetRevisionId],
      foreignColumns: [table.tenantId, table.legalEntityId, table.zeroFloorSetRootId, table.zeroFloorSetRevisionId],
      name: 'pricing_zero_floor_set_revisions_previous_fk',
    }).onDelete('restrict'),
    check('pricing_zero_floor_set_revisions_generation_ck', sql`${table.generation} > 0`),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_zero_floor_set_revisions_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

export const zeroFloorSetHeads = pricingSchema.table.withRLS(
  'zero_floor_set_heads',
  {
    zeroFloorSetHeadId: uuid('zero_floor_set_head_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    zeroFloorSetRootId: uuid('zero_floor_set_root_id').notNull(),
    zeroFloorSetRevisionId: uuid('zero_floor_set_revision_id').notNull(),
    generation: integer('generation').notNull(),
  },
  (table) => [
    unique('pricing_zero_floor_set_heads_scope_uk').on(table.tenantId, table.legalEntityId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.zeroFloorSetRootId, table.zeroFloorSetRevisionId],
      foreignColumns: [
        zeroFloorSetRevisions.tenantId,
        zeroFloorSetRevisions.legalEntityId,
        zeroFloorSetRevisions.zeroFloorSetRootId,
        zeroFloorSetRevisions.zeroFloorSetRevisionId,
      ],
      name: 'pricing_zero_floor_set_heads_revision_fk',
    }).onDelete('restrict'),
    check('pricing_zero_floor_set_heads_generation_ck', sql`${table.generation} > 0`),
    ...tenantLegalEntityRlsPolicies('pricing_zero_floor_set_heads_scope', table.tenantId, table.legalEntityId),
  ],
);

export const zeroFloorAuthorizations = pricingSchema.table.withRLS(
  'zero_floor_authorizations',
  {
    zeroFloorAuthorizationId: uuid('zero_floor_authorization_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    authorizationRef: text('authorization_ref').notNull(),
    createdByActionInvocationId: text('created_by_action_invocation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_zero_floor_authorizations_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.zeroFloorAuthorizationId,
    ),
    unique('pricing_zero_floor_authorizations_ref_uk').on(table.tenantId, table.legalEntityId, table.authorizationRef),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_zero_floor_authorizations_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

export const zeroFloorAuthorizationRevisions = pricingSchema.table.withRLS(
  'zero_floor_authorization_revisions',
  {
    zeroFloorAuthorizationRevisionId: uuid('zero_floor_authorization_revision_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    zeroFloorAuthorizationId: uuid('zero_floor_authorization_id').notNull(),
    scheduleRevision: integer('schedule_revision').notNull(),
    previousZeroFloorAuthorizationRevisionId: uuid('previous_zero_floor_authorization_revision_id'),
    schedule: jsonb('schedule').$type<ZeroFloorAuthorizationScheduleSnapshot>().notNull(),
    actionInvocationId: text('action_invocation_id').notNull(),
    commandFingerprint: text('command_fingerprint').notNull(),
    actingPrincipalId: text('acting_principal_id').notNull(),
    reason: text('reason').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_zero_floor_authorization_revisions_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.zeroFloorAuthorizationId,
      table.zeroFloorAuthorizationRevisionId,
    ),
    unique('pricing_zero_floor_authorization_revisions_number_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.zeroFloorAuthorizationId,
      table.scheduleRevision,
    ),
    unique('pricing_zero_floor_authorization_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.zeroFloorAuthorizationId],
      foreignColumns: [
        zeroFloorAuthorizations.tenantId,
        zeroFloorAuthorizations.legalEntityId,
        zeroFloorAuthorizations.zeroFloorAuthorizationId,
      ],
      name: 'pricing_zero_floor_authorization_revisions_authorization_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.tenantId,
        table.legalEntityId,
        table.zeroFloorAuthorizationId,
        table.previousZeroFloorAuthorizationRevisionId,
      ],
      foreignColumns: [
        table.tenantId,
        table.legalEntityId,
        table.zeroFloorAuthorizationId,
        table.zeroFloorAuthorizationRevisionId,
      ],
      name: 'pricing_zero_floor_authorization_revisions_previous_fk',
    }).onDelete('restrict'),
    check('pricing_zero_floor_authorization_revisions_number_ck', sql`${table.scheduleRevision} > 0`),
    check('pricing_zero_floor_authorization_revisions_schedule_ck', sql`jsonb_typeof(${table.schedule}) = 'object'`),
    check(
      'pricing_zero_floor_authorization_revisions_fingerprint_ck',
      sql`${table.commandFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_zero_floor_authorization_revisions_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

export const zeroFloorAuthorizationScheduleHeads = pricingSchema.table.withRLS(
  'zero_floor_authorization_schedule_heads',
  {
    zeroFloorAuthorizationScheduleHeadId: uuid('zero_floor_authorization_schedule_head_id')
      .defaultRandom()
      .primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    zeroFloorAuthorizationId: uuid('zero_floor_authorization_id').notNull(),
    zeroFloorAuthorizationRevisionId: uuid('zero_floor_authorization_revision_id').notNull(),
    scheduleRevision: integer('schedule_revision').notNull(),
  },
  (table) => [
    unique('pricing_zero_floor_authorization_schedule_heads_authorization_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.zeroFloorAuthorizationId,
    ),
    foreignKey({
      columns: [
        table.tenantId,
        table.legalEntityId,
        table.zeroFloorAuthorizationId,
        table.zeroFloorAuthorizationRevisionId,
      ],
      foreignColumns: [
        zeroFloorAuthorizationRevisions.tenantId,
        zeroFloorAuthorizationRevisions.legalEntityId,
        zeroFloorAuthorizationRevisions.zeroFloorAuthorizationId,
        zeroFloorAuthorizationRevisions.zeroFloorAuthorizationRevisionId,
      ],
      name: 'pricing_zero_floor_authorization_schedule_heads_revision_fk',
    }).onDelete('restrict'),
    check('pricing_zero_floor_authorization_schedule_heads_revision_ck', sql`${table.scheduleRevision} > 0`),
    ...tenantLegalEntityRlsPolicies(
      'pricing_zero_floor_authorization_schedule_heads_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

export const zeroFloorActionInvocationReceipts = pricingSchema.table.withRLS(
  'zero_floor_action_invocation_receipts',
  {
    zeroFloorActionInvocationReceiptId: uuid('zero_floor_action_invocation_receipt_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    actionInvocationId: text('action_invocation_id').notNull(),
    actingPrincipalId: text('acting_principal_id'),
    commandFingerprint: text('command_fingerprint').notNull(),
    outcome: jsonb('outcome').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('pricing_zero_floor_action_receipts_invocation_uk').on(table.tenantId, table.actionInvocationId),
    check('pricing_zero_floor_action_receipts_fingerprint_ck', sql`${table.commandFingerprint} ~ '^[0-9a-f]{64}$'`),
    check('pricing_zero_floor_action_receipts_outcome_ck', sql`jsonb_typeof(${table.outcome}) = 'object'`),
    check('pricing_zero_floor_action_receipts_principal_ck', sql`${table.actingPrincipalId} is not null`),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_zero_floor_action_receipts_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

/** Durable governance-owner approval; proposed Authorization reads can never self-enrol authority. */
export const zeroFloorGovernanceApprovals = pricingSchema.table.withRLS(
  'zero_floor_governance_approvals',
  {
    zeroFloorGovernanceApprovalId: uuid('zero_floor_governance_approval_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    approvalEvidenceRef: text('approval_evidence_ref').notNull(),
    approvalRevision: text('approval_revision').notNull(),
    authorizationFingerprint: text('authorization_fingerprint').notNull(),
    approvalEvidence: jsonb('approval_evidence').notNull(),
    approvedByPrincipalId: text('approved_by_principal_id').notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
    actionInvocationId: text('action_invocation_id').notNull(),
  },
  (table) => [
    unique('pricing_zero_floor_governance_approvals_ref_revision_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.approvalEvidenceRef,
      table.approvalRevision,
    ),
    unique('pricing_zero_floor_governance_approvals_fingerprint_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.authorizationFingerprint,
      table.approvalRevision,
    ),
    unique('pricing_zero_floor_governance_approvals_invocation_uk').on(table.tenantId, table.actionInvocationId),
    check(
      'pricing_zero_floor_governance_approvals_fingerprint_ck',
      sql`${table.authorizationFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'pricing_zero_floor_governance_approvals_payload_ck',
      sql`jsonb_typeof(${table.approvalEvidence}) = 'object'`,
    ),
    check('pricing_zero_floor_governance_approvals_validity_ck', sql`${table.validUntil} > ${table.validFrom}`),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_zero_floor_governance_approvals_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

export const zeroFloorScheduleAcknowledgements = pricingSchema.table.withRLS(
  'zero_floor_schedule_acknowledgements',
  {
    zeroFloorScheduleAcknowledgementId: uuid('zero_floor_schedule_acknowledgement_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    authorizationRef: text('authorization_ref').notNull(),
    fingerprint: text('fingerprint').notNull(),
    proposedPayloadFingerprint: text('proposed_payload_fingerprint').notNull(),
    acknowledgement: jsonb('acknowledgement').notNull(),
    issuedByPrincipalId: text('issued_by_principal_id').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('pricing_zero_floor_schedule_acknowledgements_fingerprint_uk').on(table.tenantId, table.fingerprint),
    check('pricing_zero_floor_schedule_acknowledgements_fingerprint_ck', sql`${table.fingerprint} ~ '^[0-9a-f]{64}$'`),
    check(
      'pricing_zero_floor_schedule_acknowledgements_payload_fingerprint_ck',
      sql`${table.proposedPayloadFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'pricing_zero_floor_schedule_acknowledgements_payload_ck',
      sql`jsonb_typeof(${table.acknowledgement}) = 'object' and ${table.acknowledgement}->>'fingerprint' = ${table.fingerprint}`,
    ),
    check('pricing_zero_floor_schedule_acknowledgements_validity_ck', sql`${table.validUntil} > ${table.issuedAt}`),
    ...appendOnlyTenantLegalEntityRlsPolicies(
      'pricing_zero_floor_schedule_acknowledgements_scope',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

export const PRICING_TABLES = [
  contractualDiscountActionInvocationReceipts,
  contractualDiscountRevisions,
  contractualDiscountScheduleAcknowledgements,
  contractualDiscountScheduleHeads,
  contractualDiscounts,
  contractualDiscountSetHeads,
  contractualDiscountSetRevisions,
  contractualDiscountSetRoots,
  currencySupportActionResultReceipts,
  currencySupportRecoveryCompensationReceipts,
  currencySupportProofReceipts,
  currencySupportRevisions,
  currencySupportRoots,
  currencySupportScheduleEntries,
  currencySupportScheduleHeads,
  currencySupportScheduleRevisions,
  currencySupportValueRevisions,
  externalPriceSourceAuthorityGrants,
  feeActionInvocationReceipts,
  feeSetHeads,
  feeSetRevisions,
  feeSetRoots,
  feeRevisions,
  feeScheduleAcknowledgements,
  feeScheduleEntries,
  feeScheduleHeads,
  feeScheduleRevisions,
  fees,
  gatewayAssertionRedemptions,
  materialEvidenceProofReceipts,
  priceCandidateSetHeads,
  priceCandidateSetRevisions,
  priceCandidateSetRoots,
  priceCurrentRevisions,
  priceFeeActionInvocationClaims,
  priceFeeActionResultReceipts,
  priceInvocationReceipts,
  priceRevisions,
  priceScheduleAcknowledgements,
  priceScheduleEntries,
  priceScheduleHeads,
  priceScheduleRevisions,
  priceSourceAssertionDeliveries,
  priceSourceAssertions,
  prices,
  pricingCommitmentConfirmations,
  pricingQuotations,
  quantityTierActionResultReceipts,
  quantityTierRevisions,
  quantityTierSetHeads,
  quantityTierSetRevisions,
  quantityTierSetRoots,
  quantityTierScheduleAcknowledgements,
  quantityTierScheduleEntries,
  quantityTierScheduleHeads,
  quantityTierScheduleRevisions,
  quantityTiers,
  zeroFloorActionInvocationReceipts,
  zeroFloorAuthorizationRevisions,
  zeroFloorAuthorizationScheduleHeads,
  zeroFloorAuthorizations,
  zeroFloorGovernanceApprovals,
  zeroFloorScheduleAcknowledgements,
  zeroFloorSetHeads,
  zeroFloorSetRevisions,
  zeroFloorSetRoots,
] as const;
