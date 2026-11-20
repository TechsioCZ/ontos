import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SymmyCustomerGroupsBatchResponseSchema } from '../../api/symmy/customer-groups-batch-public-contract.ts';
import { SymmyCustomerGroupsBatchRequestSchema } from '../../api/symmy/customer-groups-batch-request-contract.ts';

type Body = typeof Schema.Json.Type;
// The HTTP layer decodes with excess properties rejected; the schema must hold under the same options.
const accepts = (body: Body) =>
  Result.isSuccess(
    Schema.decodeUnknownResult(SymmyCustomerGroupsBatchRequestSchema, { onExcessProperty: 'error' })(body),
  );
const group = (code: string) => ({
  businessCode: 'WHOLESALE_BUYERS',
  code,
  description: 'Customers the source classifies as wholesale buyers',
  meaningKey: 'symmy.wholesale-buyers',
  membershipCriteria: 'The source explicitly assigns each wholesale buyer',
  name: 'Wholesale buyers',
  purpose: 'Wholesale buyer classification',
});

describe('Symmy customer groups batch request', () => {
  it('accepts one to sixteen groups, each with a distinct stable code', () => {
    expect(accepts({ customerGroups: [group('symmy-wholesale')] })).toBe(true);
    expect(accepts({ customerGroups: Array.from({ length: 16 }, (_, index) => group(`g-${index}`)) })).toBe(true);
    expect(accepts({ customerGroups: [] })).toBe(false);
    expect(accepts({ customerGroups: Array.from({ length: 17 }, (_, index) => group(`g-${index}`)) })).toBe(false);
    expect(accepts({ customerGroups: [group('same'), group('same')] })).toBe(false);
  });

  it('requires the meaning the source states and never derives it from the name', () => {
    for (const field of Object.keys(group('g'))) {
      const partial = Object.fromEntries(Object.entries(group('g')).filter(([name]) => name !== field));
      expect(accepts({ customerGroups: [partial] }), field).toBe(false);
    }
    expect(accepts({ customerGroups: [{ code: 'g', identifier_type: 'name', name: 'Wholesale buyers' }] })).toBe(false);
  });

  it('refuses what the owner cannot store: a lower-case business code, an invalid meaning key, a padded code', () => {
    expect(accepts({ customerGroups: [{ ...group('g'), businessCode: 'wholesale' }] })).toBe(false);
    expect(accepts({ customerGroups: [{ ...group('g'), meaningKey: 'Wholesale Buyers' }] })).toBe(false);
    expect(accepts({ customerGroups: [{ ...group('g'), code: ' g' }] })).toBe(false);
    expect(accepts({ customerGroups: [{ ...group('g'), code: '' }] })).toBe(false);
    expect(accepts({ customerGroups: [{ ...group('g'), name: '   ' }] })).toBe(false);
  });

  it('refuses prices, discounts, memberships, plans and fixtures: a group assigns nothing', () => {
    for (const extra of [
      { priceListCode: 'wholesale' },
      { discount: '10' },
      { customers: [] },
      { metadata: {} },
      { source: { issuer: 'forged' } },
    ]) {
      expect(accepts({ customerGroups: [{ ...group('g'), ...extra }] }), JSON.stringify(extra)).toBe(false);
    }
    expect(accepts({ contractVersion: 'INTERNAL_C14', plan: { items: [] } })).toBe(false);
    expect(accepts({ fixtureId: 'internal-c14-fixture' })).toBe(false);
    expect(accepts({ customerGroups: [group('g')], fixtureId: 'internal-c14-fixture' })).toBe(false);
  });
});

describe('Symmy customer groups batch response', () => {
  const item = {
    code: 'symmy-wholesale',
    effects: [
      {
        effectId: '20000000-0000-4000-8000-000000000001',
        owner: 'commerce.customer-context',
        status: 'accepted_change',
      },
    ],
    itemId: '30000000-0000-4000-8000-000000000001',
    outcome: 'accepted',
  };
  const decode = Schema.decodeUnknownResult(SymmyCustomerGroupsBatchResponseSchema, { onExcessProperty: 'error' });

  it('names the submitted group on every result and carries no contract version', () => {
    expect(Result.isSuccess(decode({ items: [item] }))).toBe(true);
    const { code: _code, ...withoutCode } = item;
    expect(Result.isFailure(decode({ items: [withoutCode] }))).toBe(true);
    expect(Result.isFailure(decode({ items: [] }))).toBe(true);
    expect(Result.isFailure(decode({ items: [{ ...item, contractVersion: 'INTERNAL_C14' }] }))).toBe(true);
  });
});
