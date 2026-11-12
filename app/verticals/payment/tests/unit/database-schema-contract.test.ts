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
      (candidate) =>
        ![
          'gateway_assertion_redemptions',
          'refund_item_claims',
          'psp_provider_dispatches',
          'psp_provider_evidence',
        ].includes(candidate.name),
    )) {
      expect(config.columns.map((column) => column.name)).toEqual(
        expect.arrayContaining(['action_invocation_id', 'actor_principal_id', 'composition_revision']),
      );
    }
  });
});

const workerOriginColumns = [
  'origin_action_invocation_id',
  'origin_composition_revision',
  'worker_key',
  'delivery_id',
  'recorded_at',
];

describe('#1155/#1157/#1158 Gateway adapter database schema contract', () => {
  it('#1158 worker-written rows reference the admitting invocation and never name a human actor', () => {
    for (const name of ['psp_provider_dispatches', 'psp_provider_evidence']) {
      const columns = byName.get(name)?.columns.map((column) => column.name) ?? [];
      expect(columns).toEqual(expect.arrayContaining(workerOriginColumns));
      expect(columns).not.toContain('actor_principal_id');
      expect(columns).not.toContain('action_invocation_id');
    }
  });

  it('#1157 a captured notification keeps the capture provenance next to its processing columns', () => {
    expect(byName.get('psp_provider_notifications')?.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'action_invocation_id',
        'actor_principal_id',
        'composition_revision',
        'state',
        'correlated_operation_id',
        'processed_delivery_id',
        'processed_at',
      ]),
    );
  });

  it('#1158 one dispatch per Payment Operation, per order reference and per return token', () => {
    const dispatches = byName.get('psp_provider_dispatches');
    const uniqueColumns = (name: string) =>
      dispatches?.uniqueConstraints
        .find((constraint) => constraint.getName() === name)
        ?.columns.map((column) => column.name);

    expect(uniqueColumns('payment_psp_dispatches_operation_uk')).toEqual([
      'tenant_id',
      'legal_entity_id',
      'operation_id',
    ]);
    expect(uniqueColumns('payment_psp_dispatches_order_reference_uk')).toEqual([
      'tenant_id',
      'legal_entity_id',
      'binding_id',
      'order_reference',
    ]);
    const returnToken = dispatches?.indexes.find(
      (index) => index.config.name === 'payment_psp_dispatches_return_token_uk',
    );
    expect(returnToken?.config.unique).toBe(true);
    expect(returnToken?.config.where).toBeDefined();
  });

  it('#1155 one Current binding per family and environment, one active credential per binding', () => {
    for (const [table, index] of [
      ['psp_provider_account_bindings', 'payment_psp_bindings_current_uk'],
      ['psp_credential_revisions', 'payment_psp_credentials_active_uk'],
    ] as const) {
      const partial = byName.get(table)?.indexes.find((candidate) => candidate.config.name === index);
      expect(partial?.config.unique).toBe(true);
      expect(partial?.config.where).toBeDefined();
    }
  });

  it('#1157 notification delivery identity is unique per binding', () => {
    expect(
      byName
        .get('psp_provider_notifications')
        ?.uniqueConstraints.find((constraint) => constraint.getName() === 'payment_psp_notifications_delivery_uk')
        ?.columns.map((column) => column.name),
    ).toEqual(['tenant_id', 'legal_entity_id', 'binding_id', 'delivery_identity']);
  });
});
