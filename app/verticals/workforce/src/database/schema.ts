import { tenantLegalEntityRlsPolicies } from '@app/core-runtime';
import { defineRelations, sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const workforceSchema = pgSchema('demo_workforce');

export const workforceStates = workforceSchema.table.withRLS(
  'workforce_states',
  {
    legalEntityId: uuid('legal_entity_id').notNull(),
    revision: integer('revision').default(0).notNull(),
    state: jsonb('state').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.legalEntityId] }),
    check('demo_workforce_revision_nonnegative', sql`${table.revision} >= 0`),
    check('demo_workforce_state_object', sql`jsonb_typeof(${table.state}) = 'object'`),
    ...tenantLegalEntityRlsPolicies('demo_workforce_state_scope', table.tenantId, table.legalEntityId),
  ],
);

export const gatewayAssertionRedemptions = workforceSchema.table(
  'gateway_assertion_redemptions',
  {
    audience: text('audience').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    issuer: text('issuer').notNull(),
    jti: text('jti').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.issuer, table.audience, table.jti] }),
    index('demo_workforce_redemption_expiry').on(table.expiresAt),
  ],
);

export const workforceRelations = defineRelations({ gatewayAssertionRedemptions, workforceStates });
