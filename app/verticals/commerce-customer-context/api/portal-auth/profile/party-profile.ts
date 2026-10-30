import {
  AddContactPointPayloadSchema,
  PartyCommandConflictProblemSchema,
  normalizePhone,
  UpdateContactPointPayloadSchema,
  UpdatePartyPayloadSchema,
} from '@app/party-registry/api';
import type { PartyContactPointsResponse, PartyDetailResponse } from '@app/party-registry/api';
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
import { Crypto, DateTime, Effect, Option, Redacted, Schema } from 'effect';
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
    .filter((item) => item.current && item.state === 'ACTIVE' && item.value.type === type)
    .toSorted(
      (a, b) =>
        Number(b.value.type !== 'ADDRESS' && b.value.preferred) -
          Number(a.value.type !== 'ADDRESS' && a.value.preferred) ||
        a.contactPointRef.resourceId.localeCompare(b.contactPointRef.resourceId),
    )[0];
const display = (contact: Contact | undefined) =>
  contact === undefined || contact.value.type === 'ADDRESS' ? '' : contact.value.displayValue;

export const projectCustomerOwnProfile = (
  detail: PartyDetailResponse,
  contacts: PartyContactPointsResponse,
): CustomerOwnProfile => ({
  contactEmail: display(selectProfileContact(contacts.items, 'EMAIL')),
  displayName: Option.getOrElse(detail.party.displayName, () => ''),
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
            .toSorted((left, right) => left.contactPointRef.resourceId.localeCompare(right.contactPointRef.resourceId))
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

export const readCustomerPartyProfile = Effect.fn('CustomerOwnProfile.readParty')(function* readParty(
  scope: CustomerPartyProfileScope,
) {
  const partyRef: PartyRef = {
    moduleId: 'party.registry',
    resourceId: scope.partyId,
    resourceType: 'party.registry.party',
    tenantId: scope.tenantId,
  };
  const detailGateway = yield* acquireRetailPartyGateway(scope).pipe(Effect.mapError(profileUnavailable));
  const detail = yield* executePartyDetailWithAuthorization(
    { partyRef },
    Redacted.value(detailGateway.credential),
    scope.requestCorrelation,
    detailGateway.options,
  ).pipe(Effect.mapError(profileUnavailable));
  // A merge/alias requires reconciliation of the account binding; it is not authority to choose another Party.
  if (
    !sameParty(detail.party.partyRef, partyRef) ||
    detail.resolution.kind !== 'DIRECT' ||
    Option.isSome(detail.party.archivedAt)
  ) {
    return yield* Effect.fail(profileConflict());
  }
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
  return { contacts, detail, partyRef, profile: projectCustomerOwnProfile(detail, contacts) };
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
  // Validate the complete phone intent before any native command can commit a different field.
  // Empty means removal; nonempty values use the owner's exact national/international rules.
  if (input.phone !== '') {
    yield* Effect.try({
      catch: profileInvalid,
      try: () => normalizePhone(input.phone, input.phone.startsWith('+') ? undefined : 'CZ'),
    });
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
    return yield* execute(gateway.credential, {
      ...gateway.options,
      correlationId: scope.requestCorrelation,
      idempotencyKey: yield* crypto.randomUUIDv4().pipe(Effect.mapError(profileUnavailable)),
    }).pipe(
      Effect.mapError((failure) =>
        Schema.is(PartyCommandConflictProblemSchema)(failure) ? profileConflict() : profileUnavailable(),
      ),
    );
  });
  if (input.displayName !== before.profile.displayName) {
    const payload = yield* Schema.decodeEffect(UpdatePartyPayloadSchema)({
      displayName: input.displayName,
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
        verification: { state: 'UNVERIFIED' },
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
    after.profile.displayName !== input.displayName ||
    after.profile.phone !== input.phone ||
    after.profile.contactEmail !== input.contactEmail
  ) {
    return yield* Effect.fail(profileConflict());
  }
  return after.profile;
});
