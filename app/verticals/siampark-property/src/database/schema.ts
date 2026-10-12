import { tenantLegalEntityRlsPolicies } from '@app/core-runtime';
import { defineRelations, sql } from 'drizzle-orm';
import { check, integer, jsonb, pgSchema, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import type { PropertyState } from '../../shared/apis/records.ts';

export const propertySchema = pgSchema('siampark_property');
export const gatewayAssertionRedemptions = propertySchema.table(
  'gateway_assertion_redemptions',
  {
    audience: text('audience').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    issuer: text('issuer').notNull(),
    jti: uuid('jti').notNull(),
  },
  (table) => [primaryKey({ columns: [table.issuer, table.audience, table.jti] })],
);

// One owner aggregate serializes the small presentation dataset. The revision is a
// transaction-safe fence for updates; references remain public ResourceRefs in the payload.
export const propertyState = propertySchema.table.withRLS(
  'state',
  {
    legalEntityId: uuid('legal_entity_id').notNull(),
    payload: jsonb('payload').$type<PropertyState>().notNull(),
    revision: integer('revision').default(0).notNull(),
    tenantId: uuid('tenant_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.legalEntityId] }),
    check('property_revision_nonnegative', sql`${table.revision} >= 0`),
    ...tenantLegalEntityRlsPolicies('property_state', table.tenantId, table.legalEntityId),
  ],
);

export const propertyRelations = defineRelations({ gatewayAssertionRedemptions, propertyState });
