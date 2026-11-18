import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { mapSymmyCustomersBatchRequest } from '../../api/symmy/customers-batch-public-contract.ts';
import { SymmyCustomersBatchRequestSchema } from '../../api/symmy/customers-batch-request-contract.ts';

const decode = Schema.decodeUnknownSync(SymmyCustomersBatchRequestSchema, { onExcessProperty: 'error' });
const postalAddress = { addressLine1: 'Ulice 1', city: 'Praha', countryCode: 'CZ', postalCode: '11000' };

describe('Symmy customers batch public mapping', () => {
  it('names every optional list and the owner name of an identifier', () => {
    const rows = mapSymmyCustomersBatchRequest(
      decode({
        customers: [
          { customerId: 'c-1', firstName: ' Jana ', kind: 'PERSON', lastName: 'Nováková' },
          {
            addresses: [{ label: 'Sídlo', postalAddress, purposes: ['BILLING', 'DELIVERY'] }],
            businessName: 'Firma s.r.o.',
            contacts: [{ preferred: true, type: 'EMAIL', value: 'a@b.cz' }],
            customerId: 'c-2',
            kind: 'ORGANIZATION',
            officialIdentifiers: [
              { type: 'ICO', value: '00000019' },
              { type: 'CZ_DIC', value: 'CZ00000019' },
            ],
          },
        ],
      }),
    );
    expect(rows).toEqual([
      {
        addresses: [],
        contacts: [],
        customerId: 'c-1',
        firstName: 'Jana',
        kind: 'PERSON',
        lastName: 'Nováková',
        officialIdentifiers: [],
      },
      {
        addresses: [{ label: 'Sídlo', postalAddress, purposes: ['BILLING', 'DELIVERY'] }],
        businessName: 'Firma s.r.o.',
        contacts: [{ preferred: true, type: 'EMAIL', value: 'a@b.cz' }],
        customerId: 'c-2',
        kind: 'ORGANIZATION',
        officialIdentifiers: [
          { identifierType: 'ICO', value: '00000019' },
          { identifierType: 'CZ_DIC', value: 'CZ00000019' },
        ],
      },
    ]);
  });

  it('never carries a contract version, a plan or an owner fact the body does not state', () => {
    const rows = mapSymmyCustomersBatchRequest(
      decode({ customers: [{ businessName: 'Firma', customerId: 'c-1', kind: 'ORGANIZATION' }] }),
    );
    expect(Object.keys(rows[0] ?? {}).toSorted()).toEqual([
      'addresses',
      'businessName',
      'contacts',
      'customerId',
      'kind',
      'officialIdentifiers',
    ]);
  });
});
