import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  mapSymmyGroupCustomersBatchRequest,
  SymmyGroupCustomersBatchRequestSchema,
} from '../../api/symmy/group-customers-batch-request-contract.ts';

type Body = typeof Schema.Json.Type;
const decode = Schema.decodeUnknownResult(SymmyGroupCustomersBatchRequestSchema, { onExcessProperty: 'error' });
const accepts = (body: Body) => Result.isSuccess(decode(body));
const tenantId = '11111111-1111-4111-8111-111111111111';
/** The profile reference GET /admin/customers returns for a customer. */
const retail = (resourceId: string) => ({
  kind: 'RETAIL',
  moduleId: 'commerce.customer-context',
  resourceId,
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
});
const counterparty = (resourceId: string) => ({
  kind: 'COUNTERPARTY',
  moduleId: 'commerce.customer-context',
  resourceId,
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
  tenantId,
});
const profileId = (index: number) => `abcdef${String(index).padStart(2, '0')}-6666-4666-8666-666666666666`;

describe('Symmy customers of a selected customer group', () => {
  it('accepts one to sixteen distinct profiles copied back from GET /admin/customers', () => {
    expect(accepts({ customers: [{ profileRef: retail(profileId(1)) }] })).toBe(true);
    expect(accepts({ customers: [{ profileRef: counterparty(profileId(1)) }] })).toBe(true);
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ profileRef: retail(profileId(index)) }));
    expect(accepts({ customers: many(16) })).toBe(true);
    expect(accepts({ customers: many(17) })).toBe(false);
    expect(accepts({ customers: [] })).toBe(false);
  });

  it('treats two spellings of one profile as one customer and refuses a reference that is not a UUID', () => {
    const lower = profileId(1);
    expect(accepts({ customers: [{ profileRef: retail(lower) }, { profileRef: retail(lower.toUpperCase()) }] })).toBe(
      false,
    );
    expect(accepts({ customers: [{ profileRef: retail('customer-1') }] })).toBe(false);
    expect(accepts({ customers: [{ profileRef: { ...retail(profileId(1)), kind: 'COUNTERPARTY' } }] })).toBe(false);
  });

  it('is assignment only: no removal, replacement set, group, order, time, plan or fixture', () => {
    const customer = { profileRef: retail(profileId(1)) };
    for (const extra of [
      { operation: 'REMOVE' },
      { groupRef: {} },
      { order: 1 },
      { effectiveAt: '2026-01-01T00:00:00.000Z' },
    ]) {
      expect(accepts({ customers: [{ ...customer, ...extra }] }), JSON.stringify(extra)).toBe(false);
    }
    expect(accepts({ complete: true, customers: [customer] })).toBe(false);
    expect(accepts({ customers: [{ customerId: 'customer-1' }] })).toBe(false);
    expect(accepts({ contractVersion: 'INTERNAL_C14', plan: { items: [] } })).toBe(false);
    expect(accepts({ fixtureId: 'internal-c14-fixture' })).toBe(false);
  });

  it('hands the owner admission the profile kind beside the exact profile reference, in request order', () => {
    const body = Schema.decodeUnknownSync(SymmyGroupCustomersBatchRequestSchema)({
      customers: [{ profileRef: counterparty(profileId(2)) }, { profileRef: retail(profileId(1)) }],
    });
    const { kind: _counterpartyKind, ...counterpartyRef } = counterparty(profileId(2));
    const { kind: _retailKind, ...retailRef } = retail(profileId(1));
    expect(mapSymmyGroupCustomersBatchRequest(body)).toEqual([
      { profile: { profileKind: 'COUNTERPARTY', profileRef: counterpartyRef } },
      { profile: { profileKind: 'RETAIL', profileRef: retailRef } },
    ]);
  });
});
