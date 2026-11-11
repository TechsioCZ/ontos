import { describe, expect, it } from 'effect-rstest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Array as EffectArray, Order } from 'effect';

import { PAYMENT_SCHEMA_NAME, PAYMENT_TABLE_INVENTORY, PAYMENT_TABLES } from '../../src/database/schema.ts';

const configs = PAYMENT_TABLES.map((table) => getTableConfig(table));
const byName = new Map(configs.map((config) => [config.name, config]));

describe('#1148 Payment database schema contract', () => {
  it('owns exactly the inventoried tables in the payment schema', () => {
    expect(
      EffectArray.sort(
        configs.map((config) => config.name),
        Order.String,
      ),
    ).toEqual(EffectArray.sort(PAYMENT_TABLE_INVENTORY, Order.String));
    expect(configs.every((config) => config.schema === PAYMENT_SCHEMA_NAME)).toBe(true);
  });

  it('scopes every business table by Tenant and Selling Legal Entity with four RLS policies', () => {
    for (const config of configs.filter((candidate) => candidate.name !== 'gateway_assertion_redemptions')) {
      expect(config.enableRLS).toBe(true);
      expect(config.policies).toHaveLength(4);
      expect(config.columns.map((column) => column.name)).toEqual(
        expect.arrayContaining(['tenant_id', 'legal_entity_id']),
      );
    }
    expect(byName.get('gateway_assertion_redemptions')?.enableRLS).toBe(false);
  });

  it('#1148 backs the one-collection-lineage invariant with a partial unique index', () => {
    const lineage = byName
      .get('payment_operations')
      ?.indexes.find((index) => index.config.name === 'payment_operations_one_collect_lineage_uk');

    expect(lineage?.config.unique).toBe(true);
    expect(lineage?.config.where).toBeDefined();
    expect(lineage?.config.columns.map((column) => ('name' in column ? column.name : undefined))).toEqual([
      'tenant_id',
      'legal_entity_id',
      'payment_id',
    ]);
  });

  it('#1150 backs item reservations with a partial unique index on active claims', () => {
    const claims = byName
      .get('refund_item_claims')
      ?.indexes.find((index) => index.config.name === 'payment_refund_item_claims_active_item_uk');

    expect(claims?.config.unique).toBe(true);
    expect(claims?.config.where).toBeDefined();
  });

  it('records truthful execution provenance on every governed row', () => {
    for (const config of configs.filter(
      (candidate) => !['gateway_assertion_redemptions', 'refund_item_claims'].includes(candidate.name),
    )) {
      expect(config.columns.map((column) => column.name)).toEqual(
        expect.arrayContaining(['action_invocation_id', 'actor_principal_id', 'composition_revision']),
      );
    }
  });
});
