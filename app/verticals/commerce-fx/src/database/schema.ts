/* oxlint-disable perfectionist/sort-objects -- Drizzle declaration order is the physical database contract; expires: 2027-03-31. */
import { tenantLegalEntityRlsPolicies } from '@app/core-runtime';
import { defineRelations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  pgPolicy,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

export const COMMERCE_FX_SCHEMA_NAME = 'commerce_fx';
export const COMMERCE_FX_TABLE_INVENTORY = [
  'manual_rate_policy_heads',
  'manual_rate_policy_mutation_journal',
  'manual_rate_policy_revisions',
] as const;

export const commerceFxSchema = pgSchema(COMMERCE_FX_SCHEMA_NAME);

const scopeColumns = () => ({
  tenantId: uuid('tenant_id').notNull(),
  legalEntityId: uuid('legal_entity_id').notNull(),
});

const scopedPolicies = (
  prefix: string,
  table: Readonly<Record<'tenantId' | 'legalEntityId', AnyPgColumn>>,
) => {
  const predicate = sql`${table.tenantId} = nullif(current_setting('ontos.tenant_id', true), '')::uuid and ${table.legalEntityId} = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid`;
  return [
    ...tenantLegalEntityRlsPolicies(prefix, table.tenantId, table.legalEntityId),
    pgPolicy(`${prefix}_owner_routine`, {
      for: 'all',
      to: 'public',
      using: predicate,
      withCheck: predicate,
    }),
  ] as const;
};

const boundedIdentifier = (name: string, column: AnyPgColumn) =>
  check(
    name,
    sql`${column} = btrim(${column}) and length(${column}) between 1 and 64 and ${column} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'`,
  );

export const manualRatePolicyHeads = commerceFxSchema.table.withRLS(
  'manual_rate_policy_heads',
  {
    manualRatePolicyHeadId: uuid('manual_rate_policy_head_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    channelId: text('channel_id').notNull(),
    marketId: text('market_id').notNull(),
    storefrontId: text('storefront_id').notNull(),
    purpose: text('purpose').notNull(),
    sourceCurrencyCode: text('source_currency_code').notNull(),
    targetCurrencyCode: text('target_currency_code').notNull(),
    currentRevision: integer('current_revision').default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('commerce_fx_manual_heads_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.manualRatePolicyHeadId,
    ),
    unique('commerce_fx_manual_heads_context_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.channelId,
      table.marketId,
      table.storefrontId,
      table.purpose,
      table.sourceCurrencyCode,
      table.targetCurrencyCode,
    ),
    boundedIdentifier('commerce_fx_manual_heads_channel_ck', table.channelId),
    boundedIdentifier('commerce_fx_manual_heads_market_ck', table.marketId),
    boundedIdentifier('commerce_fx_manual_heads_storefront_ck', table.storefrontId),
    check(
      'commerce_fx_manual_heads_purpose_ck',
      sql`${table.purpose} in ('PRICING', 'PURCHASE_LIMIT_COMPARISON', 'PAYMENT', 'DISPLAY')`,
    ),
    check(
      'commerce_fx_manual_heads_pair_ck',
      sql`${table.sourceCurrencyCode} ~ '^[A-Z]{3}$' and ${table.targetCurrencyCode} ~ '^[A-Z]{3}$' and ${table.sourceCurrencyCode} <> ${table.targetCurrencyCode}`,
    ),
    check('commerce_fx_manual_heads_revision_ck', sql`${table.currentRevision} >= 0`),
    ...scopedPolicies('commerce_fx_manual_heads_scope', table),
  ],
);

export const manualRatePolicyRevisions = commerceFxSchema.table.withRLS(
  'manual_rate_policy_revisions',
  {
    manualRatePolicyRevisionId: uuid('manual_rate_policy_revision_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    manualRatePolicyHeadId: uuid('manual_rate_policy_head_id').notNull(),
    revision: integer('revision').notNull(),
    operation: text('operation').notNull(),
    arithmeticVersion: text('arithmetic_version'),
    rate: text('rate'),
    direction: text('direction'),
    rateSourceId: text('rate_source_id').notNull(),
    sourceRevision: text('source_revision').notNull(),
    rateObservedAt: timestamp('rate_observed_at', { withTimezone: true }),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    inverseRatePermitted: boolean('inverse_rate_permitted'),
    maximumRateAgeSeconds: integer('maximum_rate_age_seconds'),
    roundingIncrement: text('rounding_increment'),
    roundingMode: text('rounding_mode'),
    roundingRuleRevision: text('rounding_rule_revision'),
    targetMinorUnits: integer('target_minor_units'),
    reason: text('reason').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('commerce_fx_manual_revisions_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.manualRatePolicyRevisionId,
    ),
    unique('commerce_fx_manual_revisions_number_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.manualRatePolicyHeadId,
      table.revision,
    ),
    unique('commerce_fx_manual_revisions_source_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.manualRatePolicyHeadId,
      table.sourceRevision,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.manualRatePolicyHeadId],
      foreignColumns: [
        manualRatePolicyHeads.tenantId,
        manualRatePolicyHeads.legalEntityId,
        manualRatePolicyHeads.manualRatePolicyHeadId,
      ],
      name: 'commerce_fx_manual_revisions_head_fk',
    }).onDelete('restrict'),
    check('commerce_fx_manual_revisions_revision_ck', sql`${table.revision} > 0`),
    check(
      'commerce_fx_manual_revisions_operation_ck',
      sql`${table.operation} in ('SET', 'WITHDRAW')`,
    ),
    boundedIdentifier('commerce_fx_manual_revisions_source_id_ck', table.rateSourceId),
    check(
      'commerce_fx_manual_revisions_source_revision_ck',
      sql`${table.sourceRevision} = btrim(${table.sourceRevision}) and length(${table.sourceRevision}) between 1 and 200 and ${table.sourceRevision} ~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]*$'`,
    ),
    check(
      'commerce_fx_manual_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 1000`,
    ),
    check(
      'commerce_fx_manual_revisions_set_shape_ck',
      sql`(${table.operation} = 'SET' and ${table.arithmeticVersion} is not null and ${table.arithmeticVersion} = 'commercial-fx-arithmetic.v1' and ${table.rate} is not null and ${table.rate} ~ '^(?:0|[1-9][0-9]{0,37})(?:[.][0-9]{1,18})?$' and ${table.rate} !~ '^0(?:[.]0+)?$' and ${table.direction} is not null and ${table.direction} in ('SOURCE_TO_TARGET', 'TARGET_TO_SOURCE') and ${table.rateObservedAt} is not null and ${table.effectiveTo} is not null and ${table.effectiveTo} > ${table.effectiveFrom} and ${table.inverseRatePermitted} is not null and ${table.maximumRateAgeSeconds} is not null and ${table.maximumRateAgeSeconds} between 0 and 31536000 and ${table.roundingIncrement} is not null and ${table.roundingIncrement} ~ '^(?:0|[1-9][0-9]{0,37})(?:[.][0-9]{1,18})?$' and ${table.roundingIncrement} !~ '^0(?:[.]0+)?$' and ${table.roundingIncrement}::numeric = trunc(${table.roundingIncrement}::numeric, ${table.targetMinorUnits}) and ${table.roundingMode} is not null and ${table.roundingMode} in ('ceil', 'floor', 'to-zero', 'from-zero', 'half-ceil', 'half-floor', 'half-to-zero', 'half-from-zero', 'half-even', 'half-odd') and ${table.roundingRuleRevision} is not null and ${table.roundingRuleRevision} = btrim(${table.roundingRuleRevision}) and length(${table.roundingRuleRevision}) between 1 and 200 and ${table.roundingRuleRevision} ~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]*$' and ${table.targetMinorUnits} is not null and ${table.targetMinorUnits} between 0 and 18 and (${table.direction} = 'SOURCE_TO_TARGET' or ${table.inverseRatePermitted})) or (${table.operation} = 'WITHDRAW' and ${table.arithmeticVersion} is null and ${table.rate} is null and ${table.direction} is null and ${table.rateObservedAt} is null and ${table.effectiveTo} is null and ${table.inverseRatePermitted} is null and ${table.maximumRateAgeSeconds} is null and ${table.roundingIncrement} is null and ${table.roundingMode} is null and ${table.roundingRuleRevision} is null and ${table.targetMinorUnits} is null)`,
    ),
    ...scopedPolicies('commerce_fx_manual_revisions_scope', table),
  ],
);

export const manualRatePolicyMutationJournal = commerceFxSchema.table.withRLS(
  'manual_rate_policy_mutation_journal',
  {
    manualRatePolicyMutationId: uuid('manual_rate_policy_mutation_id').defaultRandom().primaryKey(),
    ...scopeColumns(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    requestPayload: jsonb('request_payload').notNull(),
    resultPayload: jsonb('result_payload').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('commerce_fx_manual_journal_scope_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.manualRatePolicyMutationId,
    ),
    unique('commerce_fx_manual_journal_invocation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.actionInvocationId,
    ),
    ...scopedPolicies('commerce_fx_manual_journal_scope', table),
  ],
);

export const commerceFxDatabaseSchema = {
  manualRatePolicyHeads,
  manualRatePolicyMutationJournal,
  manualRatePolicyRevisions,
} as const;

export const COMMERCE_FX_TABLES = [
  manualRatePolicyHeads,
  manualRatePolicyMutationJournal,
  manualRatePolicyRevisions,
] as const;

export const commerceFxRelations = defineRelations(commerceFxDatabaseSchema);
