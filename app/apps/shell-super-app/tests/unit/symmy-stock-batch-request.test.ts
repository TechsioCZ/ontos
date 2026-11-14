import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SymmyStockBatchRequestSchema } from '../../api/symmy/stock-batch-request-contract.ts';

const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product-unit',
  tenantId: '11111111-1111-4111-8111-111111111111',
};
const row = {
  businessObservedAt: '2026-01-01T10:00:00.000Z',
  itemKey: 'item-1',
  locationKey: 'warehouse-1',
  quantity: { amount: '12.5', unitRef },
  revision: 'r1',
  sourceReference: 'erp-1',
};
// The HTTP layer decodes with excess properties rejected; the schema must hold under the same options.
type Body = typeof Schema.Json.Type;
const decode = (body: Body) =>
  Schema.decodeUnknownResult(SymmyStockBatchRequestSchema, { onExcessProperty: 'error' })(body);
const accepts = (body: Body) => Result.isSuccess(decode(body));

describe('Symmy stock batch request', () => {
  it('accepts one to sixteen rows', () => {
    expect(accepts({ stock: [row] })).toBe(true);
    expect(accepts({ stock: Array.from({ length: 16 }, () => row) })).toBe(true);
  });

  it('accepts canonical amounts', () => {
    for (const amount of ['0', '1', '12.5', '0.000000001', `${'9'.repeat(29)}.123456789`]) {
      expect(accepts({ stock: [{ ...row, quantity: { amount, unitRef } }] }), amount).toBe(true);
    }
  });

  it('rejects a missing, empty, oversized or wrongly typed stock list', () => {
    expect(accepts({})).toBe(false);
    expect(accepts({ stock: [] })).toBe(false);
    expect(accepts({ stock: Array.from({ length: 17 }, () => row) })).toBe(false);
    expect(accepts({ stock: row })).toBe(false);
    expect(accepts({ stock: null })).toBe(false);
  });

  it('rejects a row without any required field', () => {
    for (const key of Object.keys(row)) {
      const rest = Object.fromEntries(Object.entries(row).filter(([name]) => name !== key));
      expect(accepts({ stock: [rest] }), key).toBe(false);
    }
    expect(accepts({ stock: [{ ...row, quantity: { unitRef } }] })).toBe(false);
    expect(accepts({ stock: [{ ...row, quantity: { amount: '1' } }] })).toBe(false);
  });

  it('rejects null in any field', () => {
    for (const key of Object.keys(row)) {
      expect(accepts({ stock: [{ ...row, [key]: null }] }), key).toBe(false);
    }
    expect(accepts({ stock: [{ ...row, quantity: { amount: null, unitRef } }] })).toBe(false);
    expect(accepts({ stock: [{ ...row, quantity: { amount: '1', unitRef: null } }] })).toBe(false);
  });

  it('rejects a non-canonical or numeric amount', () => {
    for (const amount of [
      '12.50',
      '012',
      '-1',
      '+1',
      '1e3',
      '1.',
      '.5',
      '',
      ' 1',
      '1.0',
      '9'.repeat(30),
      '0.1234567891',
    ]) {
      expect(accepts({ stock: [{ ...row, quantity: { amount, unitRef } }] }), amount).toBe(false);
    }
    expect(accepts({ stock: [{ ...row, quantity: { amount: 12.5, unitRef } }] })).toBe(false);
  });

  it('rejects text outside 1 to 300 characters or untrimmed', () => {
    for (const key of ['itemKey', 'locationKey', 'revision', 'sourceReference']) {
      expect(accepts({ stock: [{ ...row, [key]: '' }] }), key).toBe(false);
      expect(accepts({ stock: [{ ...row, [key]: 'a'.repeat(301) }] }), key).toBe(false);
      expect(accepts({ stock: [{ ...row, [key]: 'a'.repeat(300) }] }), key).toBe(true);
      expect(accepts({ stock: [{ ...row, [key]: ' a ' }] }), key).toBe(false);
    }
  });

  it('accepts ISO datetimes and normalizes them to UTC', () => {
    for (const businessObservedAt of [
      '2026-01-01T10:00:00Z',
      '2026-01-01T10:00:00.5Z',
      '2026-01-01T10:00:00.123456789Z',
      '2026-01-01T12:00:00+02:00',
    ]) {
      expect(accepts({ stock: [{ ...row, businessObservedAt }] }), businessObservedAt).toBe(true);
    }
    const decoded = Schema.decodeUnknownSync(SymmyStockBatchRequestSchema)({
      stock: [{ ...row, businessObservedAt: '2026-01-01T12:00:00+02:00' }],
    });
    expect(decoded.stock[0].businessObservedAt.epochMilliseconds).toBe(Date.parse('2026-01-01T10:00:00Z'));
  });

  it('rejects a time that is not a datetime', () => {
    for (const businessObservedAt of ['yesterday', 'now', '', 1_767_262_800_000, null]) {
      expect(accepts({ stock: [{ ...row, businessObservedAt }] }), String(businessObservedAt)).toBe(false);
    }
  });

  it('rejects a unit reference of another resource type', () => {
    expect(
      accepts({ stock: [{ ...row, quantity: { amount: '1', unitRef: { ...unitRef, resourceType: 'x' } } }] }),
    ).toBe(false);
    expect(accepts({ stock: [{ ...row, quantity: { amount: '1', unitRef: 'unit-1' } }] })).toBe(false);
  });

  it('rejects reserved quantity, the contract version, selectors and unknown properties', () => {
    for (const extra of [
      { reservedQuantity: { amount: '1', unitRef } },
      { contractVersion: 'INTERNAL_C14' },
      { sku: 'a' },
      { ean: 'a' },
      { variantId: 'a' },
      { inventoryItemId: 'a' },
      { unknown: true },
    ]) {
      expect(accepts({ stock: [{ ...row, ...extra }] }), JSON.stringify(extra)).toBe(false);
    }
    expect(accepts({ contractVersion: 'INTERNAL_C14', stock: [row] })).toBe(false);
    expect(accepts({ fixtureId: 'x', stock: [row] })).toBe(false);
    expect(accepts({ stock: [row], unknown: 1 })).toBe(false);
  });
});
