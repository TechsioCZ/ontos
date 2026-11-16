import { Schema } from 'effect';
import {
  AddressBookProfileSchema,
  SavedAddressOriginSchema,
  SavedAddressPurposeSchema,
  SavedAddressPurposesSchema,
  SavedAddressSchema,
  SavedAddressDefaultsSchema,
} from './address-book.ts';
import { SavedAddressRefSchema } from '../resources/saved-address.ts';
import { SavedAddressSourceAssertionSchema } from './saved-address-source.ts';

const AddressActionReasonSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const AddressLabelSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const AddressRevisionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const AddressDefaultsRevisionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const SavedAddressSourceKindSchema = Schema.Literals(['PARTY_BACKED', 'COMMERCE_ONLY']);
const SavedAddressSourceTransitionSchema = Schema.Struct({
  fromKind: SavedAddressSourceKindSchema,
  toKind: SavedAddressSourceKindSchema,
}).check(
  Schema.makeFilter(({ fromKind, toKind }) =>
    fromKind === toKind ? 'A source transition must change the address owner kind' : undefined,
  ),
);

const profileTenantId = (profile: typeof AddressBookProfileSchema.Type) => profile.profileRef.tenantId;

const originMatchesTenant = (origin: typeof SavedAddressOriginSchema.Type, tenantId: string) =>
  origin.kind === 'COMMERCE_ONLY' ||
  (origin.partyRef.tenantId === tenantId && origin.contactPointRef.tenantId === tenantId);

/** A command that writes a Commerce-only address states its postal address; only reads may omit it (O58). */
const originStatesItsPostalAddress = (origin: typeof SavedAddressOriginSchema.Type) =>
  origin.kind !== 'COMMERCE_ONLY' || origin.postalAddress !== undefined
    ? undefined
    : 'A Commerce-only Saved Address must state its postal address';

export const AddSavedAddressPayloadSchema = Schema.Struct({
  label: Schema.optional(AddressLabelSchema),
  origin: SavedAddressOriginSchema,
  profile: AddressBookProfileSchema,
  purposes: SavedAddressPurposesSchema,
  reason: AddressActionReasonSchema,
  source: Schema.optionalKey(SavedAddressSourceAssertionSchema),
}).check(
  Schema.makeFilter(({ origin, profile, purposes, source }) => {
    if (
      source !== undefined &&
      (source.nativeAddressId !== undefined ||
        purposes.length !== source.purposes.length ||
        !purposes.every((purpose) => new Set(source.purposes).has(purpose)))
    ) {
      return 'A source Add must declare the exact purposes and cannot invent a native address ID';
    }
    if (!originMatchesTenant(origin, profileTenantId(profile))) {
      return 'The address source and profile must belong to the same Tenant';
    }
    return originStatesItsPostalAddress(origin);
  }),
);
export type AddSavedAddressPayload = typeof AddSavedAddressPayloadSchema.Type;
export const AddSavedAddressResultSchema = Schema.Struct({
  address: SavedAddressSchema,
  outcome: Schema.Literals(['ADDED', 'REUSED']),
});

export const UpdateSavedAddressPayloadSchema = Schema.Struct({
  expectedRevision: AddressRevisionSchema,
  label: Schema.optional(AddressLabelSchema),
  origin: Schema.optional(SavedAddressOriginSchema),
  profile: AddressBookProfileSchema,
  purposes: Schema.optional(SavedAddressPurposesSchema),
  reason: AddressActionReasonSchema,
  savedAddressRef: SavedAddressRefSchema,
  source: Schema.optionalKey(SavedAddressSourceAssertionSchema),
  sourceTransition: Schema.optional(SavedAddressSourceTransitionSchema),
}).check(
  Schema.makeFilter(({ origin, profile, purposes, savedAddressRef, source, sourceTransition }) => {
    if (
      source !== undefined &&
      (source.nativeAddressId !== savedAddressRef.resourceId ||
        (purposes !== undefined &&
          (purposes.length !== source.purposes.length ||
            !purposes.every((purpose) => new Set(source.purposes).has(purpose)))))
    ) {
      return 'A source Update must retain its exact native address ID and declared purposes';
    }
    const tenantId = profileTenantId(profile);
    if (savedAddressRef.tenantId !== tenantId || (origin !== undefined && !originMatchesTenant(origin, tenantId))) {
      return 'The address, source, and profile must belong to the same Tenant';
    }
    if (sourceTransition !== undefined && (origin === undefined || sourceTransition.toKind !== origin.kind)) {
      return 'An explicit source transition must name the supplied address source as its target';
    }
    return origin === undefined ? undefined : originStatesItsPostalAddress(origin);
  }),
);
export type UpdateSavedAddressPayload = typeof UpdateSavedAddressPayloadSchema.Type;
export const UpdateSavedAddressResultSchema = Schema.Struct({
  address: SavedAddressSchema,
  clearedDefaults: Schema.Array(SavedAddressPurposeSchema),
  outcome: Schema.Literals(['UPDATED', 'UNCHANGED']),
});

export const RemoveSavedAddressPayloadSchema = Schema.Struct({
  expectedRevision: AddressRevisionSchema,
  profile: AddressBookProfileSchema,
  reason: AddressActionReasonSchema,
  savedAddressRef: SavedAddressRefSchema,
  source: Schema.optionalKey(SavedAddressSourceAssertionSchema),
}).check(
  Schema.makeFilter(({ profile, savedAddressRef, source }) =>
    savedAddressRef.tenantId === profileTenantId(profile) &&
    (source === undefined || source.nativeAddressId === savedAddressRef.resourceId)
      ? undefined
      : 'The address and profile must belong to the same Tenant',
  ),
);
export type RemoveSavedAddressPayload = typeof RemoveSavedAddressPayloadSchema.Type;
export const RemoveSavedAddressResultSchema = Schema.Struct({
  address: SavedAddressSchema,
  clearedDefaults: Schema.Array(SavedAddressPurposeSchema),
  outcome: Schema.Literals(['REMOVED', 'ALREADY_REMOVED']),
});

export const SetAddressDefaultPayloadSchema = Schema.Struct({
  expectedDefaultsRevision: AddressDefaultsRevisionSchema,
  profile: AddressBookProfileSchema,
  reason: AddressActionReasonSchema,
  savedAddressRef: SavedAddressRefSchema,
}).check(
  Schema.makeFilter(({ profile, savedAddressRef }) =>
    savedAddressRef.tenantId === profileTenantId(profile)
      ? undefined
      : 'The default address and profile must belong to the same Tenant',
  ),
);
export type SetAddressDefaultPayload = typeof SetAddressDefaultPayloadSchema.Type;
export const ClearAddressDefaultPayloadSchema = Schema.Struct({
  expectedDefaultsRevision: AddressDefaultsRevisionSchema,
  profile: AddressBookProfileSchema,
  reason: AddressActionReasonSchema,
});
export type ClearAddressDefaultPayload = typeof ClearAddressDefaultPayloadSchema.Type;
export const SetAddressDefaultResultSchema = Schema.Struct({
  defaults: SavedAddressDefaultsSchema,
  outcome: Schema.Literals(['SET', 'UNCHANGED']),
});
export const ClearAddressDefaultResultSchema = Schema.Union([
  Schema.Struct({
    clearedSavedAddressRef: SavedAddressRefSchema,
    defaults: SavedAddressDefaultsSchema,
    outcome: Schema.Literal('CLEARED'),
  }),
  Schema.Struct({
    defaults: SavedAddressDefaultsSchema,
    outcome: Schema.Literal('ALREADY_CLEAR'),
  }),
]);
