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

  it('declares the replay ledger and the four template tables, and no table of a later lane', () => {
    expect(COMMUNICATIONS_TABLE_INVENTORY).toEqual([
      'gateway_assertion_redemptions',
      'template_types',
      'template_revisions',
      'template_activations',
      'template_revision_invalidations',
    ]);
  });

  it('enforces Tenant RLS on every template table, one open activation per Type and the Type identity', () => {
    const template = Object.fromEntries(configs.map((config) => [config.name, config]));
    for (const name of [
      'template_types',
      'template_revisions',
      'template_activations',
      'template_revision_invalidations',
    ]) {
      expect(template[name]?.enableRLS).toBe(true);
      expect(template[name]?.policies).toHaveLength(4);
      expect(template[name]?.columns.some((column) => column.name === 'tenant_id' && column.notNull)).toBe(true);
    }
    expect(template['template_types']?.uniqueConstraints.map((constraint) => constraint.getName())).toContain(
      'communications_template_types_identity_uk',
    );
    expect(template['template_revisions']?.uniqueConstraints.map((constraint) => constraint.getName())).toContain(
      'communications_template_revisions_number_uk',
    );
    const open = template['template_activations']?.indexes.find(
      (index) => index.config.name === 'communications_template_activations_open_uk',
    );
    expect(open?.config.unique).toBe(true);
    expect(open?.config.where).toBeDefined();
  });

  it('keeps the replay ledger a Tenant-free table with one replay identity and an expiry index', () => {
    const redemptions = configs.find((config) => config.name === 'gateway_assertion_redemptions');

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
