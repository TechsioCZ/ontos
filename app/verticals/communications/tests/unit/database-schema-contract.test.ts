import { getTableConfig } from 'drizzle-orm/pg-core';
import { Array as EffectArray, Order } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  COMMUNICATIONS_SCHEMA_NAME,
  COMMUNICATIONS_TABLE_INVENTORY,
  COMMUNICATIONS_TABLES,
} from '../../src/database/schema.ts';

const configs = COMMUNICATIONS_TABLES.map((table) => getTableConfig(table));

describe('Communications database schema contract', () => {
  it('owns exactly the inventoried tables in the communications schema', () => {
    expect(
      EffectArray.sort(
        configs.map((config) => config.name),
        Order.String,
      ),
    ).toEqual(EffectArray.sort(COMMUNICATIONS_TABLE_INVENTORY, Order.String));
    expect(configs.every((config) => config.schema === COMMUNICATIONS_SCHEMA_NAME)).toBe(true);
  });

  it('declares no domain table before a leaf lane adds one', () => {
    expect(COMMUNICATIONS_TABLE_INVENTORY).toEqual(['gateway_assertion_redemptions']);
  });

  it('keeps the replay ledger a Tenant-free table with one replay identity and an expiry index', () => {
    const [redemptions] = configs;

    expect(redemptions?.enableRLS).toBe(false);
    expect(redemptions?.columns.map((column) => column.name)).toEqual([
      'audience',
      'expires_at',
      'issuer',
      'jti',
      'redeemed_at',
    ]);
    expect(redemptions?.uniqueConstraints.map((constraint) => constraint.getName())).toEqual([
      'communications_gateway_assertion_redemptions_identity_uk',
    ]);
    expect(redemptions?.indexes.map((index) => index.config.name)).toEqual([
      'communications_gateway_assertion_redemptions_expiry_idx',
    ]);
  });
});
