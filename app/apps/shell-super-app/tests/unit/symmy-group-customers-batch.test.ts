import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  SymmyGroupCustomersBatchPayloadSchema,
  SymmyGroupCustomersBatchRequestSchema,
} from '../../api/symmy/group-customers-batch-request-contract.ts';

type Body = typeof Schema.Json.Type;
const decode = Schema.decodeUnknownResult(SymmyGroupCustomersBatchRequestSchema, { onExcessProperty: 'error' });
const accepts = (body: Body) => Result.isSuccess(decode(body));
const many = (count: number) => Array.from({ length: count }, (_, index) => ({ customerId: `AKROS-${index}` }));

describe('Symmy customers of a selected customer group', () => {
  it('accepts one to sixteen customers, each named by the ERP customer id it sent to POST /customers/batch', () => {
    expect(accepts({ customers: [{ customerId: 'AKROS-0001' }] })).toBe(true);
    expect(accepts({ customers: [{ customerId: 'Zákazník Žluťoučký / 42' }] })).toBe(true);
    expect(accepts({ customers: many(16) })).toBe(true);
    expect(accepts({ customers: many(17) })).toBe(false);
    expect(accepts({ customers: [] })).toBe(false);
    expect(accepts({})).toBe(false);
  });

  it('names each customer once and refuses an empty or over-long customer id', () => {
    expect(accepts({ customers: [{ customerId: 'AKROS-1' }, { customerId: 'AKROS-1' }] })).toBe(false);
    expect(accepts({ customers: [{ customerId: '' }] })).toBe(false);
    expect(accepts({ customers: [{ customerId: 'x'.repeat(301) }] })).toBe(false);
    expect(accepts({ customers: [{ customerId: 42 }] })).toBe(false);
  });

  it('is assignment only: no removal, profile reference, group, order, time, plan or fixture', () => {
    const customer = { customerId: 'AKROS-1' };
    for (const extra of [
      { operation: 'REMOVE' },
      { profileRef: { kind: 'RETAIL' } },
      { groupRef: {} },
      { order: 1 },
      { effectiveAt: '2026-01-01T00:00:00.000Z' },
    ]) {
      expect(accepts({ customers: [{ ...customer, ...extra }] }), JSON.stringify(extra)).toBe(false);
    }
    expect(accepts({ complete: true, customers: [customer] })).toBe(false);
    expect(accepts({ contractVersion: 'INTERNAL_C14', plan: { items: [] } })).toBe(false);
    expect(accepts({ fixtureId: 'internal-c14-fixture' })).toBe(false);
  });

  it('keeps the request order the job items answer in', () => {
    const body = Schema.decodeUnknownSync(SymmyGroupCustomersBatchRequestSchema)({
      customers: [{ customerId: 'AKROS-2' }, { customerId: 'AKROS-1' }],
    });
    expect(body.customers.map(({ customerId }) => customerId)).toEqual(['AKROS-2', 'AKROS-1']);
  });

  it('lets the route carry an internal fixture or plan beside the public body, never both in one body', () => {
    const route = Schema.decodeUnknownResult(SymmyGroupCustomersBatchPayloadSchema, { onExcessProperty: 'error' });
    expect(Result.isSuccess(route({ customers: [{ customerId: 'AKROS-1' }] }))).toBe(true);
    expect(Result.isSuccess(route({ fixtureId: 'internal-c14-fixture' }))).toBe(true);
    expect(Result.isSuccess(route({ customers: [{ customerId: 'AKROS-1' }], fixtureId: 'internal-c14-fixture' }))).toBe(
      false,
    );
  });
});
