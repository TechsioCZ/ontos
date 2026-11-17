import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  mapSymmyStockBatchRequest,
  SymmyStockBatchResponseSchema,
} from '../../api/symmy/stock-batch-public-contract.ts';
import { SymmyStockBatchRequestSchema } from '../../api/symmy/stock-batch-request-contract.ts';

const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product-unit',
  tenantId: '11111111-1111-4111-8111-111111111111',
};
const row = (itemKey: string, businessObservedAt: string) => ({
  businessObservedAt,
  itemKey,
  locationKey: 'warehouse-1',
  quantity: { amount: '12.5', unitRef },
  revision: 'r1',
  sourceReference: `erp-${itemKey}`,
});

describe('Symmy stock batch public mapping', () => {
  it('hands the rows to the owner admission in request order with canonical instants and nothing else', () => {
    const body = Schema.decodeUnknownSync(SymmyStockBatchRequestSchema)({
      stock: [row('item-2', '2026-01-01T10:00:00Z'), row('item-1', '2026-01-01T12:00:00+02:00')],
    });
    const rows = mapSymmyStockBatchRequest(body);
    expect(rows.map(({ itemKey }) => itemKey)).toEqual(['item-2', 'item-1']);
    expect(rows.map(({ businessObservedAt }) => businessObservedAt)).toEqual([
      '2026-01-01T10:00:00.000Z',
      '2026-01-01T10:00:00.000Z',
    ]);
    expect(Object.keys(rows[0] ?? {}).toSorted()).toEqual([
      'businessObservedAt',
      'itemKey',
      'locationKey',
      'quantity',
      'revision',
      'sourceReference',
    ]);
  });

  it('is the same for the same content however the instant is written', () => {
    const decode = Schema.decodeUnknownSync(SymmyStockBatchRequestSchema);
    expect(mapSymmyStockBatchRequest(decode({ stock: [row('a', '2026-01-01T10:00:00Z')] }))).toEqual(
      mapSymmyStockBatchRequest(decode({ stock: [row('a', '2026-01-01T10:00:00.000Z')] })),
    );
  });
});

describe('Symmy stock batch response', () => {
  const item = {
    effects: [
      { effectId: '20000000-0000-4000-8000-000000000001', owner: 'commerce.inventory', status: 'accepted_change' },
    ],
    itemId: '30000000-0000-4000-8000-000000000001',
    itemKey: 'item-1',
    locationKey: 'warehouse-1',
    outcome: 'accepted',
  };
  const decode = Schema.decodeUnknownResult(SymmyStockBatchResponseSchema, { onExcessProperty: 'error' });

  it('requires the keys of the submitted row on every item', () => {
    expect(Result.isSuccess(decode({ items: [item] }))).toBe(true);
    const { itemKey: _item, ...withoutItemKey } = item;
    const { locationKey: _location, ...withoutLocationKey } = item;
    expect(Result.isFailure(decode({ items: [withoutItemKey] }))).toBe(true);
    expect(Result.isFailure(decode({ items: [withoutLocationKey] }))).toBe(true);
    expect(Result.isFailure(decode({ items: [] }))).toBe(true);
  });

  it('carries no contract version', () => {
    expect(Result.isFailure(decode({ items: [{ ...item, contractVersion: 'INTERNAL_C14' }] }))).toBe(true);
  });
});
