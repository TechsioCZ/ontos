import { encodeSymmySourceSelector } from '@app/symmy-integration/symmy-source-selector';
import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SymmyPriceListsReadQuerySchema } from '../../api/symmy/contract.ts';
import {
  mapSymmyPriceListsProjection,
  SymmyPriceListsResponseSchema,
} from '../../api/symmy/price-lists-public-contract.ts';
import { SymmyInternalPriceListsProjectionSchema } from '../../api/symmy/read-projection-contracts.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const groupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
} as const;
const qualifiedId = encodeSymmySourceSelector(
  {
    issuerId: 'issuer',
    routeId: '55555555-5555-4555-8555-555555555555',
    selectorKind: 'PRICE_GROUP',
    sourceNamespace: 'namespace',
    tenantId,
  },
  'CZ wholesale',
  groupRef.resourceId,
);
const baseList = {
  description: 'Wholesale prices',
  id: qualifiedId,
  name: 'CZ wholesale',
  priceGroupRef: groupRef,
  source_record_id: 'CZ wholesale',
  starts_at: '2026-01-01T00:00:00.000Z',
};
const emptyPrices = { count: 0, limit: 50, offset: 0, prices: [] };
type ListInput = typeof baseList & { readonly ends_at?: string; readonly prices?: typeof emptyPrices };
const decodeProjection = (list: ListInput, unsupported: readonly 'prices'[]) =>
  Schema.decodeUnknownSync(SymmyInternalPriceListsProjectionSchema)({
    contractVersion: 'INTERNAL_C14',
    count: 3,
    limit: 50,
    offset: 0,
    price_lists: [list],
    projection: 'price_lists',
    unsupported_fields: unsupported,
  });
const projection = (endsAt?: string) => {
  const withPrices = { ...baseList, prices: emptyPrices };
  return decodeProjection(endsAt === undefined ? withPrices : { ...withPrices, ends_at: endsAt }, []);
};
const projectionWithoutPrices = () => decodeProjection(baseList, ['prices']);
const decodeQuery = Schema.decodeUnknownResult(SymmyPriceListsReadQuerySchema);

describe('Symmy public price lists body', () => {
  it('maps the projection to camelCase with the price group ref and without markers or the qualified id', () => {
    const body = mapSymmyPriceListsProjection(projection());
    expect(body).toEqual({
      count: 3,
      limit: 50,
      offset: 0,
      priceLists: [
        {
          code: 'CZ wholesale',
          description: 'Wholesale prices',
          name: 'CZ wholesale',
          priceGroupRef: groupRef,
          prices: { count: 0, limit: 50, offset: 0, prices: [] },
          startsAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(Schema.is(Schema.toType(SymmyPriceListsResponseSchema))(body)).toBe(true);
    for (const forbidden of ['contractVersion', 'projection', 'unsupported_fields', 'unsupportedFields']) {
      expect(body).not.toHaveProperty(forbidden);
    }
    expect(body.priceLists[0]).not.toHaveProperty('id');
    expect(body.priceLists[0]).not.toHaveProperty('source_record_id');
    expect(body.priceLists[0]).not.toHaveProperty('endsAt');
  });

  it('adds endsAt only when the price list has an end', () => {
    const [list] = mapSymmyPriceListsProjection(projection('2026-12-31T00:00:00.000Z')).priceLists;
    expect(list).toHaveProperty('endsAt', '2026-12-31T00:00:00.000Z');
  });

  it('leaves prices absent when no price source is configured', () => {
    const [list] = mapSymmyPriceListsProjection(projectionWithoutPrices()).priceLists;
    expect(list).not.toHaveProperty('prices');
  });

  it('maps an empty page', () => {
    expect(
      mapSymmyPriceListsProjection({ ...projection(), count: 0, price_lists: [], unsupported_fields: ['prices'] }),
    ).toEqual({ count: 0, limit: 50, offset: 0, priceLists: [] });
  });
});

describe('Symmy price lists query', () => {
  for (const query of [{}, { limit: '1' }, { limit: '100', offset: '0' }, { priceLimit: '1', priceOffset: '0' }]) {
    it(`accepts ${JSON.stringify(query)}`, () => {
      expect(Result.isSuccess(decodeQuery(query))).toBe(true);
    });
  }
  for (const query of [
    { limit: '0' },
    { limit: '101' },
    { limit: 'abc' },
    { offset: '-1' },
    { priceLimit: '0' },
    { priceLimit: '101' },
    { priceOffset: '-1' },
  ]) {
    it(`rejects ${JSON.stringify(query)}`, () => {
      expect(Result.isFailure(decodeQuery(query))).toBe(true);
    });
  }
});
