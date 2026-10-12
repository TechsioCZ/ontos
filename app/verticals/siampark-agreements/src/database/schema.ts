import { tenantLegalEntityRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import type { AgreementsState } from '../../shared/apis/records.ts';

export const agreementsSchema = pgSchema('siampark_agreements');

export const agreementsState = agreementsSchema.table.withRLS(
  'state',
  {
    legalEntityId: uuid('legal_entity_id').notNull(),
    revision: integer('revision').notNull().default(0),
    snapshot: jsonb('snapshot').$type<AgreementsState>().notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.legalEntityId] }),
    check('agreements_state_revision_ck', sql`${table.revision} >= 0`),
    ...tenantLegalEntityRlsPolicies('agreements_state_scope', table.tenantId, table.legalEntityId),
  ],
);

// Technical single-use authentication replay evidence, not a business handler data surface.
export const gatewayAssertionRedemptions = agreementsSchema.table(
  'gateway_assertion_redemptions',
  {
    audience: text('audience').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    issuer: text('issuer').notNull(),
    jti: uuid('jti').notNull(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('siampark_agreements_assertion_identity_uk').on(table.issuer, table.audience, table.jti),
    index('siampark_agreements_assertion_expiry_idx').on(table.expiresAt),
  ],
);
