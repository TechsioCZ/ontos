import { defineRelations } from 'drizzle-orm';
import { index, pgSchema, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

export const COMMUNICATIONS_SCHEMA_NAME = 'communications';
/**
 * The one Communications schema. Leaf lanes declare governed tables with `communicationsSchema.table.withRLS(...)`
 * and attach `tenantRlsPolicies` or `tenantLegalEntityRlsPolicies` from `@app/core-runtime`.
 */
export const communicationsSchema = pgSchema(COMMUNICATIONS_SCHEMA_NAME);

/** Pre-authentication ingress replay identity; never stores credentials or trusted business scope. */
export const gatewayAssertionRedemptions = communicationsSchema.table(
  'gateway_assertion_redemptions',
  {
    audience: text('audience').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    issuer: text('issuer').notNull(),
    jti: uuid('jti').notNull(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('communications_gateway_assertion_redemptions_identity_uk').on(table.issuer, table.audience, table.jti),
    index('communications_gateway_assertion_redemptions_expiry_idx').on(table.expiresAt),
  ],
);

/** Every owner table, so the verifier and the schema contract test reach each one through its typed reference. */
export const COMMUNICATIONS_TABLES = [gatewayAssertionRedemptions] as const;

export const COMMUNICATIONS_TABLE_INVENTORY = ['gateway_assertion_redemptions'] as const;

/** Relational Queries v2 entry point for this owner. */
export const communicationsRelations = defineRelations({ gatewayAssertionRedemptions });
