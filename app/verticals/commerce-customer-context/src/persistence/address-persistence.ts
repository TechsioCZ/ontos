import {
  defineScopedRoutine,
  ReadHandlerNotFound,
  ReadHandlerUnavailable,
} from '@app/core-runtime';
import type {
  OperationalScope,
  ScopedRoutineDefinition,
  ScopedRoutineInputValues,
  ScopedRoutineInvocationError,
  ScopedRoutineParameter,
} from '@app/core-runtime';
import { Effect, Schema } from 'effect';

import type {
  SavedAddressDefaultsRequest,
  SavedAddressDefaultsResponse,
} from '../../shared/apis/saved-address-defaults.ts';
import type {
  ProfileReconciliationOwnerVerification,
  ProfileReconciliationOwnerVerificationRequest,
} from '../../shared/actions/resolve-profile-reconciliation.ts';
import type {
  SavedAddressDetailRequest,
  SavedAddressDetailResponse,
} from '../../shared/apis/saved-address-detail.ts';
import type {
  SavedAddressListRequest,
  SavedAddressListResponse,
} from '../../shared/apis/saved-address-list.ts';
import type {
  AddSavedAddressPayload,
  AddSavedAddressResultSchema,
  ClearAddressDefaultPayload,
  ClearAddressDefaultResultSchema,
  RemoveSavedAddressPayload,
  RemoveSavedAddressResultSchema,
  SetAddressDefaultPayload,
  SetAddressDefaultResultSchema,
  UpdateSavedAddressPayload,
  UpdateSavedAddressResultSchema,
} from '../../shared/domain/address-actions.ts';
import { SavedAddressPurposeSchema } from '../../shared/domain/address-book.ts';
import type {
  AddressBookProfile,
  PostalAddress,
  SavedAddress,
  SavedAddressDefaults,
  SavedAddressOrigin,
} from '../../shared/domain/address-book.ts';
import { AddressBookUnavailable } from '../../shared/domain/address-errors.ts';
import type { AddressBookDomainErrorSchema } from '../../shared/domain/address-errors.ts';
import { found, notFound } from '../../shared/domain/address-resolution.ts';
import type {
  AddressDefaultLookup,
  AddressLookup,
  InvoiceRecipientPorts,
  ResolvedSavedPostalAddress,
} from '../../shared/domain/address-resolution.ts';
import type { DeliveryDestinationPorts } from '../../shared/domain/destination-resolution.ts';
import type {
  ProfileReconciliationOwnerEvidenceVerifier,
  ProfileReconciliationOwnerVerificationContext,
} from '../profile-reconciliation-owner-verifier.ts';
import { ProfileReconciliationOwnerVerificationFailure } from '../profile-reconciliation-owner-verifier-error.ts';

/* oxlint-disable effect-native/no-nullable-schema-field -- PostgreSQL object rows intentionally encode SQL NULL as null and are decoded before they enter public address contracts; expires: 2027-03-31. */
const AddressRowSchema = Schema.Struct({
  address_line_1: Schema.NullOr(Schema.String),
  address_line_2: Schema.NullOr(Schema.String),
  administrative_area: Schema.NullOr(Schema.String),
  city: Schema.NullOr(Schema.String),
  cleared_purposes: Schema.Array(SavedAddressPurposeSchema),
  country_code: Schema.NullOr(Schema.String),
  label: Schema.NullOr(Schema.String),
  lifecycle: Schema.NullOr(Schema.Literals(['ACTIVE', 'REMOVED'])),
  outcome: Schema.Literals([
    'ADDED',
    'ALREADY_REMOVED',
    'FOUND',
    'INVALID',
    'NOT_FOUND',
    'PROFILE_NOT_FOUND',
    'RECONCILIATION_REQUIRED',
    'REMOVED',
    'REUSED',
    'REVISION_CONFLICT',
    'SOURCE_TRANSITION_REQUIRED',
    'SUBJECT_MISMATCH',
    'UNCHANGED',
    'UPDATED',
  ]),
  party_contact_point_resource_id: Schema.NullOr(Schema.String),
  party_contact_point_revision: Schema.NullOr(Schema.Int),
  party_resource_id: Schema.NullOr(Schema.String),
  postal_code: Schema.NullOr(Schema.String),
  purposes: Schema.Array(SavedAddressPurposeSchema),
  revision: Schema.Int,
  saved_address_id: Schema.NullOr(Schema.String),
  source_kind: Schema.NullOr(Schema.Literals(['COMMERCE_ONLY', 'PARTY_BACKED'])),
});
type AddressRow = typeof AddressRowSchema.Type;

const AddressDefaultsRowSchema = Schema.Struct({
  billing_saved_address_id: Schema.NullOr(Schema.String),
  cleared_saved_address_id: Schema.NullOr(Schema.String),
  delivery_saved_address_id: Schema.NullOr(Schema.String),
  outcome: Schema.Literals([
    'ALREADY_CLEAR',
    'CLEARED',
    'INVALID',
    'NOT_FOUND',
    'PROFILE_NOT_FOUND',
    'PRESENT',
    'REVISION_CONFLICT',
    'SET',
    'SUBJECT_MISMATCH',
    'UNCHANGED',
  ]),
  revision: Schema.Int,
});
type AddressDefaultsRow = typeof AddressDefaultsRowSchema.Type;
/* oxlint-enable effect-native/no-nullable-schema-field */
type AddressDomainError = typeof AddressBookDomainErrorSchema.Type;
type AddSavedAddressResult = typeof AddSavedAddressResultSchema.Type;
type ClearAddressDefaultResult = typeof ClearAddressDefaultResultSchema.Type;

/* oxlint-disable effect-native/no-nullable-schema-field -- SQL routine outcomes use NULL for absent evidence. */
const AddressReconciliationRowSchema = Schema.Struct({
  after_facts_sha256: Schema.optional(Schema.NullOr(Schema.String)),
  before_facts_sha256: Schema.optional(Schema.NullOr(Schema.String)),
  correlation_ref: Schema.NullOr(Schema.String),
  evidence_ref: Schema.NullOr(Schema.String),
  outcome: Schema.Literals(['CONFLICT', 'NOT_FOUND', 'OWNER_UNAVAILABLE', 'VERIFIED']),
  postcondition_sha256: Schema.optional(Schema.NullOr(Schema.String)),
  receipt_id: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.NullOr(Schema.Literals(['NOT_APPLICABLE', 'RESOLVED'])),
});
/* oxlint-enable effect-native/no-nullable-schema-field */

/** Minimum owner-local capability accepted from Core's scoped transaction. */
export interface CustomerContextAddressRoutineInvoker {
  readonly invoke: <
    RowSchema extends Schema.ConstraintDecoder<object>,
    const Parameters extends readonly ScopedRoutineParameter[],
  >(
    routine: ScopedRoutineDefinition<RowSchema, Parameters>,
    values: ScopedRoutineInputValues<Parameters>,
  ) => Effect.Effect<readonly RowSchema['Type'][], ScopedRoutineInvocationError>;
}

const ownerModuleKey = 'commerce.customer-context';
export const addressBookReconciliationPolicyVersion = 'address-book-reconciliation.v2';
const profileAnotherTenantReason = 'The profile belongs to another Tenant';
const scopeMismatchDependency = 'commerce.customer-context.persistence:scope-mismatch';

const profileParameters = [
  { source: 'tenantId', type: 'uuid' },
  { source: 'legalEntityId', type: 'uuid' },
  { source: 'input', type: 'text' },
  { source: 'input', type: 'text' },
  { nullable: true, source: 'input', type: 'text' },
] as const;

const listSavedAddressesRoutine = defineScopedRoutine({
  name: 'list_saved_addresses',
  ownerModuleKey,
  parameters: profileParameters,
  resultSchema: AddressRowSchema,
  routineKey: 'address-book.list',
  schema: 'commerce_customer_context',
});

const readSavedAddressRoutine = defineScopedRoutine({
  name: 'read_saved_address',
  ownerModuleKey,
  parameters: [...profileParameters, { source: 'input', type: 'text' }] as const,
  resultSchema: AddressRowSchema,
  routineKey: 'address-book.read',
  schema: 'commerce_customer_context',
});

const readAddressDefaultsRoutine = defineScopedRoutine({
  name: 'read_address_defaults',
  ownerModuleKey,
  parameters: profileParameters,
  resultSchema: AddressDefaultsRowSchema,
  routineKey: 'address-book.defaults.read',
  schema: 'commerce_customer_context',
});

const addSavedAddressRoutine = defineScopedRoutine({
  name: 'add_saved_address',
  ownerModuleKey,
  parameters: [
    ...profileParameters,
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'text[]' },
    { nullable: true, source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'integer' },
    { nullable: true, source: 'input', type: 'jsonb' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ] as const,
  resultSchema: AddressRowSchema,
  routineKey: 'address-book.add',
  schema: 'commerce_customer_context',
});

const updateSavedAddressRoutine = defineScopedRoutine({
  name: 'update_saved_address',
  ownerModuleKey,
  parameters: [
    ...profileParameters,
    { source: 'input', type: 'text' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'boolean' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'boolean' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'boolean' },
    { nullable: true, source: 'input', type: 'text[]' },
    { nullable: true, source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'integer' },
    { nullable: true, source: 'input', type: 'jsonb' },
    { source: 'input', type: 'boolean' },
    { nullable: true, source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ] as const,
  resultSchema: AddressRowSchema,
  routineKey: 'address-book.update',
  schema: 'commerce_customer_context',
});

const removeSavedAddressRoutine = defineScopedRoutine({
  name: 'remove_saved_address',
  ownerModuleKey,
  parameters: [
    ...profileParameters,
    { source: 'input', type: 'text' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ] as const,
  resultSchema: AddressRowSchema,
  routineKey: 'address-book.remove',
  schema: 'commerce_customer_context',
});

const changeAddressDefaultRoutine = defineScopedRoutine({
  name: 'change_address_default',
  ownerModuleKey,
  parameters: [
    ...profileParameters,
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ] as const,
  resultSchema: AddressDefaultsRowSchema,
  routineKey: 'address-book.defaults.change',
  schema: 'commerce_customer_context',
});

const recordAddressBookReconciliationReceiptRoutine = defineScopedRoutine({
  name: 'record_address_book_reconciliation_receipt',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'bigint' },
    { source: 'input', type: 'uuid[]' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ] as const,
  resultSchema: AddressReconciliationRowSchema,
  routineKey: 'address-book.reconciliation.receipt-record',
  schema: 'commerce_customer_context',
});

const verifyAddressBookReconciliationRoutine = defineScopedRoutine({
  name: 'verify_address_book_reconciliation',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'bigint' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
  ] as const,
  resultSchema: AddressReconciliationRowSchema,
  routineKey: 'address-book.reconciliation.verify',
  schema: 'commerce_customer_context',
});

const unavailable = (failure: ScopedRoutineInvocationError | string) =>
  new AddressBookUnavailable({
    code: 'address_book_unavailable',
    dependency: Schema.is(Schema.String)(failure)
      ? failure
      : `commerce.customer-context.persistence:${failure.routineKey}`,
    retryable: true,
  });

const invalid = (reason: string): typeof AddressBookDomainErrorSchema.Type => ({
  _tag: 'SavedAddressInvalid',
  code: 'saved_address_invalid',
  reason,
});
const conflict = (reason: string): typeof AddressBookDomainErrorSchema.Type => ({
  _tag: 'SavedAddressConflict',
  code: 'saved_address_conflict',
  reason,
});
const notFoundError = (reason: string): typeof AddressBookDomainErrorSchema.Type => ({
  _tag: 'SavedAddressNotFound',
  code: 'saved_address_not_found',
  reason,
});
const reconciliationRequired = (reason: string): AddressDomainError => ({
  _tag: 'SavedAddressReconciliationRequired',
  code: 'saved_address_reconciliation_required',
  reason,
});
const sourceTransitionRequired = (reason: string): AddressDomainError => ({
  _tag: 'SavedAddressSourceTransitionRequired',
  code: 'saved_address_source_transition_required',
  reason,
});

const profileValues = (profile: AddressBookProfile) =>
  [
    profile.profileRef.resourceId,
    profile.kind,
    profile.kind === 'COUNTERPARTY' ? profile.counterpartyRef.resourceId : null,
  ] as const;

const postalJson = (origin: SavedAddressOrigin | undefined): PostalAddress | null =>
  origin?.kind === 'COMMERCE_ONLY' ? origin.postalAddress : null;

const sourceFields = (origin: SavedAddressOrigin | undefined) => ({
  contactPointResourceId:
    origin?.kind === 'PARTY_BACKED' ? origin.contactPointRef.resourceId : null,
  contactPointRevision: origin?.kind === 'PARTY_BACKED' ? origin.sourceRevision : null,
  partyResourceId: origin?.kind === 'PARTY_BACKED' ? origin.partyRef.resourceId : null,
  postalAddress: postalJson(origin),
  sourceKind: origin?.kind ?? null,
});

const resourceRef = (tenantId: string, resourceId: string) => ({
  moduleId: 'commerce.customer-context' as const,
  resourceId,
  resourceType: 'commerce.customer-context.saved-address' as const,
  tenantId,
});

const originFromRow = (tenantId: string, row: AddressRow): SavedAddressOrigin | undefined => {
  if (
    row.source_kind === 'PARTY_BACKED' &&
    row.party_resource_id !== null &&
    row.party_contact_point_resource_id !== null &&
    row.party_contact_point_revision !== null
  ) {
    return {
      contactPointRef: {
        moduleId: 'party.registry',
        resourceId: row.party_contact_point_resource_id,
        resourceType: 'party.registry.party-contact-point',
        tenantId,
      },
      kind: 'PARTY_BACKED',
      partyRef: {
        moduleId: 'party.registry',
        resourceId: row.party_resource_id,
        resourceType: 'party.registry.party',
        tenantId,
      },
      sourceRevision: row.party_contact_point_revision,
    };
  }
  if (
    row.source_kind === 'COMMERCE_ONLY' &&
    row.address_line_1 !== null &&
    row.city !== null &&
    row.country_code !== null &&
    row.postal_code !== null
  ) {
    const postalAddress = {
      addressLine1: row.address_line_1,
      city: row.city,
      countryCode: row.country_code,
      postalCode: row.postal_code,
    };
    if (row.address_line_2 !== null) {
      return {
        kind: 'COMMERCE_ONLY',
        postalAddress:
          row.administrative_area === null
            ? { ...postalAddress, addressLine2: row.address_line_2 }
            : {
                ...postalAddress,
                addressLine2: row.address_line_2,
                region: row.administrative_area,
              },
      };
    }
    if (row.administrative_area !== null) {
      return {
        kind: 'COMMERCE_ONLY',
        postalAddress: { ...postalAddress, region: row.administrative_area },
      };
    }
    return {
      kind: 'COMMERCE_ONLY',
      postalAddress,
    };
  }
  return undefined;
};

const addressFromRow = (
  profile: AddressBookProfile,
  row: AddressRow,
): Effect.Effect<SavedAddress, AddressBookUnavailable> => {
  const origin = originFromRow(profile.profileRef.tenantId, row);
  if (
    origin === undefined ||
    row.saved_address_id === null ||
    row.lifecycle === null ||
    row.revision < 1 ||
    row.purposes.length === 0
  ) {
    return Effect.fail(unavailable('commerce.customer-context.persistence:invalid-address-row'));
  }
  const address = {
    lifecycle: row.lifecycle,
    origin,
    profile,
    purposes: row.purposes,
    revision: row.revision,
    savedAddressRef: resourceRef(profile.profileRef.tenantId, row.saved_address_id),
  };
  if (row.label !== null) {
    return Effect.succeed({ ...address, label: row.label });
  }
  return Effect.succeed(address);
};

const mapAddressFailure = (
  row: AddressRow | undefined,
): Effect.Effect<never, AddressDomainError> => {
  if (row?.outcome === 'REVISION_CONFLICT') {
    return Effect.fail(
      conflict(`The Saved Address changed concurrently at revision ${row.revision}`),
    );
  }
  if (row?.outcome === 'INVALID') {
    return Effect.fail(invalid('The Saved Address command is invalid for its current state'));
  }
  if (row?.outcome === 'NOT_FOUND' || row?.outcome === 'PROFILE_NOT_FOUND') {
    return Effect.fail(notFoundError('The Saved Address was not found in the verified profile'));
  }
  if (row?.outcome === 'SUBJECT_MISMATCH') {
    return Effect.fail(notFoundError('The Saved Address was not found in the authorized subject'));
  }
  if (row?.outcome === 'RECONCILIATION_REQUIRED') {
    return Effect.fail(
      reconciliationRequired('An equivalent Saved Address requires explicit reconciliation'),
    );
  }
  if (row?.outcome === 'SOURCE_TRANSITION_REQUIRED') {
    return Effect.fail(
      sourceTransitionRequired(
        'Changing Saved Address source ownership requires an explicit transition',
      ),
    );
  }
  return Effect.fail(unavailable('commerce.customer-context.persistence:missing-outcome'));
};

export interface AddressPersistenceAttribution {
  readonly actionInvocationId: string;
  readonly principalId: string;
}

const addedAddressFromRow = (
  profile: AddressBookProfile,
  row: AddressRow,
  outcome: 'ADDED' | 'REUSED',
): Effect.Effect<AddSavedAddressResult, AddressBookUnavailable> =>
  addressFromRow(profile, row).pipe(
    Effect.map((address) =>
      outcome === 'ADDED'
        ? { address, outcome: 'ADDED' as const }
        : { address, outcome: 'REUSED' as const },
    ),
  );

export const addSavedAddress = (
  transaction: CustomerContextAddressRoutineInvoker,
  payload: AddSavedAddressPayload,
  attribution: AddressPersistenceAttribution,
) => {
  const source = sourceFields(payload.origin);
  return transaction
    .invoke(addSavedAddressRoutine, [
      ...profileValues(payload.profile),
      source.sourceKind ?? payload.origin.kind,
      payload.label ?? null,
      payload.purposes,
      source.partyResourceId,
      source.contactPointResourceId,
      source.contactPointRevision,
      source.postalAddress,
      payload.reason,
      attribution.principalId,
      attribution.actionInvocationId,
    ])
    .pipe(
      Effect.mapError(unavailable),
      Effect.flatMap(([row]) => {
        if (row?.outcome === 'ADDED' || row?.outcome === 'REUSED') {
          return addedAddressFromRow(payload.profile, row, row.outcome);
        }
        return mapAddressFailure(row);
      }),
    ) satisfies Effect.Effect<
    typeof AddSavedAddressResultSchema.Type,
    typeof AddressBookDomainErrorSchema.Type
  >;
};

export const updateSavedAddress = (
  transaction: CustomerContextAddressRoutineInvoker,
  payload: UpdateSavedAddressPayload,
  attribution: AddressPersistenceAttribution,
) => {
  const source = sourceFields(payload.origin);
  return transaction
    .invoke(updateSavedAddressRoutine, [
      ...profileValues(payload.profile),
      payload.savedAddressRef.resourceId,
      payload.expectedRevision,
      payload.label !== undefined,
      payload.label ?? null,
      payload.origin !== undefined,
      source.sourceKind,
      payload.purposes !== undefined,
      payload.purposes ?? null,
      source.partyResourceId,
      source.contactPointResourceId,
      source.contactPointRevision,
      source.postalAddress,
      payload.sourceTransition !== undefined,
      payload.sourceTransition?.fromKind ?? null,
      payload.sourceTransition?.toKind ?? null,
      payload.reason,
      attribution.principalId,
      attribution.actionInvocationId,
    ])
    .pipe(
      Effect.mapError(unavailable),
      Effect.flatMap(([row]) =>
        row?.outcome === 'UPDATED' || row?.outcome === 'UNCHANGED'
          ? addressFromRow(payload.profile, row).pipe(
              Effect.map((address) =>
                row.outcome === 'UPDATED'
                  ? ({
                      address,
                      clearedDefaults: row.cleared_purposes,
                      outcome: 'UPDATED',
                    } as const)
                  : ({
                      address,
                      clearedDefaults: row.cleared_purposes,
                      outcome: 'UNCHANGED',
                    } as const),
              ),
            )
          : mapAddressFailure(row),
      ),
    ) satisfies Effect.Effect<
    typeof UpdateSavedAddressResultSchema.Type,
    typeof AddressBookDomainErrorSchema.Type
  >;
};

export const removeSavedAddress = (
  transaction: CustomerContextAddressRoutineInvoker,
  payload: RemoveSavedAddressPayload,
  attribution: AddressPersistenceAttribution,
) =>
  transaction
    .invoke(removeSavedAddressRoutine, [
      ...profileValues(payload.profile),
      payload.savedAddressRef.resourceId,
      payload.expectedRevision,
      payload.reason,
      attribution.principalId,
      attribution.actionInvocationId,
    ])
    .pipe(
      Effect.mapError(unavailable),
      Effect.flatMap(([row]) =>
        row?.outcome === 'REMOVED' || row?.outcome === 'ALREADY_REMOVED'
          ? addressFromRow(payload.profile, row).pipe(
              Effect.map((address) =>
                row.outcome === 'REMOVED'
                  ? ({
                      address,
                      clearedDefaults: row.cleared_purposes,
                      outcome: 'REMOVED',
                    } as const)
                  : ({
                      address,
                      clearedDefaults: row.cleared_purposes,
                      outcome: 'ALREADY_REMOVED',
                    } as const),
              ),
            )
          : mapAddressFailure(row),
      ),
    ) satisfies Effect.Effect<
    typeof RemoveSavedAddressResultSchema.Type,
    typeof AddressBookDomainErrorSchema.Type
  >;

const defaultsFromRow = (
  profile: AddressBookProfile,
  row: AddressDefaultsRow,
): SavedAddressDefaults => {
  const revisionAndProfile = { profile, revision: row.revision };
  const billing =
    row.billing_saved_address_id === null
      ? undefined
      : resourceRef(profile.profileRef.tenantId, row.billing_saved_address_id);
  const delivery =
    row.delivery_saved_address_id === null
      ? undefined
      : resourceRef(profile.profileRef.tenantId, row.delivery_saved_address_id);
  if (billing === undefined) {
    return delivery === undefined ? revisionAndProfile : { ...revisionAndProfile, delivery };
  }
  return delivery === undefined
    ? { ...revisionAndProfile, billing }
    : { ...revisionAndProfile, billing, delivery };
};

const mapDefaultsFailure = (
  row: AddressDefaultsRow | undefined,
): Effect.Effect<never, AddressDomainError> => {
  if (row?.outcome === 'REVISION_CONFLICT') {
    return Effect.fail(
      conflict(`The address defaults changed concurrently at revision ${row.revision}`),
    );
  }
  if (row?.outcome === 'INVALID') {
    return Effect.fail(invalid('The Saved Address is not active and eligible for this default'));
  }
  if (row?.outcome === 'NOT_FOUND' || row?.outcome === 'PROFILE_NOT_FOUND') {
    return Effect.fail(notFoundError('The Saved Address or profile was not found'));
  }
  if (row?.outcome === 'SUBJECT_MISMATCH') {
    return Effect.fail(
      notFoundError('The address defaults were not found in the authorized subject'),
    );
  }
  return Effect.fail(unavailable('commerce.customer-context.persistence:missing-default-outcome'));
};

export const setAddressDefault = (
  transaction: CustomerContextAddressRoutineInvoker,
  payload: SetAddressDefaultPayload,
  purpose: 'BILLING' | 'DELIVERY',
  attribution: AddressPersistenceAttribution,
) =>
  transaction
    .invoke(changeAddressDefaultRoutine, [
      ...profileValues(payload.profile),
      'SET',
      purpose,
      payload.savedAddressRef.resourceId,
      payload.expectedDefaultsRevision,
      payload.reason,
      attribution.principalId,
      attribution.actionInvocationId,
    ])
    .pipe(
      Effect.mapError(unavailable),
      Effect.flatMap(([row]) =>
        row?.outcome === 'SET' || row?.outcome === 'UNCHANGED'
          ? Effect.succeed({
              defaults: defaultsFromRow(payload.profile, row),
              outcome: row.outcome,
            })
          : mapDefaultsFailure(row),
      ),
    ) satisfies Effect.Effect<
    typeof SetAddressDefaultResultSchema.Type,
    typeof AddressBookDomainErrorSchema.Type
  >;

export const clearAddressDefault = (
  transaction: CustomerContextAddressRoutineInvoker,
  payload: ClearAddressDefaultPayload,
  purpose: 'BILLING' | 'DELIVERY',
  attribution: AddressPersistenceAttribution,
): Effect.Effect<ClearAddressDefaultResult, AddressDomainError> => {
  const decodeOutcome = (
    row: AddressDefaultsRow | undefined,
  ): Effect.Effect<ClearAddressDefaultResult, AddressDomainError> => {
    if (row?.outcome === 'ALREADY_CLEAR') {
      return Effect.succeed({
        defaults: defaultsFromRow(payload.profile, row),
        outcome: 'ALREADY_CLEAR',
      });
    }
    if (row?.outcome === 'CLEARED' && row.cleared_saved_address_id !== null) {
      return Effect.succeed({
        clearedSavedAddressRef: resourceRef(
          payload.profile.profileRef.tenantId,
          row.cleared_saved_address_id,
        ),
        defaults: defaultsFromRow(payload.profile, row),
        outcome: 'CLEARED',
      });
    }
    return mapDefaultsFailure(row);
  };
  return transaction
    .invoke(changeAddressDefaultRoutine, [
      ...profileValues(payload.profile),
      'CLEAR',
      purpose,
      null,
      payload.expectedDefaultsRevision,
      payload.reason,
      attribution.principalId,
      attribution.actionInvocationId,
    ])
    .pipe(
      Effect.mapError(unavailable),
      Effect.flatMap(([row]) => decodeOutcome(row)),
    );
};

const ownerVerificationFailure = (
  code: 'OUTCOME_INDETERMINATE' | 'OWNER_UNAVAILABLE',
  reason: string,
  retryable: boolean,
  cause?: unknown,
) => {
  const failure = new ProfileReconciliationOwnerVerificationFailure({
    code,
    owner: 'ADDRESS_BOOK',
    reason,
    retryable,
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', {
      configurable: true,
      value: cause,
    });
  }
  return failure;
};

const addressReconciliationVerificationFromRow = (
  row: typeof AddressReconciliationRowSchema.Type | undefined,
): Effect.Effect<
  ProfileReconciliationOwnerVerification,
  ProfileReconciliationOwnerVerificationFailure
> => {
  if (
    row?.outcome === 'VERIFIED' &&
    row.status !== null &&
    row.evidence_ref !== null &&
    row.correlation_ref !== null
  ) {
    return Effect.succeed({
      _tag: 'VERIFIED',
      correlationRef: row.correlation_ref,
      durableOutcome: {
        evidenceRef: row.evidence_ref,
        owner: 'ADDRESS_BOOK',
        status: row.status,
      },
    });
  }
  if (row?.outcome === 'CONFLICT' || row?.outcome === 'NOT_FOUND') {
    return Effect.succeed({
      _tag: 'CONFLICT',
      owner: 'ADDRESS_BOOK',
      reason:
        row.outcome === 'NOT_FOUND'
          ? 'The exact reconciliation case and survivor membership were not found'
          : 'The losing profiles still own Current address-book state',
    });
  }
  if (row?.outcome === 'OWNER_UNAVAILABLE') {
    return Effect.fail(
      ownerVerificationFailure(
        'OWNER_UNAVAILABLE',
        'Address Book reconciliation evidence is temporarily unavailable',
        true,
      ),
    );
  }
  return Effect.fail(
    ownerVerificationFailure(
      'OUTCOME_INDETERMINATE',
      'Address Book reconciliation verification returned invalid evidence',
      false,
    ),
  );
};

export const addressBookReconciliationOwnerVerifierForTransaction = (
  transaction: CustomerContextAddressRoutineInvoker,
  scope: OperationalScope,
): ProfileReconciliationOwnerEvidenceVerifier => ({
  owner: 'ADDRESS_BOOK',
  verify: (
    request: ProfileReconciliationOwnerVerificationRequest,
    context: ProfileReconciliationOwnerVerificationContext,
  ) => {
    if (
      request.desiredOutcome.owner !== 'ADDRESS_BOOK' ||
      request.caseRef.tenantId !== scope.tenantId ||
      request.survivorProfileRef.tenantId !== scope.tenantId ||
      context.tenantId !== scope.tenantId ||
      context.legalEntityId !== scope.legalEntityId
    ) {
      return Effect.succeed({
        _tag: 'CONFLICT',
        owner: 'ADDRESS_BOOK',
        reason: 'Address Book reconciliation verification scope or owner does not match',
      });
    }
    return transaction
      .invoke(verifyAddressBookReconciliationRoutine, [
        request.caseRef.resourceId,
        request.survivorProfileRef.resourceId,
        request.expectedCaseRevision,
        request.expectedEventVersion,
        request.effectiveAt,
        request.resultingState,
        request.reason,
        context.actorPrincipalId,
        context.actionInvocationId,
        addressBookReconciliationPolicyVersion,
      ])
      .pipe(
        Effect.mapError((failure) =>
          ownerVerificationFailure(
            'OWNER_UNAVAILABLE',
            'Address Book reconciliation evidence is temporarily unavailable',
            true,
            failure,
          ),
        ),
        Effect.flatMap(([row]) => addressReconciliationVerificationFromRow(row)),
      );
  },
});

const validateTenant = (scope: OperationalScope, profile: AddressBookProfile) =>
  profile.profileRef.tenantId === scope.tenantId &&
  (profile.kind === 'RETAIL' || profile.counterpartyRef.tenantId === scope.tenantId);

const validateOriginTenant = (scope: OperationalScope, origin: SavedAddressOrigin | undefined) =>
  origin === undefined ||
  origin.kind === 'COMMERCE_ONLY' ||
  (origin.partyRef.tenantId === scope.tenantId &&
    origin.contactPointRef.tenantId === scope.tenantId);

const validateSavedAddressTenant = (
  scope: OperationalScope,
  profile: AddressBookProfile,
  savedAddressTenantId: string,
) => validateTenant(scope, profile) && savedAddressTenantId === scope.tenantId;

const invokeList = (
  transaction: CustomerContextAddressRoutineInvoker,
  scope: OperationalScope,
  profile: AddressBookProfile,
) => {
  if (!validateTenant(scope, profile)) {
    return Effect.fail(unavailable(scopeMismatchDependency));
  }
  return transaction
    .invoke(listSavedAddressesRoutine, profileValues(profile))
    .pipe(Effect.mapError(unavailable));
};

const invokeDetail = (
  transaction: CustomerContextAddressRoutineInvoker,
  scope: OperationalScope,
  profile: AddressBookProfile,
  resourceId: string,
) => {
  if (!validateTenant(scope, profile)) {
    return Effect.fail(unavailable(scopeMismatchDependency));
  }
  return transaction
    .invoke(readSavedAddressRoutine, [...profileValues(profile), resourceId])
    .pipe(Effect.mapError(unavailable));
};

const invokeDefaults = (
  transaction: CustomerContextAddressRoutineInvoker,
  scope: OperationalScope,
  profile: AddressBookProfile,
) => {
  if (!validateTenant(scope, profile)) {
    return Effect.fail(unavailable(scopeMismatchDependency));
  }
  return transaction
    .invoke(readAddressDefaultsRoutine, profileValues(profile))
    .pipe(Effect.mapError(unavailable));
};

const readUnavailable = (dependency: string, cause?: unknown) => {
  const failure = new ReadHandlerUnavailable({
    code: 'read_handler_unavailable',
    reason: `Address Book dependency unavailable: ${dependency}`,
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', {
      configurable: true,
      value: cause,
    });
  }
  return failure;
};

const detailResponseFromRows = (
  profile: AddressBookProfile,
  rows: readonly AddressRow[],
): Effect.Effect<SavedAddressDetailResponse, ReadHandlerNotFound | ReadHandlerUnavailable> => {
  const [row] = rows;
  if (row === undefined || row.outcome !== 'FOUND' || row.lifecycle !== 'ACTIVE') {
    return Effect.fail(
      new ReadHandlerNotFound({
        code: 'read_handler_not_found',
        reason: 'Saved Address not found',
      }),
    );
  }
  return addressFromRow(profile, row).pipe(
    Effect.mapError((failure) => readUnavailable('persistence', failure)),
    Effect.map((address): SavedAddressDetailResponse => ({ address })),
  );
};

export const addressReadServicesForTransaction = (
  transaction: CustomerContextAddressRoutineInvoker,
  scope: OperationalScope,
) => ({
  defaults: (
    input: SavedAddressDefaultsRequest,
    tenantId: string,
  ): Effect.Effect<SavedAddressDefaultsResponse, ReadHandlerUnavailable> => {
    if (tenantId !== scope.tenantId) {
      return Effect.fail(readUnavailable('scope'));
    }
    return invokeDefaults(transaction, scope, input.profile).pipe(
      Effect.mapError((failure) => readUnavailable('persistence', failure)),
      Effect.flatMap(([row]) =>
        row === undefined || row.outcome !== 'PRESENT'
          ? Effect.fail(readUnavailable('profile'))
          : Effect.succeed({ defaults: defaultsFromRow(input.profile, row) }),
      ),
    );
  },
  detail: (
    input: SavedAddressDetailRequest,
    tenantId: string,
  ): Effect.Effect<SavedAddressDetailResponse, ReadHandlerNotFound | ReadHandlerUnavailable> => {
    if (
      tenantId !== scope.tenantId ||
      !validateSavedAddressTenant(scope, input.profile, input.savedAddressRef.tenantId)
    ) {
      return Effect.fail(readUnavailable('scope'));
    }
    return invokeDetail(transaction, scope, input.profile, input.savedAddressRef.resourceId).pipe(
      Effect.mapError((failure) => readUnavailable('persistence', failure)),
      Effect.flatMap((rows) => detailResponseFromRows(input.profile, rows)),
    );
  },
  list: (
    input: SavedAddressListRequest,
    tenantId: string,
  ): Effect.Effect<SavedAddressListResponse, ReadHandlerUnavailable> => {
    if (tenantId !== scope.tenantId) {
      return Effect.fail(readUnavailable('scope'));
    }
    return invokeList(transaction, scope, input.profile).pipe(
      Effect.mapError((failure) => readUnavailable('persistence', failure)),
      Effect.flatMap((rows) => {
        if (rows[0]?.outcome === 'PROFILE_NOT_FOUND' || rows[0]?.outcome === 'SUBJECT_MISMATCH') {
          return Effect.fail(readUnavailable('profile'));
        }
        const decoders: ReturnType<typeof addressFromRow>[] = [];
        for (const row of rows) {
          if (row.outcome === 'FOUND' && row.lifecycle === 'ACTIVE') {
            decoders.push(addressFromRow(input.profile, row));
          }
        }
        return Effect.all(decoders, { concurrency: 1 }).pipe(
          Effect.mapError((failure) => readUnavailable('persistence', failure)),
          Effect.map((addresses) => ({ addresses })),
        );
      }),
    );
  },
});

export interface AddressExternalResolutionPorts {
  readonly constructPolicyDestination: DeliveryDestinationPorts['constructPolicyDestination'];
  readonly constructPolicyRecipient: InvoiceRecipientPorts['constructPolicyRecipient'];
  readonly loadDeliveryDestinationCurrent: DeliveryDestinationPorts['loadCurrent'];
  readonly loadInvoiceRecipientCurrent: InvoiceRecipientPorts['loadCurrent'];
  readonly resolvePartyPostalAddress: (
    address: SavedAddress,
  ) => Effect.Effect<AddressLookup<ResolvedSavedPostalAddress>, AddressBookUnavailable>;
  readonly resolvePickupDestination: DeliveryDestinationPorts['resolvePickupDestination'];
  readonly validatePickupAvailability: DeliveryDestinationPorts['validatePickupAvailability'];
  readonly validatePostalAvailability: DeliveryDestinationPorts['validatePostalAvailability'];
  readonly validateRecipient: InvoiceRecipientPorts['validateRecipient'];
}

const missingExternal = <A>(dependency: string): Effect.Effect<A, AddressBookUnavailable> =>
  Effect.fail(unavailable(dependency));

export const failClosedAddressExternalResolutionPorts: AddressExternalResolutionPorts = {
  constructPolicyDestination: () => missingExternal('customer-commerce-policy'),
  constructPolicyRecipient: () => missingExternal('customer-commerce-policy'),
  loadDeliveryDestinationCurrent: () => missingExternal('fulfillment-and-purchase-context'),
  loadInvoiceRecipientCurrent: () => missingExternal('party-registry-and-purchase-context'),
  resolvePartyPostalAddress: () => missingExternal('party-registry'),
  resolvePickupDestination: () => missingExternal('pickup-destination-owner'),
  validatePickupAvailability: () => missingExternal('pickup-availability'),
  validatePostalAvailability: () => missingExternal('delivery-availability'),
  validateRecipient: () => missingExternal('tax-and-legal-policy'),
};

/**
 * Composition boundary for owner-published policy/currentness adapters. Missing owners remain
 * explicitly fail-closed, while production composition can supply every dependency without
 * granting the address module a database capability outside its own routines.
 */
export const composeAddressExternalResolutionPorts = (
  configured: Partial<AddressExternalResolutionPorts>,
): AddressExternalResolutionPorts => ({
  ...failClosedAddressExternalResolutionPorts,
  ...configured,
});

const resolvePostalAddress = (
  address: SavedAddress,
  external: AddressExternalResolutionPorts,
): Effect.Effect<AddressLookup<ResolvedSavedPostalAddress>, AddressBookUnavailable> =>
  address.origin.kind === 'COMMERCE_ONLY'
    ? Effect.succeed(
        found({
          kind: 'COMMERCE_ONLY' as const,
          postalAddress: address.origin.postalAddress,
        }),
      )
    : external.resolvePartyPostalAddress(address);

const loadDefaultAddress = (
  transaction: CustomerContextAddressRoutineInvoker,
  scope: OperationalScope,
  profile: AddressBookProfile,
  savedAddressResourceId: string | null,
  invalidReason: string,
): Effect.Effect<AddressDefaultLookup<SavedAddress>, AddressBookUnavailable> => {
  if (savedAddressResourceId === null) {
    return Effect.succeed({ kind: 'NONE' });
  }
  return invokeDetail(transaction, scope, profile, savedAddressResourceId).pipe(
    Effect.flatMap(
      ([row]): Effect.Effect<AddressDefaultLookup<SavedAddress>, AddressBookUnavailable> =>
        row?.outcome === 'FOUND' && row.lifecycle === 'ACTIVE'
          ? addressFromRow(profile, row).pipe(
              Effect.map((address) => ({
                kind: 'FOUND' as const,
                value: address,
              })),
            )
          : Effect.succeed({ kind: 'INVALID', reason: invalidReason }),
    ),
  );
};

export const invoiceRecipientPortsForTransaction = (
  transaction: CustomerContextAddressRoutineInvoker,
  scope: OperationalScope,
  external: AddressExternalResolutionPorts = failClosedAddressExternalResolutionPorts,
): InvoiceRecipientPorts => ({
  constructPolicyRecipient: external.constructPolicyRecipient,
  loadCurrent: external.loadInvoiceRecipientCurrent,
  loadDefaultBillingAddress: (profile) =>
    invokeDefaults(transaction, scope, profile).pipe(
      Effect.flatMap(([defaults]) => {
        if (defaults === undefined || defaults.outcome !== 'PRESENT') {
          return Effect.fail(unavailable('commerce.customer-context.address-profile'));
        }
        return loadDefaultAddress(
          transaction,
          scope,
          profile,
          defaults.billing_saved_address_id,
          'The configured billing default does not resolve to an active address',
        );
      }),
    ),
  loadSavedAddress: ({ profile, resourceId }) =>
    invokeDetail(transaction, scope, profile, resourceId).pipe(
      Effect.flatMap(([row]) =>
        row?.outcome === 'FOUND' && row.lifecycle === 'ACTIVE'
          ? addressFromRow(profile, row).pipe(Effect.map(found))
          : Effect.succeed(notFound<SavedAddress>()),
      ),
    ),
  resolvePostalAddress: (address) => resolvePostalAddress(address, external),
  validateRecipient: external.validateRecipient,
});

export const deliveryDestinationPortsForTransaction = (
  transaction: CustomerContextAddressRoutineInvoker,
  scope: OperationalScope,
  external: AddressExternalResolutionPorts = failClosedAddressExternalResolutionPorts,
): DeliveryDestinationPorts => ({
  constructPolicyDestination: external.constructPolicyDestination,
  loadCurrent: external.loadDeliveryDestinationCurrent,
  loadDefaultDeliveryAddress: (profile) =>
    invokeDefaults(transaction, scope, profile).pipe(
      Effect.flatMap(([defaults]) => {
        if (defaults === undefined || defaults.outcome !== 'PRESENT') {
          return Effect.fail(unavailable('commerce.customer-context.address-profile'));
        }
        return loadDefaultAddress(
          transaction,
          scope,
          profile,
          defaults.delivery_saved_address_id,
          'The configured delivery default does not resolve to an active address',
        );
      }),
    ),
  loadSavedAddress: ({ profile, resourceId }) =>
    invokeDetail(transaction, scope, profile, resourceId).pipe(
      Effect.flatMap(([row]) =>
        row?.outcome === 'FOUND' && row.lifecycle === 'ACTIVE'
          ? addressFromRow(profile, row).pipe(Effect.map(found))
          : Effect.succeed(notFound<SavedAddress>()),
      ),
    ),
  resolvePickupDestination: external.resolvePickupDestination,
  resolvePostalAddress: (address) => resolvePostalAddress(address, external),
  validatePickupAvailability: external.validatePickupAvailability,
  validatePostalAvailability: external.validatePostalAvailability,
});

export const addressActionPersistenceForTransaction = (
  transaction: CustomerContextAddressRoutineInvoker,
  scope: OperationalScope,
  validatePartySource: (
    payload: AddSavedAddressPayload | UpdateSavedAddressPayload,
  ) => Effect.Effect<void, typeof AddressBookDomainErrorSchema.Type> = () =>
    Effect.fail(unavailable('party-registry')),
) => ({
  add: (payload: AddSavedAddressPayload, attribution: AddressPersistenceAttribution) =>
    validateTenant(scope, payload.profile) && validateOriginTenant(scope, payload.origin)
      ? addSavedAddress(transaction, payload, attribution)
      : Effect.fail(notFoundError(profileAnotherTenantReason)),
  clear: (
    payload: ClearAddressDefaultPayload,
    purpose: 'BILLING' | 'DELIVERY',
    attribution: AddressPersistenceAttribution,
  ) =>
    validateTenant(scope, payload.profile)
      ? clearAddressDefault(transaction, payload, purpose, attribution)
      : Effect.fail(notFoundError(profileAnotherTenantReason)),
  remove: (payload: RemoveSavedAddressPayload, attribution: AddressPersistenceAttribution) =>
    validateSavedAddressTenant(scope, payload.profile, payload.savedAddressRef.tenantId)
      ? removeSavedAddress(transaction, payload, attribution)
      : Effect.fail(notFoundError(profileAnotherTenantReason)),
  set: (
    payload: SetAddressDefaultPayload,
    purpose: 'BILLING' | 'DELIVERY',
    attribution: AddressPersistenceAttribution,
  ) =>
    validateSavedAddressTenant(scope, payload.profile, payload.savedAddressRef.tenantId)
      ? setAddressDefault(transaction, payload, purpose, attribution)
      : Effect.fail(notFoundError(profileAnotherTenantReason)),
  update: (payload: UpdateSavedAddressPayload, attribution: AddressPersistenceAttribution) =>
    validateSavedAddressTenant(scope, payload.profile, payload.savedAddressRef.tenantId) &&
    validateOriginTenant(scope, payload.origin)
      ? updateSavedAddress(transaction, payload, attribution)
      : Effect.fail(notFoundError(profileAnotherTenantReason)),
  validatePartySource,
});

export const addressRoutineAllowlist = Object.freeze([
  listSavedAddressesRoutine,
  readSavedAddressRoutine,
  readAddressDefaultsRoutine,
  addSavedAddressRoutine,
  updateSavedAddressRoutine,
  removeSavedAddressRoutine,
  changeAddressDefaultRoutine,
  recordAddressBookReconciliationReceiptRoutine,
  verifyAddressBookReconciliationRoutine,
]);
