import { Schema } from 'effect';
import { PartyContactPointRefSchema } from '@app/party-registry/resources/party-contact-point';
import { PartyRefSchema } from '@app/party-registry/resources/party';
import { CounterpartyRefSchema } from '@app/party-registry/resources/counterparty';
import { CounterpartyPurchasingProfileRefSchema } from '../resources/counterparty-purchasing-profile.ts';
import { RetailCustomerProfileRefSchema } from '../resources/retail-customer-profile.ts';
import { SavedAddressRefSchema } from '../resources/saved-address.ts';

const NonEmptyText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const CountryCode = Schema.String.check(Schema.isPattern(/^[A-Z]{2}$/u));

export const AddressBookProfileSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('RETAIL'), profileRef: RetailCustomerProfileRefSchema }),
  Schema.Struct({
    counterpartyRef: CounterpartyRefSchema,
    kind: Schema.Literal('COUNTERPARTY'),
    profileRef: CounterpartyPurchasingProfileRefSchema,
  }).check(
    Schema.makeFilter(({ counterpartyRef, profileRef }) =>
      counterpartyRef.tenantId === profileRef.tenantId
        ? undefined
        : 'The Counterparty and purchasing profile must belong to the same Tenant',
    ),
  ),
]);
export type AddressBookProfile = typeof AddressBookProfileSchema.Type;

export const PostalAddressSchema = Schema.Struct({
  addressLine1: NonEmptyText,
  addressLine2: Schema.optional(NonEmptyText),
  city: NonEmptyText,
  countryCode: CountryCode,
  postalCode: NonEmptyText,
  region: Schema.optional(NonEmptyText),
});
export type PostalAddress = typeof PostalAddressSchema.Type;

export const SavedAddressPurposeSchema = Schema.Literals(['BILLING', 'DELIVERY']);
export type SavedAddressPurpose = typeof SavedAddressPurposeSchema.Type;
export const SavedAddressPurposesSchema = Schema.Array(SavedAddressPurposeSchema).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2),
  Schema.makeFilter((purposes) =>
    new Set(purposes).size === purposes.length ? undefined : 'Address purposes must be unique',
  ),
);

export const SavedAddressOriginSchema = Schema.Union([
  Schema.Struct({
    contactPointRef: PartyContactPointRefSchema,
    kind: Schema.Literal('PARTY_BACKED'),
    partyRef: PartyRefSchema,
    sourceRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }).check(
    Schema.makeFilter(({ contactPointRef, partyRef }) =>
      contactPointRef.tenantId === partyRef.tenantId
        ? undefined
        : 'The Party and Contact Point must belong to the same Tenant',
    ),
  ),
  Schema.Struct({ kind: Schema.Literal('COMMERCE_ONLY'), postalAddress: PostalAddressSchema }),
]);
export type SavedAddressOrigin = typeof SavedAddressOriginSchema.Type;

export const SavedAddressSchema = Schema.Struct({
  label: Schema.optional(NonEmptyText),
  lifecycle: Schema.Literals(['ACTIVE', 'REMOVED']),
  origin: SavedAddressOriginSchema,
  profile: AddressBookProfileSchema,
  purposes: SavedAddressPurposesSchema,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  savedAddressRef: SavedAddressRefSchema,
}).check(
  Schema.makeFilter(({ origin, profile, savedAddressRef }) => {
    const { tenantId } = profile.profileRef;
    const sourceMatches =
      origin.kind === 'COMMERCE_ONLY' ||
      (origin.partyRef.tenantId === tenantId && origin.contactPointRef.tenantId === tenantId);
    return savedAddressRef.tenantId === tenantId && sourceMatches
      ? undefined
      : 'A Saved Address and every nested reference must belong to its profile Tenant';
  }),
);
export type SavedAddress = typeof SavedAddressSchema.Type;
export const ActiveSavedAddressSchema = SavedAddressSchema.check(
  Schema.makeFilter(({ lifecycle }) =>
    lifecycle === 'ACTIVE' ? undefined : 'Ordinary address-book reads expose only active entries',
  ),
);

export const SavedAddressDefaultsSchema = Schema.Struct({
  billing: Schema.optional(SavedAddressRefSchema),
  delivery: Schema.optional(SavedAddressRefSchema),
  profile: AddressBookProfileSchema,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).check(
  Schema.makeFilter(({ billing, delivery, profile }) => {
    const { tenantId } = profile.profileRef;
    return (billing === undefined || billing.tenantId === tenantId) &&
      (delivery === undefined || delivery.tenantId === tenantId)
      ? undefined
      : 'Address defaults and profile must belong to the same Tenant';
  }),
);
export type SavedAddressDefaults = typeof SavedAddressDefaultsSchema.Type;

export const isAddressEligibleFor = (address: SavedAddress, purpose: SavedAddressPurpose) =>
  address.lifecycle === 'ACTIVE' && address.purposes.includes(purpose);

const reconcileDefault = (
  current: SavedAddressDefaults['billing'],
  address: SavedAddress,
  purpose: SavedAddressPurpose,
): SavedAddressDefaults['billing'] =>
  current?.resourceId === address.savedAddressRef.resourceId && !isAddressEligibleFor(address, purpose)
    ? undefined
    : current;

export const reconcileDefaults = (defaults: SavedAddressDefaults, address: SavedAddress): SavedAddressDefaults => {
  const billing = reconcileDefault(defaults.billing, address, 'BILLING');
  const delivery = reconcileDefault(defaults.delivery, address, 'DELIVERY');
  const reconciledDefaults = {};
  if (billing !== undefined) {
    Object.assign(reconciledDefaults, { billing });
  }
  if (delivery !== undefined) {
    Object.assign(reconciledDefaults, { delivery });
  }
  return Object.assign(reconciledDefaults, {
    profile: defaults.profile,
    revision: defaults.revision + 1,
  });
};
