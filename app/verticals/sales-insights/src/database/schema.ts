import { tenantLegalEntityRlsPolicies } from '@app/core-runtime';
import { defineRelations, sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const salesInsightsSchema = pgSchema('demo_sales_insights');

export const salesInsightsStates = salesInsightsSchema.table.withRLS(
  'sales_insights_states',
  {
    legalEntityId: uuid('legal_entity_id').notNull(),
    revision: integer('revision').default(0).notNull(),
    state: jsonb('state').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.legalEntityId] }),
    check('demo_sales_insights_revision_nonnegative', sql`${table.revision} >= 0`),
    check('demo_sales_insights_state_object', sql`jsonb_typeof(${table.state}) = 'object'`),
    ...tenantLegalEntityRlsPolicies('demo_sales_insights_state_scope', table.tenantId, table.legalEntityId),
  ],
);

export const gatewayAssertionRedemptions = salesInsightsSchema.table(
  'gateway_assertion_redemptions',
  {
    audience: text('audience').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    issuer: text('issuer').notNull(),
    jti: text('jti').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.issuer, table.audience, table.jti] }),
    index('demo_sales_insights_redemption_expiry').on(table.expiresAt),
  ],
);

export const salesInsightsRelations = defineRelations({ gatewayAssertionRedemptions, salesInsightsStates });
