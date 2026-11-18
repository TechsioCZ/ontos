import { createHash } from 'node:crypto';

import {
  symmyCustomerAddressRecordSeed,
  symmyCustomerContactRecordSeed,
  symmyCustomerOccurrenceSeed,
  symmyCustomerRecordSeed,
} from '@app/symmy-integration/symmy-internal-contracts';
import type { Schema } from 'effect';

/**
 * The public `POST /customers/batch` body and the identities the owner derives from it. The conformance suites seed
 * Privacy for an exact source occurrence before they submit, so they name the same occurrence the owner will derive.
 */
const hex = (value: string) => createHash('sha256').update(value).digest('hex');
const uuidFromDigest = (digest: string): string =>
  `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${'89ab'.charAt(Number.parseInt(digest.charAt(16), 16) % 4)}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;

/** The occurrence of the plan item `itemKey` (`customer-0`, `address-0-1`) of the request sent with `idempotencyKey`. */
export const customerOccurrenceId = (idempotencyKey: string, itemKey: string): string =>
  uuidFromDigest(hex(symmyCustomerOccurrenceSeed(idempotencyKey, itemKey)));

/** The source record of a customer id the owners accept as it is (at most 200 characters, no surrounding blanks). */
export const customerRecordId = (customerId: string): string =>
  customerId.length <= 200 && customerId === customerId.trim()
    ? customerId
    : `symmy-customer:${hex(symmyCustomerRecordSeed(customerId))}`;

export interface PublicAddress {
  readonly label?: string;
  readonly postalAddress: {
    readonly addressLine1: string;
    readonly addressLine2?: string;
    readonly city: string;
    readonly countryCode: string;
    readonly postalCode: string;
    readonly region?: string;
  };
  readonly purposes: readonly ('BILLING' | 'DELIVERY')[];
}

/** The source record the owner derives for one address of one customer. */
export const addressRecordId = (customerId: string, address: PublicAddress): string =>
  `symmy-address:${hex(symmyCustomerAddressRecordSeed(customerRecordId(customerId), address))}`;

/** The source record the owner derives for one contact point of one customer. */
export const contactRecordId = (
  customerId: string,
  contact: Parameters<typeof symmyCustomerContactRecordSeed>[1],
): string => `symmy-contact:${hex(symmyCustomerContactRecordSeed(customerRecordId(customerId), contact))}`;

export interface PublicCustomer {
  readonly addresses?: readonly PublicAddress[];
  readonly contacts?: readonly Schema.Json[];
  readonly customerId: string;
  readonly firstName: string;
  readonly kind: 'PERSON';
  readonly lastName: string;
}
export interface PublicOrganization {
  readonly addresses?: readonly PublicAddress[];
  readonly businessName: string;
  readonly contacts?: readonly Schema.Json[];
  readonly customerId: string;
  readonly kind: 'ORGANIZATION';
  readonly officialIdentifiers?: readonly Schema.Json[];
}

/** The body of `POST /customers/batch`, as a JSON value. */
export const customersBody = (...customers: readonly (PublicCustomer | PublicOrganization)[]) => ({ customers });

/** The qualified source of one plan item, as the owners and Privacy name it. */
export const customerItemSource = (
  authority: {
    readonly issuer: string;
    readonly namespace: string;
    readonly recordType: string;
    readonly routeRef: string;
  },
  idempotencyKey: string,
  itemKey: string,
  recordId: string,
) => ({ ...authority, occurrenceId: customerOccurrenceId(idempotencyKey, itemKey), recordId });
