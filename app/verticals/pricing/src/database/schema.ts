/* oxlint-disable perfectionist/sort-objects -- Drizzle declaration order is the physical database contract; expires: 2027-03-31. */
import { tenantLegalEntityRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgSchema, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

export const PRICING_SCHEMA_NAME = 'pricing';
export const PRICING_TABLE_INVENTORY = ['currency_support_revisions'] as const;
export const pricingSchema = pgSchema(PRICING_SCHEMA_NAME);

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
    ...tenantLegalEntityRlsPolicies('pricing_currency_support_scope', table.tenantId, table.legalEntityId),
  ],
);
