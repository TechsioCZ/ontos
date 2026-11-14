import { tenantLegalEntityRlsPolicies } from '@app/core-runtime';
import { defineRelations, sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const taggingSchema = pgSchema('demo_tagging');

export const taggingStates = taggingSchema.table.withRLS(
  'tagging_states',
  {
    legalEntityId: uuid('legal_entity_id').notNull(),
    revision: integer('revision').default(0).notNull(),
    state: jsonb('state').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.legalEntityId] }),
    check('demo_tagging_revision_nonnegative', sql`${table.revision} >= 0`),
    check('demo_tagging_state_object', sql`jsonb_typeof(${table.state}) = 'object'`),
    ...tenantLegalEntityRlsPolicies('demo_tagging_state_scope', table.tenantId, table.legalEntityId),
  ],
);

export const gatewayAssertionRedemptions = taggingSchema.table(
  'gateway_assertion_redemptions',
  {
    audience: text('audience').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    issuer: text('issuer').notNull(),
    jti: text('jti').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.issuer, table.audience, table.jti] }),
    index('demo_tagging_redemption_expiry').on(table.expiresAt),
  ],
);

export const taggingRelations = defineRelations({ gatewayAssertionRedemptions, taggingStates });
