import type { OperationalScope } from '@app/core-runtime/operations/context';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import {
  RetailCustomerIdentityViewSchema,
  RetailCustomerProfileViewSchema,
  RetailCustomerProfilePolicyConflictProblemSchema,
  RetailCustomerProfileDomainConflictProblemSchema,
  UpdateRetailCustomerProfileActionConflictProblemSchema,
  UpdateRetailCustomerProfileActionInvalidProblemSchema,
} from '@app/party-registry/api';
import type {
  PartyContactPointsResponse,
  PartyDetailResponse,
  RetailCustomerProfileAttestation,
} from '@app/party-registry/api';
import {
  executeRetailCustomerProfileWithAuthorization,
  executeUpdateRetailCustomerProfileWithAuthorization,
} from '@app/party-registry/api/client';
import { normalizeContactPhone } from '@app/party-registry/domain/contact-phone-normalization';
import type { PartyRef } from '@app/party-registry/resources/party';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Crypto, Effect, Option, Predicate, Result, Schema } from 'effect';
import { Hex } from 'effect/encoding';
import type { CustomerOwnProfile, UpdateCustomerOwnProfile } from '../../../shared/portal-auth/profile-api.ts';
import { profileConflict, profileInvalid, profileUnavailable } from './problems.ts';

type Contact = PartyContactPointsResponse['items'][number];
export interface CustomerPartyProfileScope {
  readonly admittedScope: OperationalScope;
  readonly attestation: RetailCustomerProfileAttestation;
  readonly compositionRevision: string;
  readonly legalEntityId: string;
  readonly partyId: string;
  readonly requestCorrelation: string;
  readonly tenantId: string;
}
const sameParty = (scope: CustomerPartyProfileScope, party: PartyRef) =>
  party.tenantId === scope.tenantId && party.resourceId === scope.partyId;

/** Fresh assertion delegation preserves the admitted source workload and selling company. */
const acquireOwnProfileGateway = Effect.fn('CustomerOwnProfile.acquireGateway')(function* acquire(
  scope: CustomerPartyProfileScope,
) {
  if (
    scope.admittedScope.tenantId !== scope.tenantId ||
    scope.admittedScope.legalEntityId !== scope.legalEntityId ||
    scope.attestation.tenantId !== scope.tenantId ||
    scope.attestation.sellingLegalEntityId !== scope.legalEntityId ||
    scope.attestation.partyId !== scope.partyId
  ) {
    return yield* Effect.fail(profileUnavailable());
  }
  const crypto = yield* Crypto.Crypto;
  const issued = yield* acquireDelegatedGatewayContext(
    {
      audience: 'party-registry',
      callingAppId: 'commerce-customer-context',
      legalEntityScope: 'subject',
      requestCorrelation: scope.requestCorrelation,
      subject: { _tag: 'Assertion', scope: scope.admittedScope },
    },
    crypto,
  ).pipe(Effect.mapError(profileUnavailable));
  if (issued.compositionRevision !== scope.compositionRevision) {
    return yield* Effect.fail(profileUnavailable());
  }
  return issued;
});

/** Canonical identity validation is independent of names and contact availability. */
export const readDirectCustomerParty = Effect.fn('CustomerOwnProfile.readDirectParty')(function* read(
  scope: CustomerPartyProfileScope,
) {
  const gateway = yield* acquireOwnProfileGateway(scope);
  const result = yield* executeRetailCustomerProfileWithAuthorization(
    { attestation: scope.attestation, view: 'IDENTITY' },
    gateway.authorization,
    scope.requestCorrelation,
    { baseUrl: gateway.apiBaseUrl, compositionRevision: gateway.compositionRevision },
  ).pipe(
    Effect.mapError((failure) =>
      Schema.is(
        Schema.Union([
          RetailCustomerProfilePolicyConflictProblemSchema,
          RetailCustomerProfileDomainConflictProblemSchema,
        ]),
      )(failure)
        ? profileConflict()
        : profileUnavailable(),
    ),
  );
  if (!Schema.is(RetailCustomerIdentityViewSchema)(result) || !sameParty(scope, result.partyRef)) {
    return yield* Effect.fail(profileConflict());
  }
  return { partyRef: result.partyRef };
});

export const readCustomerPartyProfile = Effect.fn('CustomerOwnProfile.readParty')(function* read(
  scope: CustomerPartyProfileScope,
) {
  const gateway = yield* acquireOwnProfileGateway(scope);
  const result = yield* executeRetailCustomerProfileWithAuthorization(
    { attestation: scope.attestation, view: 'PROFILE' },
    gateway.authorization,
    scope.requestCorrelation,
    { baseUrl: gateway.apiBaseUrl, compositionRevision: gateway.compositionRevision },
  ).pipe(
    Effect.mapError((failure) =>
      Schema.is(
        Schema.Union([
          RetailCustomerProfilePolicyConflictProblemSchema,
          RetailCustomerProfileDomainConflictProblemSchema,
        ]),
      )(failure)
        ? profileConflict()
        : profileUnavailable(),
    ),
  );
  if (!Schema.is(RetailCustomerProfileViewSchema)(result) || !sameParty(scope, result.partyRef)) {
    return yield* Effect.fail(profileUnavailable());
  }
  return { partyRef: result.partyRef, profile: result.profile };
});

/** Stable preference selection, not a browser-chosen contact reference. */
export const selectProfileContact = (items: readonly Contact[], type: 'EMAIL' | 'PHONE') =>
  items
    .flatMap((item) => {
      const { value } = item;
      return item.current &&
        item.state === 'ACTIVE' &&
        value !== undefined &&
        value.type !== 'ADDRESS' &&
        value.type === type
        ? [{ ...item, value }]
        : [];
    })
    .toSorted(
      (left, right) =>
        Number(right.value.preferred) - Number(left.value.preferred) ||
        left.contactPointRef.resourceId.localeCompare(right.contactPointRef.resourceId),
    )[0];
const display = (contact: ReturnType<typeof selectProfileContact>) => contact?.value.displayValue ?? '';

export const projectCustomerOwnProfile = (
  detail: PartyDetailResponse,
  contacts: PartyContactPointsResponse,
): Result.Result<CustomerOwnProfile, ReturnType<typeof profileUnavailable>> => {
  const { displayName } = detail.party;
  if (
    displayName === undefined ||
    contacts.items.some((item) => item.current && item.state === 'ACTIVE' && item.value === undefined)
  ) {
    return Result.fail(profileUnavailable());
  }
  return Result.succeed({
    contactEmail: display(selectProfileContact(contacts.items, 'EMAIL')),
    displayName: Option.getOrElse(displayName, () => ''),
    phone: display(selectProfileContact(contacts.items, 'PHONE')),
    // Includes every returned contact revision: adding/changing the preferred contact invalidates an edit too.
    version: Hex.encode(
      sha256(
        utf8ToBytes(
          // UUIDs, integer revisions and closed lifecycle literals cannot contain the NUL separator.
          [
            detail.party.partyRef.tenantId,
            detail.party.partyRef.resourceId,
            String(detail.party.revision),
            ...contacts.items
              .toSorted((left, right) =>
                left.contactPointRef.resourceId.localeCompare(right.contactPointRef.resourceId),
              )
              .flatMap((item) => [
                item.contactPointRef.resourceId,
                String(item.revision),
                String(item.current),
                item.state,
              ]),
          ].join('\0'),
        ),
      ),
    ),
  });
};

/** Party derives the visible name from sparse personal-name facts; omission never clears a surname. */
export const customerPersonalNameFields = Effect.fn('CustomerOwnProfile.personalNameFields')(function* nameFields(
  displayName: string,
  currentLastName: Option.Option<string>,
) {
  const [firstName = '', ...rest] = displayName.trim().split(/\s+/u);
  if (firstName === '' || (rest.length === 0 && Option.isSome(currentLastName))) {
    // Main's sparse name update cannot erase an existing fact. Refuse before any other profile field commits.
    return yield* Effect.fail(profileInvalid());
  }
  return rest.length === 0 ? { firstName } : { firstName, lastName: rest.join(' ') };
});

/** A single atomic native Party command; no automatic retry or sequence of independently committed changes. */
export const updateCustomerPartyProfile = Effect.fn('CustomerOwnProfile.updateParty')(function* update(
  scope: CustomerPartyProfileScope,
  input: UpdateCustomerOwnProfile,
  before: { readonly profile: CustomerOwnProfile },
) {
  if (before.profile.version !== input.version) {
    return yield* Effect.fail(profileConflict());
  }
  if (input.phone !== '' && !normalizeContactPhone(input.phone, input.phone.startsWith('+') ? undefined : 'CZ').ok) {
    return yield* Effect.fail(profileInvalid());
  }
  const gateway = yield* acquireOwnProfileGateway(scope);
  const crypto = yield* Crypto.Crypto;
  const idempotencyKey = yield* crypto.randomUUIDv4().pipe(Effect.mapError(profileUnavailable));
  const result = yield* executeUpdateRetailCustomerProfileWithAuthorization(
    { attestation: scope.attestation, update: input },
    gateway.authorization,
    scope.requestCorrelation,
    { baseUrl: gateway.apiBaseUrl, compositionRevision: gateway.compositionRevision, idempotencyKey },
  ).pipe(
    Effect.mapError((failure) => {
      if (Schema.is(UpdateRetailCustomerProfileActionConflictProblemSchema)(failure)) {
        return profileConflict();
      }
      return Schema.is(UpdateRetailCustomerProfileActionInvalidProblemSchema)(failure)
        ? profileInvalid()
        : profileUnavailable();
    }),
  );
  if (Predicate.isTagged(result, 'ActionProposalAccepted') || !sameParty(scope, result.partyRef)) {
    return yield* Effect.fail(profileUnavailable());
  }
  return result.profile;
});
