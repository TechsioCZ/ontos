import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SymmyRegionsReadQuerySchema } from '../../api/symmy/contract.ts';
import {
  mapSymmyRegionsProjection,
  selectSymmyRegionFields,
  SymmyRegionsResponseSchema,
  SymmyRegionsSelectedResponseSchema,
} from '../../api/symmy/regions-public-contract.ts';
import { SymmyInternalRegionsProjectionSchema } from '../../api/symmy/regions-projection-contract.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const marketRef = {
  moduleId: 'commerce.market-catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.market-catalog.market',
  tenantId,
} as const;
const projection = (count = 2) =>
  Schema.decodeUnknownSync(SymmyInternalRegionsProjectionSchema)({
    contractVersion: 'INTERNAL_C14',
    count,
    limit: 50,
    offset: 0,
    projection: 'regions',
    regions: [
      {
        country_codes: ['CZ'],
        currency_code: 'CZK',
        id: `~c14r1.${'a'.repeat(43)}`,
        market_code: 'CZ_NATIVE',
        marketRef,
        source_record_id: 'source-region-a',
      },
    ],
    unsupported_fields: ['name', 'tax_rate', 'tax_included', 'payment_providers'],
  });
const decodeQuery = Schema.decodeUnknownResult(SymmyRegionsReadQuerySchema);

describe('Symmy public regions body', () => {
  it('maps the internal projection to camelCase without markers or unsupported fields', () => {
    const body = mapSymmyRegionsProjection(projection());
    expect(body).toEqual({
      count: 2,
      limit: 50,
      offset: 0,
      regions: [
        {
          countryCodes: ['CZ'],
          currencyCode: 'CZK',
          id: `~c14r1.${'a'.repeat(43)}`,
          marketCode: 'CZ_NATIVE',
          marketRef,
          sourceRecordId: 'source-region-a',
        },
      ],
    });
    expect(Schema.is(Schema.toType(SymmyRegionsResponseSchema))(body)).toBe(true);
    for (const forbidden of ['contractVersion', 'projection', 'unsupported_fields', 'unsupportedFields']) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it('maps an empty page', () => {
    expect(mapSymmyRegionsProjection({ ...projection(0), regions: [] })).toEqual({
      count: 0,
      limit: 50,
      offset: 0,
      regions: [],
    });
  });

  it('keeps only the selected names plus id, and the envelope', () => {
    const full = mapSymmyRegionsProjection(projection());
    const selected = selectSymmyRegionFields(full, ['marketCode', 'marketCode']);
    expect(selected).toEqual({
      count: 2,
      limit: 50,
      offset: 0,
      regions: [{ id: `~c14r1.${'a'.repeat(43)}`, marketCode: 'CZ_NATIVE' }],
    });
    expect(Schema.is(Schema.toType(SymmyRegionsSelectedResponseSchema))(selected)).toBe(true);
    expect(selectSymmyRegionFields(full, ['id']).regions).toEqual([{ id: `~c14r1.${'a'.repeat(43)}` }]);
    expect(selectSymmyRegionFields(full, ['sourceRecordId']).regions[0]).toEqual({
      id: `~c14r1.${'a'.repeat(43)}`,
      sourceRecordId: 'source-region-a',
    });
  });

  it('returns the full body when every name is selected', () => {
    const full = mapSymmyRegionsProjection(projection());
    expect(
      selectSymmyRegionFields(full, ['sourceRecordId', 'countryCodes', 'currencyCode', 'marketCode', 'marketRef']),
    ).toEqual(full);
  });
});

describe('Symmy regions query', () => {
  const accepted = [
    {},
    { limit: '1' },
    { limit: '100', offset: '0' },
    { q: 'cz' },
    { q: '  cz  ' },
    { fields: 'marketCode' },
    { fields: 'sourceRecordId,countryCodes,currencyCode,marketCode,marketRef,id' },
    { fields: 'marketCode,marketCode' },
    { fields: 'id', limit: '2', offset: '1', q: 'a' },
  ];
  for (const query of accepted) {
    it(`accepts ${JSON.stringify(query)}`, () => {
      expect(Result.isSuccess(decodeQuery(query))).toBe(true);
    });
  }

  const rejected = [
    { limit: '0' },
    { limit: '101' },
    { limit: 'abc' },
    { offset: '-1' },
    { offset: 'abc' },
    { q: '' },
    { q: '   ' },
    { q: 'a'.repeat(201) },
    { fields: '' },
    { fields: 'nope' },
    { fields: 'marketCode,' },
    { fields: ',marketCode' },
    { fields: 'marketCode,,id' },
    { fields: '+marketCode' },
    { fields: '-marketCode' },
    { fields: 'marketCode, id' },
    { fields: 'MarketCode' },
    { fields: 'sourceRecordId,'.repeat(20) },
  ];
  for (const query of rejected) {
    it(`rejects ${JSON.stringify(query).slice(0, 60)}`, () => {
      expect(Result.isFailure(decodeQuery(query))).toBe(true);
    });
  }

  it('trims q and splits fields into names', () => {
    const decoded = Schema.decodeUnknownSync(SymmyRegionsReadQuerySchema)({ fields: 'marketCode,id', q: '  cz ' });
    expect(decoded).toEqual({ fields: ['marketCode', 'id'], q: 'cz' });
  });
});
