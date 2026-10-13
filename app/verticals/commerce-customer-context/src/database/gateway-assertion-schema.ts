import { defineRelations } from 'drizzle-orm';
import { index, pgSchema, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Replay evidence for Shell-issued gateway assertions, kept in its own schema. The owner schema
 * `commerce_customer_context` grants the runtime role routines only, while one-time assertion
 * redemption is security infrastructure that runs before any business scope exists and needs a
 * plain atomic insert keyed by (issuer, audience, jti).
 */
export const COMMERCE_CUSTOMER_CONTEXT_GATEWAY_SCHEMA_NAME = 'commerce_customer_context_gateway';

export const commerceCustomerContextGatewaySchema = pgSchema(COMMERCE_CUSTOMER_CONTEXT_GATEWAY_SCHEMA_NAME);

export const gatewayAssertionRedemptions = commerceCustomerContextGatewaySchema.table(
  'gateway_assertion_redemptions',
  {
    audience: text('audience').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    issuer: text('issuer').notNull(),
    jti: text('jti').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.issuer, table.audience, table.jti] }),
    index('ccc_gateway_redemption_expiry').on(table.expiresAt),
  ],
);

export const gatewayAssertionRedemptionRelations = defineRelations({ gatewayAssertionRedemptions });
