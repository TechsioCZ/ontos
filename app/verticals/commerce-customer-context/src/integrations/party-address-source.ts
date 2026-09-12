import {
  PartyContactPointDetailForbiddenProblemSchema,
  PartyContactPointDetailInvalidProblemSchema,
  PartyContactPointDetailNotFoundProblemSchema,
  PartyContactPointDetailPolicyConflictProblemSchema,
  PartyContactPointDetailPolicyProblemSchema,
  executePartyContactPointDetail,
} from '@app/party-registry/api/client';
import { Effect, Schema } from 'effect';

import type { AddSavedAddressPayload, UpdateSavedAddressPayload } from '../../shared/domain/address-actions.ts';
import type { PostalAddress, SavedAddress } from '../../shared/domain/address-book.ts';
import { AddressBookUnavailable } from '../../shared/domain/address-errors.ts';
import type { AddressBookDomainErrorSchema } from '../../shared/domain/address-errors.ts';
import { found, notFound } from '../../shared/domain/address-resolution.ts';
import type { AddressLookup, ResolvedSavedPostalAddress } from '../../shared/domain/address-resolution.ts';

type PartyBackedAddressPayload = AddSavedAddressPayload | UpdateSavedAddressPayload;
type PartyBackedAddressOrigin = Extract<
  NonNullable<PartyBackedAddressPayload['origin']>,
  { readonly kind: 'PARTY_BACKED' }
>;
type PartyContactPointDetailExecutor = typeof executePartyContactPointDetail;
type PartyContactPointDetailResponse = Effect.Success<ReturnType<PartyContactPointDetailExecutor>>;
type PartyContactPointDetailFailure = Effect.Error<ReturnType<PartyContactPointDetailExecutor>>;
type AddressBookDomainError = typeof AddressBookDomainErrorSchema.Type;
type SourceIdentity = Pick<PartyBackedAddressOrigin['partyRef'], 'resourceId' | 'tenantId'>;

const unavailable = (cause: unknown): AddressBookUnavailable => {
  const failure = new AddressBookUnavailable({
    code: 'address_book_unavailable',
    dependency: 'party-registry',
    retryable: true,
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const invalid = (reason: string): AddressBookDomainError => ({
  _tag: 'SavedAddressInvalid',
  code: 'saved_address_invalid',
  reason,
});

const conflict = (reason: string): AddressBookDomainError => ({
  _tag: 'SavedAddressConflict',
  code: 'saved_address_conflict',
  reason,
});

const notFoundError = (reason: string): AddressBookDomainError => ({
  _tag: 'SavedAddressNotFound',
  code: 'saved_address_not_found',
  reason,
});

const definitivePartyFailure = (cause: unknown): AddressBookDomainError | undefined => {
  if (
    Schema.is(PartyContactPointDetailInvalidProblemSchema)(cause) ||
    Schema.is(PartyContactPointDetailPolicyProblemSchema)(cause)
  ) {
    return invalid('Party Registry rejected the postal Contact Point source');
  }
  if (
    Schema.is(PartyContactPointDetailForbiddenProblemSchema)(cause) ||
    Schema.is(PartyContactPointDetailNotFoundProblemSchema)(cause)
  ) {
    return notFoundError('The Party postal Contact Point source was not found');
  }
  if (Schema.is(PartyContactPointDetailPolicyConflictProblemSchema)(cause)) {
    return conflict('The Party postal Contact Point source has a policy conflict');
  }
  // Authentication, unavailable, and internal failures are dependency failures, not durable
  // address facts. Keep them retryable/unavailable instead of turning an outage into not-found.
  return undefined;
};

const validatorFailure = (cause: unknown): AddressBookDomainError =>
  definitivePartyFailure(cause) ?? unavailable(cause);

const hasSameSourceIdentity = (left: SourceIdentity, right: SourceIdentity): boolean =>
  left.tenantId === right.tenantId && left.resourceId === right.resourceId;

const sourceIdentityFailure = (
  payload: PartyBackedAddressPayload,
  origin: PartyBackedAddressOrigin,
  contactPoint: PartyContactPointDetailResponse,
): AddressBookDomainError | undefined => {
  if (
    !hasSameSourceIdentity(contactPoint.contactPointRef, origin.contactPointRef) ||
    !hasSameSourceIdentity(contactPoint.partyRef, origin.partyRef)
  ) {
    return invalid('Party Registry returned a different postal Contact Point source');
  }
  const profileTenantId = payload.profile.profileRef.tenantId;
  if (origin.partyRef.tenantId !== profileTenantId || origin.contactPointRef.tenantId !== profileTenantId) {
    return invalid('The Party-backed address source belongs to another Tenant');
  }
  return undefined;
};

const isCurrentPostalContactPoint = (contactPoint: PartyContactPointDetailResponse): boolean =>
  contactPoint.current &&
  contactPoint.state === 'ACTIVE' &&
  contactPoint.validTo === null &&
  contactPoint.value.type === 'ADDRESS';

const postalSourceFailure = (
  origin: PartyBackedAddressOrigin,
  contactPoint: PartyContactPointDetailResponse,
): AddressBookDomainError | undefined => {
  if (!isCurrentPostalContactPoint(contactPoint)) {
    return invalid('The Party-backed address source is not a Current postal address');
  }
  return contactPoint.revision === origin.sourceRevision
    ? undefined
    : invalid('The Party-backed address source revision is stale');
};

const validateCurrentPostalSource = (
  payload: PartyBackedAddressPayload,
  contactPoint: PartyContactPointDetailResponse,
): Effect.Effect<void, AddressBookDomainError> => {
  const { origin } = payload;
  if (origin === undefined || origin.kind !== 'PARTY_BACKED') {
    return Effect.void;
  }
  const failure = sourceIdentityFailure(payload, origin, contactPoint) ?? postalSourceFailure(origin, contactPoint);
  return failure === undefined ? Effect.void : Effect.fail(failure);
};

export const partyBackedAddressSourceValidator =
  (requestCorrelation: string, execute: PartyContactPointDetailExecutor = executePartyContactPointDetail) =>
  (payload: PartyBackedAddressPayload): Effect.Effect<void, AddressBookDomainError> => {
    const { origin } = payload;
    if (origin === undefined || origin.kind !== 'PARTY_BACKED') {
      return Effect.void;
    }
    return execute({ contactPointRef: origin.contactPointRef }, requestCorrelation).pipe(
      Effect.mapError(validatorFailure),
      Effect.flatMap((contactPoint) => validateCurrentPostalSource(payload, contactPoint)),
    );
  };

const postalAddressFromContactPoint = (contactPoint: PartyContactPointDetailResponse): PostalAddress | undefined => {
  if (contactPoint.value.type !== 'ADDRESS') {
    return undefined;
  }
  const { addressLine1, addressLine2, city, countryCode, postalCode, region } = contactPoint.value.address;
  if (addressLine1 === null || city === null || postalCode === null) {
    return undefined;
  }
  const requiredAddress = {
    addressLine1,
    city,
    countryCode,
    postalCode,
  };
  if (addressLine2 !== null && region !== null) {
    return { ...requiredAddress, addressLine2, region };
  }
  if (addressLine2 !== null) {
    return { ...requiredAddress, addressLine2 };
  }
  return region === null ? requiredAddress : { ...requiredAddress, region };
};

const hasResolvablePartyIdentity = (
  origin: PartyBackedAddressOrigin,
  contactPoint: PartyContactPointDetailResponse,
): boolean =>
  contactPoint.partyRef.tenantId === origin.partyRef.tenantId &&
  contactPoint.storedPartyRef.tenantId === origin.partyRef.tenantId &&
  (contactPoint.partyRef.resourceId === origin.partyRef.resourceId ||
    contactPoint.storedPartyRef.resourceId === origin.partyRef.resourceId);

const resolvePartyBackedPostalAddress = (
  origin: PartyBackedAddressOrigin,
  contactPoint: PartyContactPointDetailResponse,
): AddressLookup<ResolvedSavedPostalAddress> => {
  const postalAddress = postalAddressFromContactPoint(contactPoint);
  if (
    !hasSameSourceIdentity(contactPoint.contactPointRef, origin.contactPointRef) ||
    !hasResolvablePartyIdentity(origin, contactPoint) ||
    !isCurrentPostalContactPoint(contactPoint) ||
    postalAddress === undefined
  ) {
    return notFound<ResolvedSavedPostalAddress>();
  }
  return found({
    currentContactPointRef: contactPoint.contactPointRef,
    currentPartyRef: contactPoint.partyRef,
    currentSourceRevision: contactPoint.revision,
    kind: 'PARTY_BACKED' as const,
    postalAddress,
  });
};

const resolverFailure = (
  error: PartyContactPointDetailFailure,
): Effect.Effect<AddressLookup<ResolvedSavedPostalAddress>, AddressBookUnavailable> =>
  definitivePartyFailure(error) === undefined
    ? Effect.fail(unavailable(error))
    : Effect.succeed(notFound<ResolvedSavedPostalAddress>());

export const partyBackedPostalAddressResolver =
  (requestCorrelation: string, execute: PartyContactPointDetailExecutor = executePartyContactPointDetail) =>
  (address: SavedAddress): Effect.Effect<AddressLookup<ResolvedSavedPostalAddress>, AddressBookUnavailable> => {
    if (address.origin.kind === 'COMMERCE_ONLY') {
      return Effect.succeed(
        found({
          kind: 'COMMERCE_ONLY' as const,
          postalAddress: address.origin.postalAddress,
        }),
      );
    }
    const { origin } = address;
    return execute({ contactPointRef: origin.contactPointRef }, requestCorrelation).pipe(
      Effect.map((contactPoint) => resolvePartyBackedPostalAddress(origin, contactPoint)),
      // oxlint-disable-next-line promise/prefer-await-to-then -- Effect's typed catch combinator is not Promise chaining.
      Effect.catch(resolverFailure),
    );
  };
