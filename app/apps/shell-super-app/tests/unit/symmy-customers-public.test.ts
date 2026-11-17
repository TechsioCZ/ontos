import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SymmyCustomersReadQuerySchema } from '../../api/symmy/contract.ts';
import {
  mapSymmyCustomersProjection,
  SymmyCustomersResponseSchema,
} from '../../api/symmy/customers-public-contract.ts';
import { SymmyInternalCustomersProjectionSchema } from '../../api/symmy/read-projection-contracts.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const partyId = '55555555-5555-4555-8555-555555555555';
const profileId = '66666666-6666-4666-8666-666666666666';
const readId = (letter: string) => `~c14r1.${letter.repeat(43)}`;
const partyRef = {
  moduleId: 'party.registry',
  resourceId: partyId,
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const retailProfile = {
  profileRef: {
    kind: 'RETAIL',
    moduleId: 'commerce.customer-context',
    resourceId: profileId,
    resourceType: 'commerce.customer-context.retail-customer-profile',
    tenantId,
  },
  revision: 1,
  state: 'ACTIVE',
  subject: {
    kind: 'RETAIL',
    partyRef,
    sellingLegalEntityRef: {
      moduleId: 'core.identity',
      resourceId: legalEntityId,
      resourceType: 'core.identity.legal-entity',
      tenantId,
    },
  },
} as const;
const personParty = {
  businessName: null,
  contactPoints: [],
  firstName: 'Petr',
  lastName: null,
  outcome: 'AVAILABLE',
  partyRef,
  partyType: 'PERSON',
  revision: 2,
  unsupported: ['ADDRESSES'],
} as const;
const projection = () =>
  Schema.decodeUnknownSync(SymmyInternalCustomersProjectionSchema)({
    contractVersion: 'INTERNAL_C14',
    count: 3,
    customers: [
      {
        ico: { _tag: 'ABSENT' },
        id: readId('a'),
        party: personParty,
        partyRef,
        profile: retailProfile,
        source_record_id: 'source-customer-a',
      },
      {
        business_name: {
          assertionId: '90000000-0000-4000-8000-000000000003',
          outcome: 'AVAILABLE',
          recordedAt: '1970-01-01T00:00:00.000Z',
          validFrom: '1970-01-01T00:00:00.000Z',
          value: 'Company s.r.o.',
        },
        id: readId('b'),
        partyRef,
        profile: retailProfile,
        source_record_id: 'source-customer-b',
      },
      { id: readId('c'), partyRef, profile: retailProfile, source_record_id: 'source-customer-c' },
    ],
    limit: 50,
    offset: 1,
    projection: 'customers',
    unsupported_fields: ['addresses', 'groups', 'name', 'contacts', 'ico'],
  });
const decodeQuery = Schema.decodeUnknownResult(SymmyCustomersReadQuerySchema);

describe('Symmy public customers body', () => {
  it('maps the internal projection to camelCase without markers, cursor or unsupported fields', () => {
    const body = mapSymmyCustomersProjection(projection());
    expect(body).toMatchObject({ count: 3, limit: 50, offset: 1 });
    expect(body.customers[0]).toMatchObject({
      id: readId('a'),
      party: personParty,
      partyRef,
      profile: retailProfile,
      sourceRecordId: 'source-customer-a',
    });
    expect(body.customers[1]).toMatchObject({
      businessName: { value: 'Company s.r.o.' },
      sourceRecordId: 'source-customer-b',
    });
    expect(Schema.is(Schema.toType(SymmyCustomersResponseSchema))(body)).toBe(true);
    const json = JSON.stringify(body);
    for (const forbidden of [
      'contractVersion',
      'projection',
      'unsupported_fields',
      'unsupportedFields',
      'nextRecordId',
      'source_record_id',
      'business_name',
    ]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it('leaves an absent party, business name and ICO absent instead of null', () => {
    const [first, second, third] = mapSymmyCustomersProjection(projection()).customers;
    expect(first).not.toHaveProperty('businessName');
    expect(second).not.toHaveProperty('party');
    expect(second).not.toHaveProperty('ico');
    expect(third).not.toHaveProperty('party');
    expect(third).not.toHaveProperty('businessName');
    expect(third).not.toHaveProperty('ico');
    for (const customer of [first, second, third]) {
      expect(Object.values(customer ?? {})).not.toContain(null);
    }
  });

  it('keeps the owner nulls inside the party and nowhere else', () => {
    const [first] = mapSymmyCustomersProjection(projection()).customers;
    expect(first?.party).toMatchObject({ businessName: null, lastName: null });
  });

  it('maps an empty page and keeps the owner total', () => {
    const empty = Schema.decodeUnknownSync(SymmyInternalCustomersProjectionSchema)({
      contractVersion: 'INTERNAL_C14',
      count: 7,
      customers: [],
      limit: 10,
      offset: 20,
      projection: 'customers',
      unsupported_fields: ['addresses', 'groups'],
    });
    expect(mapSymmyCustomersProjection(empty)).toEqual({ count: 7, customers: [], limit: 10, offset: 20 });
  });
});

describe('Symmy customers query', () => {
  const names = ['id', 'sourceRecordId', 'partyRef', 'profile', 'party', 'businessName', 'ico'];
  const accepted = [
    {},
    { limit: '1' },
    { limit: '100', offset: '0' },
    { q: 'ada' },
    { q: '  ada  ' },
    { q: 'a'.repeat(300) },
    ...names.map((fields) => ({ fields })),
    { fields: names.join(',') },
    { fields: 'ico,ico' },
    { fields: 'party', limit: '2', offset: '1', q: 'a' },
  ];
  for (const query of accepted) {
    it(`accepts ${JSON.stringify(query).slice(0, 60)}`, () => {
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
    { q: 'a'.repeat(301) },
    { fields: '' },
    { fields: 'bogus' },
    { fields: 'party,' },
    { fields: ',party' },
    { fields: 'party,,ico' },
    { fields: '+party' },
    { fields: '-party' },
    { fields: 'party, ico' },
    { fields: 'Party' },
    { fields: 'party.firstName' },
    { fields: 'businessName.value' },
    { fields: 'ico._tag' },
    { fields: 'profile.state' },
    { fields: 'source_record_id' },
    { fields: 'x'.repeat(201) },
    { afterRecordId: 'cursor' },
    { code: 'source' },
    { sourceRecordId: 'source' },
    { contractVersion: 'INTERNAL_C14' },
    { priceLimit: '1' },
    { priceOffset: '1' },
    { order: 'name' },
    { unknown: '1' },
  ];
  for (const query of rejected) {
    it(`rejects ${JSON.stringify(query).slice(0, 60)}`, () => {
      expect(
        Result.isFailure(
          Schema.decodeUnknownResult(SymmyCustomersReadQuerySchema)(query, { onExcessProperty: 'error' }),
        ),
      ).toBe(true);
    });
  }

  it('trims q and splits fields into names', () => {
    expect(Schema.decodeUnknownSync(SymmyCustomersReadQuerySchema)({ fields: 'ico,party,ico', q: '  ada ' })).toEqual({
      fields: ['ico', 'party', 'ico'],
      q: 'ada',
    });
  });
});
