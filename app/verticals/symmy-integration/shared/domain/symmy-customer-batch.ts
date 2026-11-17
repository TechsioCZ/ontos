import { AddSavedAddressPayloadSchema } from '@app/commerce-customer-context/api/add-saved-address-action';
import { OfficialIdentifierInputSchema } from '@app/party-registry/domain/identifier-contracts';
import { AddContactPointPayloadSchema, CreatePartyPayloadSchema } from '@app/party-registry/api';
import { Schema } from 'effect';

/** A plan holds at most sixteen items and an item at most thirty-two effects. */
const SYMMY_CUSTOMER_BATCH_MAX_ITEMS = 16;
const SYMMY_CUSTOMER_MAX_EFFECTS = 32;

/**
 * What every Symmy customer write states about itself. The caller never supplies these values: they are the values
 * the conformance fixtures proved against the owners, named once and owned by the Symmy integration.
 */
export const SYMMY_CUSTOMER_EVIDENCE_REF = 'SYMMY_EXPLICIT_CLIENT_RECORD';
export const SYMMY_CUSTOMER_PERSON_STATEMENT =
  'The Symmy customer record explicitly asserts this named concrete person';
export const SYMMY_CUSTOMER_SOURCE_REVISION_STEM = 'symmy-customer-revision';
export const SYMMY_ADDRESS_REASON = 'Qualified Symmy source explicitly imports this postal address';
export const SYMMY_ADDRESS_SOURCE_REVISION = 'symmy-address-revision-1';
export const SYMMY_ADDRESS_SOURCE_ORDER = 1;
/** The placeholder the owner replaces with the actual effect id when it pins the plan. */
export const SYMMY_EFFECT_ASSIGNED_AT_ADMISSION = 'SYMMY_ASSIGNED_AT_ADMISSION';
export const SYMMY_CONTACT_PROVENANCE = {
  authoritative: false,
  method: 'PROVIDER_OBSERVATION',
  source: 'EXTERNAL_EVIDENCE',
} as const;
export const SYMMY_COUNTERPARTY_PROVENANCE_METHOD = 'APPROVED_COMMERCIAL_RELATIONSHIP';
export const SYMMY_CUSTOMER_EVIDENCE_METHOD = 'APPROVED_PURCHASING_RELATIONSHIP';

/**
 * The text whose digest names the source occurrence of one plan item: one request key and one item key are one
 * observation of one record. It is exported so a conformance fixture can name the occurrence before it submits.
 */
export const symmyCustomerOccurrenceSeed = (idempotencyKey: string, itemKey: string): string =>
  `occurrence\u0000${idempotencyKey}\u0000${itemKey}`;

/** The text whose digest names the source record of a customer id the owners cannot take as it is. */
export const symmyCustomerRecordSeed = (customerId: string): string => `customer-record\u0000${customerId}`;

/**
 * The text whose digest names the source record of one saved address of one customer. A saved address binds one
 * source record to one address of a profile, so the record is the customer, the label, the postal address and the
 * purposes: the same address of the same customer is always the same record.
 */
export const symmyCustomerAddressRecordSeed = (
  customerRecordId: string,
  { label, postalAddress, purposes }: Pick<SymmyCustomerAddress, 'label' | 'postalAddress' | 'purposes'>,
): string =>
  [
    'address-record',
    customerRecordId,
    label ?? '',
    postalAddress.addressLine1,
    postalAddress.addressLine2 ?? '',
    postalAddress.city,
    postalAddress.postalCode,
    postalAddress.region ?? '',
    postalAddress.countryCode,
    [...purposes].toSorted().join(','),
  ]
    .map((part) => `${part.length}:${part}`)
    .join('');

/**
 * The text whose digest names the source record of one contact point of one customer. The Party owner binds one
 * contact point to a source record, so a contact point is a source record of its own, named by the customer and
 * the contact: the same contact point of the same customer is always the same record.
 */
export const symmyCustomerContactRecordSeed = (
  customerRecordId: string,
  contact: SymmyCustomerRow['contacts'][number],
): string =>
  [
    'contact-record',
    customerRecordId,
    contact.type,
    contact.value,
    contact.type === 'PHONE' ? (contact.countryCode ?? '') : '',
    contact.type === 'PHONE' ? (contact.extension ?? '') : '',
    contact.preferred ? 'preferred' : 'regular',
  ]
    .map((part) => `${part.length}:${part}`)
    .join('');

const [emailContact, phoneContact] = AddContactPointPayloadSchema.fields.contactPoint.members;
const [postalAddress] = AddSavedAddressPayloadSchema.fields.origin.members[1].fields.postalAddress.schema.members;
const candidate = CreatePartyPayloadSchema.fields.candidate.fields;
const personName = candidate.firstName.schema;
const customerId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));

const SymmyCustomerAddressSchema = Schema.Struct({
  label: Schema.optionalKey(AddSavedAddressPayloadSchema.fields.label.schema),
  postalAddress,
  purposes: AddSavedAddressPayloadSchema.fields.purposes,
});
export type SymmyCustomerAddress = typeof SymmyCustomerAddressSchema.Type;

const shared = {
  addresses: Schema.Array(SymmyCustomerAddressSchema).check(Schema.isMaxLength(10)),
  contacts: Schema.Array(Schema.Union([emailContact, phoneContact])).check(Schema.isMaxLength(10)),
  customerId,
  officialIdentifiers: Schema.Array(OfficialIdentifierInputSchema).check(Schema.isMaxLength(20)),
} as const;

/**
 * One public customer as the owner admission receives it. `kind` decides the owner flow and the name fields; the
 * route enrollment and the admission supply every owner fact the body lacks.
 */
export const SymmyCustomerRowSchema = Schema.Union([
  Schema.Struct({
    ...shared,
    firstName: personName,
    kind: Schema.Literal('PERSON'),
    lastName: candidate.lastName.schema,
  }),
  Schema.Struct({ ...shared, businessName: candidate.businessName.schema, kind: Schema.Literal('ORGANIZATION') }),
]);
export type SymmyCustomerRow = typeof SymmyCustomerRowSchema.Type;

interface SizedCustomer {
  readonly addresses?: readonly unknown[] | undefined;
  readonly contacts?: readonly unknown[] | undefined;
  readonly kind: 'PERSON' | 'ORGANIZATION';
}

/**
 * What a customer needs in a plan: the Party and its profile (an organization also its counterparty role), one add
 * per contact and one add per address. The Party binds one source record to one contact point and Commerce binds
 * one source record to one address of a profile, so each contact and each address is an item of its own with a
 * source record derived from the customer and the contact or the address.
 */
export const symmyCustomerPlanSize = ({ addresses, contacts, kind }: SizedCustomer) => {
  const addressCount = addresses?.length ?? 0;
  return {
    effects: (kind === 'PERSON' ? 2 : 3) + (contacts?.length ?? 0) + addressCount,
    items: 1 + (contacts?.length ?? 0) + addressCount,
  };
};

/** Why a request cannot be planned, or undefined when it fits one plan. */
export const symmyCustomerBatchLimit = (customers: readonly SizedCustomer[]): string | undefined => {
  const sizes = customers.map(symmyCustomerPlanSize);
  if (sizes.some(({ effects }) => effects > SYMMY_CUSTOMER_MAX_EFFECTS)) {
    return `A customer needs at most ${SYMMY_CUSTOMER_MAX_EFFECTS} owner effects`;
  }
  return sizes.reduce((total, { items }) => total + items, 0) > SYMMY_CUSTOMER_BATCH_MAX_ITEMS
    ? `A request needs at most ${SYMMY_CUSTOMER_BATCH_MAX_ITEMS} plan items: its customers, their contacts and their addresses`
    : undefined;
};

/**
 * The sizes of public customers, whatever their other fields: the plan limit a request body is checked against
 * before it is mapped, so a request no plan can hold is refused at the decoder.
 */
export const SymmyCustomerPlanSizeSchema = Schema.Array(
  Schema.Struct({
    addresses: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    contacts: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    kind: Schema.Literals(['PERSON', 'ORGANIZATION']),
  }),
).check(Schema.makeFilter((customers) => symmyCustomerBatchLimit(customers)));

export const SymmyCustomerRowsSchema = Schema.NonEmptyArray(SymmyCustomerRowSchema).check(
  Schema.makeFilter((customers) => symmyCustomerBatchLimit(customers)),
);
export type SymmyCustomerRows = typeof SymmyCustomerRowsSchema.Type;
