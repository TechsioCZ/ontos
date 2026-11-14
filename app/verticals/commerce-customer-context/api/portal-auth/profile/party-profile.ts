import {
  AddContactPointPayloadSchema,
  PartyCommandConflictProblemSchema,
  UpdateContactPointPayloadSchema,
  UpdatePartyPayloadSchema,
} from '@app/party-registry/api';
import type { PartyContactPointsResponse, PartyDetailResponse } from '@app/party-registry/api';
import { normalizeContactPhone } from '@app/party-registry/domain/contact-phone-normalization';
import {
  addContactPointWithAuthorization,
  executePartyContactPointsWithAuthorization,
  executePartyDetailWithAuthorization,
  updateContactPointWithAuthorization,
  updatePartyWithAuthorization,
} from '@app/party-registry/api/client';
import type { PartyRef } from '@app/party-registry/resources/party';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Crypto, DateTime, Effect, Option, Predicate, Redacted, Result, Schema } from 'effect';
import { Hex } from 'effect/encoding';
import { acquireRetailPartyGateway } from '../../../src/enrollment/journeys/retail-self-enrollment-party-owner.ts';
import type { RetailPartyCandidateOwnerInput } from '../../../src/enrollment/journeys/retail-self-enrollment-party-owner.ts';
import type { CustomerOwnProfile, UpdateCustomerOwnProfile } from '../../../shared/portal-auth/profile-api.ts';
import { profileConflict, profileInvalid, profileUnavailable } from './problems.ts';

type Contact = PartyContactPointsResponse['items'][number];
type ProfileCommandError = Effect.Error<ReturnType<typeof updatePartyWithAuthorization>>;
export interface CustomerPartyProfileScope extends Pick<
  RetailPartyCandidateOwnerInput,
  'compositionRevision' | 'legalEntityId' | 'requestCorrelation' | 'tenantId'
> {
  readonly partyId: string;
}
const sameParty = (left: PartyRef, right: PartyRef) =>
  left.tenantId === right.tenantId && left.resourceId === right.resourceId;

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

/** The account's own Party, read directly. A merge, alias or archive needs owner reconciliation, not a successor. */
export const readDirectCustomerParty = Effect.fn('CustomerOwnProfile.readDirectParty')(function* readDirectParty(
  scope: CustomerPartyProfileScope,
) {
  const partyRef: PartyRef = {
    moduleId: 'party.registry',
    resourceId: scope.partyId,
    resourceType: 'party.registry.party',
    tenantId: scope.tenantId,
  };
  const gateway = yield* acquireRetailPartyGateway(scope).pipe(Effect.mapError(profileUnavailable));
  const detail = yield* executePartyDetailWithAuthorization(
    { partyRef },
    Redacted.value(gateway.credential),
    scope.requestCorrelation,
    gateway.options,
  ).pipe(Effect.mapError(profileUnavailable));
  if (
    !sameParty(detail.party.partyRef, partyRef) ||
    detail.resolution.kind !== 'DIRECT' ||
    !sameParty(detail.resolution.requestedPartyRef, partyRef) ||
    !sameParty(detail.resolution.canonicalPartyRef, partyRef) ||
    detail.resolution.aliasChain.length !== 0 ||
    detail.party.partyType !== 'PERSON' ||
    Option.isSome(detail.party.archivedAt)
  ) {
    return yield* Effect.fail(profileConflict());
  }
  return { detail, partyRef };
});

export const readCustomerPartyProfile = Effect.fn('CustomerOwnProfile.readParty')(function* readParty(
  scope: CustomerPartyProfileScope,
) {
  const { detail, partyRef } = yield* readDirectCustomerParty(scope);
  const contactGateway = yield* acquireRetailPartyGateway(scope).pipe(Effect.mapError(profileUnavailable));
  const contacts = yield* executePartyContactPointsWithAuthorization(
    { includeHistorical: false, partyRef },
    Redacted.value(contactGateway.credential),
    scope.requestCorrelation,
    contactGateway.options,
  ).pipe(Effect.mapError(profileUnavailable));
  if (contacts.items.some((item) => !sameParty(item.partyRef, partyRef))) {
    return yield* Effect.fail(profileUnavailable());
  }
  const profile = yield* Effect.fromResult(projectCustomerOwnProfile(detail, contacts));
  return { contacts, detail, partyRef, profile };
});

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

/** Native expected revisions guard edits; each submission is one attempt, never an automatic retry. */
export const updateCustomerPartyProfile = Effect.fn('CustomerOwnProfile.updateParty')(function* updateParty(
  scope: CustomerPartyProfileScope,
  input: UpdateCustomerOwnProfile,
  before: Effect.Success<ReturnType<typeof readCustomerPartyProfile>>,
) {
  if (before.profile.version !== input.version) {
    return yield* Effect.fail(profileConflict());
  }
  let nameFields: Effect.Success<ReturnType<typeof customerPersonalNameFields>> | undefined;
  if (input.displayName !== before.profile.displayName) {
    const { lastName } = before.detail.party;
    if (lastName === undefined) {
      return yield* Effect.fail(profileUnavailable());
    }
    nameFields = yield* customerPersonalNameFields(input.displayName, lastName);
  }
  const requestedDisplayName =
    nameFields === undefined
      ? input.displayName
      : [nameFields.firstName, nameFields.lastName].filter((part) => part !== undefined).join(' ');
  // Validate the complete phone intent before any native command can commit a different field.
  // Empty means removal; nonempty values use the owner's exact national/international rules.
  if (input.phone !== '') {
    const normalization = normalizeContactPhone(input.phone, input.phone.startsWith('+') ? undefined : 'CZ');
    if (!normalization.ok) {
      return yield* Effect.fail(profileInvalid());
    }
  }
  const validFrom = DateTime.formatIso(yield* DateTime.now);
  const evidenceReference = `commerce.customer-profile:${scope.requestCorrelation}`;
  const provenance = {
    authoritative: false,
    evidenceReference,
    method: 'DECLARED_BY_PARTY',
    source: 'PARTY_DECLARATION',
  } as const;
  const command = Effect.fn('CustomerOwnProfile.nativeCommand')(function* nativeCommand(
    execute: (
      authorization: Redacted.Redacted,
      options: Parameters<typeof updatePartyWithAuthorization>[2],
    ) => Effect.Effect<unknown, ProfileCommandError>,
  ) {
    const gateway = yield* acquireRetailPartyGateway(scope).pipe(Effect.mapError(profileUnavailable));
    const crypto = yield* Crypto.Crypto;
    const result = yield* execute(gateway.credential, {
      ...gateway.options,
      correlationId: scope.requestCorrelation,
      idempotencyKey: yield* crypto.randomUUIDv4().pipe(Effect.mapError(profileUnavailable)),
    }).pipe(
      Effect.mapError((failure) =>
        Schema.is(PartyCommandConflictProblemSchema)(failure) ? profileConflict() : profileUnavailable(),
      ),
    );
    if (Predicate.isTagged(result, 'ActionProposalAccepted')) {
      return yield* Effect.fail(profileUnavailable());
    }
    return result;
  });
  if (input.displayName !== before.profile.displayName) {
    const payload = yield* Schema.decodeEffect(UpdatePartyPayloadSchema)({
      ...nameFields,
      expectedRevision: before.detail.party.revision,
      partyRef: before.partyRef,
      provenanceMethod: 'DECLARED_BY_PARTY',
      provenanceSource: 'commerce.customer-context',
      validFrom,
    }).pipe(Effect.mapError(profileUnavailable));
    yield* command((credential, options) => updatePartyWithAuthorization(payload, Redacted.value(credential), options));
  }
  yield* Effect.forEach(
    ['PHONE', 'EMAIL'] as const,
    Effect.fn('CustomerOwnProfile.updateContact')(function* updateContact(type) {
      const value = type === 'PHONE' ? input.phone : input.contactEmail;
      if (value === (type === 'PHONE' ? before.profile.phone : before.profile.contactEmail)) {
        return;
      }
      const current = selectProfileContact(before.contacts.items, type);
      const channel = { preferred: true, type, value };
      const contactPoint = type === 'PHONE' && !value.startsWith('+') ? { countryCode: 'CZ', ...channel } : channel;
      const replacement = {
        contactPoint,
        privacyClassification: 'PERSONAL',
        provenance,
        validFrom,
      };
      if (current === undefined) {
        if (value === '') {
          return;
        }
        const payload = yield* Schema.decodeUnknownEffect(AddContactPointPayloadSchema)({
          ...replacement,
          partyRef: before.partyRef,
        }).pipe(Effect.mapError(profileUnavailable));
        yield* command((authorization, options) =>
          addContactPointWithAuthorization(payload, Redacted.value(authorization), options),
        );
      } else {
        const correction = {
          evidenceReferences: [evidenceReference],
          reason: 'Customer corrected their own contact through an admitted Commerce portal session',
          type: 'CORRECT_CONTACT_POINT',
        } as const;
        const payload = yield* Schema.decodeUnknownEffect(UpdateContactPointPayloadSchema)({
          change: value === '' ? correction : { ...correction, replacement },
          contactPointRef: current.contactPointRef,
          expectedRevision: current.revision,
          provenance,
        }).pipe(Effect.mapError(profileUnavailable));
        yield* command((authorization, options) =>
          updateContactPointWithAuthorization(payload, Redacted.value(authorization), options),
        );
      }
    }),
    { concurrency: 1, discard: true },
  );
  const after = yield* readCustomerPartyProfile(scope);
  if (
    after.profile.displayName !== requestedDisplayName ||
    after.profile.phone !== input.phone ||
    after.profile.contactEmail !== input.contactEmail
  ) {
    return yield* Effect.fail(profileConflict());
  }
  return after.profile;
});
