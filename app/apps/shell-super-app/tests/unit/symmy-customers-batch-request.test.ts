import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SymmyCustomersBatchRequestSchema } from '../../api/symmy/customers-batch-request-contract.ts';

type Body = typeof Schema.Json.Type;
// The HTTP layer decodes with excess properties rejected; the schema must hold under the same options.
const accepts = (body: Body) =>
  Result.isSuccess(Schema.decodeUnknownResult(SymmyCustomersBatchRequestSchema, { onExcessProperty: 'error' })(body));
const person = { customerId: 'c-1', firstName: 'Jana', kind: 'PERSON', lastName: 'Nováková' };
const organization = { businessName: 'Firma s.r.o.', customerId: 'c-2', kind: 'ORGANIZATION' };
const postalAddress = { addressLine1: 'Ulice 1', city: 'Praha', countryCode: 'CZ', postalCode: '11000' };
const withCustomer = (customer: Body) => ({ customers: [customer] });
const withIdentifiers = (officialIdentifiers: Body) => withCustomer({ ...organization, officialIdentifiers });
const withContacts = (contacts: Body) => withCustomer({ ...person, contacts });
const withAddresses = (addresses: Body) => withCustomer({ ...organization, addresses });

describe('Symmy customers batch request: customers', () => {
  it('accepts a person and an organization, one to sixteen customers', () => {
    expect(accepts(withCustomer(person))).toBe(true);
    expect(accepts(withCustomer(organization))).toBe(true);
    expect(accepts({ customers: [person, organization] })).toBe(true);
    expect(accepts({ customers: Array.from({ length: 16 }, () => person) })).toBe(true);
  });

  it('rejects a missing, empty, oversized or wrongly typed list', () => {
    expect(accepts({})).toBe(false);
    expect(accepts({ customers: [] })).toBe(false);
    expect(accepts({ customers: Array.from({ length: 17 }, () => person) })).toBe(false);
    expect(accepts({ customers: person })).toBe(false);
  });

  it('requires customerId and kind', () => {
    const { customerId: _id, ...withoutId } = person;
    const { kind: _kind, ...withoutKind } = person;
    expect(accepts(withCustomer(withoutId))).toBe(false);
    expect(accepts(withCustomer(withoutKind))).toBe(false);
    expect(accepts(withCustomer({ ...person, kind: 'COMPANY' }))).toBe(false);
    expect(accepts(withCustomer({ ...person, customerId: '' }))).toBe(false);
    expect(accepts(withCustomer({ ...person, customerId: 'a'.repeat(301) }))).toBe(false);
    expect(accepts(withCustomer({ ...person, customerId: 'a'.repeat(300) }))).toBe(true);
  });

  it('requires the name fields of the kind and refuses the other kind name fields', () => {
    expect(accepts(withCustomer({ customerId: 'c', kind: 'PERSON', lastName: 'N' }))).toBe(false);
    expect(accepts(withCustomer({ customerId: 'c', firstName: 'J', kind: 'PERSON' }))).toBe(false);
    expect(accepts(withCustomer({ customerId: 'c', kind: 'ORGANIZATION' }))).toBe(false);
    expect(accepts(withCustomer({ ...person, businessName: 'X' }))).toBe(false);
    expect(accepts(withCustomer({ ...organization, firstName: 'J' }))).toBe(false);
    expect(accepts(withCustomer({ ...organization, lastName: 'N' }))).toBe(false);
    expect(accepts(withCustomer({ ...person, firstName: '' }))).toBe(false);
    expect(accepts(withCustomer({ ...organization, businessName: '' }))).toBe(false);
  });

  it('rejects customer groups, metadata, the contract version and unknown properties', () => {
    for (const extra of [
      { customerGroupCodes: ['g'] },
      { priceGroups: ['g'] },
      { metadata: {} },
      { contractVersion: 'INTERNAL_C14' },
      { unknown: 1 },
    ]) {
      expect(accepts(withCustomer({ ...person, ...extra })), JSON.stringify(extra)).toBe(false);
    }
    expect(accepts({ contractVersion: 'INTERNAL_C14', customers: [person] })).toBe(false);
    expect(accepts({ customers: [person], fixtureId: 'x' })).toBe(false);
  });
});

describe('Symmy customers batch request: official identifiers', () => {
  it('accepts a valid ICO and CZ_DIC, short ICOs included', () => {
    for (const identifier of [
      { type: 'ICO', value: '00000019' },
      { type: 'ICO', value: '19' },
      { type: 'CZ_DIC', value: 'CZ00000019' },
      { type: 'CZ_DIC', value: 'cz1234567890' },
    ]) {
      expect(accepts(withIdentifiers([identifier])), JSON.stringify(identifier)).toBe(true);
    }
  });

  it('rejects a bad checksum, a bad format, an unknown type or missing fields', () => {
    for (const identifier of [
      { type: 'ICO', value: '00000018' },
      { type: 'ICO', value: '123456789' },
      { type: 'ICO', value: 'abc' },
      { type: 'CZ_DIC', value: 'CZ123' },
      { type: 'CZ_DIC', value: '12345678' },
      { type: 'VAT', value: 'CZ00000019' },
      { type: 'ICO' },
      { value: '00000019' },
      { namespace: 'x', type: 'ICO', value: '00000019' },
    ]) {
      expect(accepts(withIdentifiers([identifier])), JSON.stringify(identifier)).toBe(false);
    }
  });

  it('allows at most 20 identifiers', () => {
    const identifier = { type: 'ICO', value: '00000019' };
    expect(accepts(withIdentifiers(Array.from({ length: 20 }, () => identifier)))).toBe(true);
    expect(accepts(withIdentifiers(Array.from({ length: 21 }, () => identifier)))).toBe(false);
  });
});

describe('Symmy customers batch request: contacts', () => {
  it('accepts email and phone contacts', () => {
    for (const contact of [
      { preferred: true, type: 'EMAIL', value: 'a@b.cz' },
      { preferred: false, type: 'PHONE', value: '+420 123 456 789' },
      { countryCode: 'CZ', preferred: false, type: 'PHONE', value: '123456789' },
      { countryCode: 'cz', preferred: false, type: 'PHONE', value: '(02) 123 456' },
      { extension: '12', preferred: false, type: 'PHONE', value: '+420123456789' },
    ]) {
      expect(accepts(withContacts([contact])), JSON.stringify(contact)).toBe(true);
    }
  });

  it('rejects a bad email, a bad phone, a missing country code or preferred flag', () => {
    for (const contact of [
      { preferred: true, type: 'EMAIL', value: 'not-an-email' },
      { preferred: true, type: 'EMAIL', value: 'a@b' },
      { type: 'EMAIL', value: 'a@b.cz' },
      { preferred: true, type: 'EMAIL' },
      { countryCode: 'CZ', preferred: true, type: 'EMAIL', value: 'a@b.cz' },
      { preferred: false, type: 'PHONE', value: '123456789' },
      { countryCode: 'CZE', preferred: false, type: 'PHONE', value: '123456789' },
      { countryCode: 'CZ', preferred: false, type: 'PHONE', value: 'abc' },
      { countryCode: 'CZ', preferred: false, type: 'PHONE', value: '12' },
      { extension: 'abc', preferred: false, type: 'PHONE', value: '+420123456789' },
      { extension: '1'.repeat(13), preferred: false, type: 'PHONE', value: '+420123456789' },
      { type: 'PHONE', value: '+420123456789' },
      { preferred: true, type: 'FAX', value: '+420123456789' },
      { preferred: true, type: 'ADDRESS', value: 'x' },
    ]) {
      expect(accepts(withContacts([contact])), JSON.stringify(contact)).toBe(false);
    }
  });

  it('allows at most 10 contacts', () => {
    const contact = { preferred: false, type: 'EMAIL', value: 'a@b.cz' };
    expect(accepts(withContacts(Array.from({ length: 10 }, () => contact)))).toBe(true);
    expect(accepts(withContacts(Array.from({ length: 11 }, () => contact)))).toBe(false);
  });
});

describe('Symmy customers batch request: addresses', () => {
  const address = { label: 'Sídlo', postalAddress, purposes: ['BILLING'] };

  it('accepts an address with one or two unique purposes', () => {
    expect(accepts(withAddresses([address]))).toBe(true);
    expect(accepts(withAddresses([{ ...address, purposes: ['BILLING', 'DELIVERY'] }]))).toBe(true);
    expect(accepts(withAddresses([{ postalAddress, purposes: ['DELIVERY'] }]))).toBe(true);
    expect(
      accepts(
        withAddresses([{ ...address, postalAddress: { ...postalAddress, addressLine2: 'Patro 2', region: 'Praha' } }]),
      ),
    ).toBe(true);
  });

  it('rejects missing postal fields, bad purposes and a bad country code', () => {
    for (const key of Object.keys(postalAddress)) {
      const partial = Object.fromEntries(Object.entries(postalAddress).filter(([name]) => name !== key));
      expect(accepts(withAddresses([{ ...address, postalAddress: partial }])), key).toBe(false);
    }
    for (const purposes of [
      [],
      ['BILLING', 'DELIVERY', 'BILLING'],
      ['BILLING', 'BILLING'],
      ['REGISTERED'],
      'BILLING',
    ]) {
      expect(accepts(withAddresses([{ ...address, purposes }])), JSON.stringify(purposes)).toBe(false);
    }
    expect(accepts(withAddresses([{ label: 'x', postalAddress }]))).toBe(false);
    expect(accepts(withAddresses([{ ...address, postalAddress: { ...postalAddress, countryCode: 'cz' } }]))).toBe(
      false,
    );
    expect(accepts(withAddresses([{ ...address, postalAddress: { ...postalAddress, countryCode: 'CZE' } }]))).toBe(
      false,
    );
    expect(accepts(withAddresses([{ ...address, label: '' }]))).toBe(false);
  });

  it('rejects per-address name, company and phone', () => {
    for (const extra of [{ name: 'x' }, { company: 'x' }, { phone: '+420123456789' }]) {
      expect(accepts(withAddresses([{ ...address, ...extra }])), JSON.stringify(extra)).toBe(false);
    }
  });

  it('allows at most 10 addresses', () => {
    expect(accepts(withAddresses(Array.from({ length: 10 }, () => address)))).toBe(true);
    expect(accepts(withAddresses(Array.from({ length: 11 }, () => address)))).toBe(false);
  });
});
