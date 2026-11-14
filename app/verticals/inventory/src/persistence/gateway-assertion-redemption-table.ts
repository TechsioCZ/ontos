import { sql } from 'drizzle-orm';
import { check, index, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { inventorySchema } from '../database/inventory-schema.ts';

/** Pre-Tenant replay evidence contains no Bearer, Principal or business payload. */
export const inventoryGatewayAssertionRedemptions = inventorySchema.table(
  'gateway_assertion_redemptions',
  {
    audience: text('audience').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    issuer: text('issuer').notNull(),
    jti: uuid('jti').notNull(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('inventory_gateway_redemptions_identity_uk').on(table.issuer, table.audience, table.jti),
    index('inventory_gateway_redemptions_expiry_idx').on(table.expiresAt),
    check('inventory_gateway_redemptions_audience_ck', sql`${table.audience} = 'inventory'`),
  ],
);
