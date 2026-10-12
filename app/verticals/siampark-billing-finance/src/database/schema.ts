import type { FinanceStateSchema } from '../../shared/apis/records.ts';
import { tenantLegalEntityRlsPolicies } from '@app/core-runtime';
import { defineRelations, sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const financeSchema = pgSchema('siampark_billing_finance');
export const financeStates = financeSchema.table.withRLS(
  'finance_states',
  {
    legalEntityId: uuid('legal_entity_id').notNull(),
    revision: integer('revision').default(0).notNull(),
    state: jsonb('state').$type<typeof FinanceStateSchema.Encoded>().notNull(),
    tenantId: uuid('tenant_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.legalEntityId] }),
    check('siampark_finance_revision_nonnegative', sql`${table.revision} >= 0`),
    check('siampark_finance_state_object', sql`jsonb_typeof(${table.state}) = 'object'`),
    ...tenantLegalEntityRlsPolicies('siampark_finance_scope', table.tenantId, table.legalEntityId),
  ],
);
export const gatewayAssertionRedemptions = financeSchema.table(
  'gateway_assertion_redemptions',
  {
    audience: text('audience').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    issuer: text('issuer').notNull(),
    jti: text('jti').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.issuer, table.audience, table.jti] }),
    index('siampark_finance_redemption_expiry').on(table.expiresAt),
  ],
);
export const financeRelations = defineRelations({ financeStates, gatewayAssertionRedemptions });
