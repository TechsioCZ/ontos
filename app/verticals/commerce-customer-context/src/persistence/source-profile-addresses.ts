import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { defineScopedRoutine, ReadHandlerUnavailable, ReadPermissionDenied } from '@app/core-runtime';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import { Effect, Predicate, Schema } from 'effect';

import type { CustomerProfileSourceItem } from '../../shared/apis/customer-profile-source.ts';
import { AddressBookProfileSchema, ActiveSavedAddressSchema } from '../../shared/domain/address-book.ts';
import type { AddressBookProfile } from '../../shared/domain/address-book.ts';
import { SavedAddressSourceAssertionSchema } from '../../shared/domain/saved-address-source.ts';
import { SavedAddressRefSchema } from '../../shared/resources/saved-address.ts';
import { savedAddressSourceReadService } from '../services/saved-address-source.service.ts';
import { addressReadServicesForTransaction } from './address-persistence.ts';

const candidateSchema = Schema.Struct({
  savedAddressId: SavedAddressRefSchema.fields.resourceId,
  source: Schema.Unknown,
});

interface AddressProjection {
  readonly addresses: (typeof ActiveSavedAddressSchema.Type)[];
  readonly seen: Set<string>;
}

const candidatesRoutine = defineScopedRoutine({
  name: 'read_source_profile_address_candidates',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: Schema.Struct({
    candidates: Schema.Array(candidateSchema),
    outcome: Schema.Literals(['AVAILABLE', 'SOURCE_AUTHORITY_DENIED']),
  }),
  routineKey: 'saved-address-source.candidates',
  schema: 'commerce_customer_context',
});

const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'Current source-owned addresses are unavailable',
    }),
    'cause',
    { configurable: true, value: cause },
  );

export const projectSourceProfileAddresses = Effect.fn('CustomerProfileSourceRead.addressValues')(
  function* addressValues(
    candidates: readonly (typeof candidateSchema.Type)[],
    profile: AddressBookProfile,
    tenantId: string,
    current: ReturnType<typeof savedAddressSourceReadService>,
    values: Pick<ReturnType<typeof addressReadServicesForTransaction>, 'detail'>,
  ) {
    if (candidates.length > 256 || profile.profileRef.tenantId !== tenantId) {
      return yield* unavailable();
    }
    return yield* Effect.reduce(
      candidates,
      (): AddressProjection => ({
        addresses: [],
        seen: new Set<string>(),
      }),
      Effect.fnUntraced(function* projectCandidate(projection, candidate) {
        if (projection.seen.has(candidate.savedAddressId)) {
          return projection;
        }
        projection.seen.add(candidate.savedAddressId);
        const source = yield* Schema.decodeUnknownEffect(SavedAddressSourceAssertionSchema)(candidate.source).pipe(
          Effect.mapError(unavailable),
        );
        const state = yield* current.read({ mode: 'CURRENT', profile, source });
        if (
          !Predicate.isTagged(state, 'CURRENT') ||
          state.savedAddressRef.tenantId !== tenantId ||
          state.savedAddressRef.resourceId !== candidate.savedAddressId ||
          computeCanonicalValueHash(state.profile) !== computeCanonicalValueHash(profile)
        ) {
          return yield* unavailable();
        }
        if (state.lifecycle === 'REMOVED') {
          return projection;
        }
        const detail = yield* values
          .detail({ profile, savedAddressRef: state.savedAddressRef }, tenantId)
          .pipe(Effect.mapError(unavailable));
        if (
          detail.address.revision !== state.revision ||
          detail.address.lifecycle !== state.lifecycle ||
          computeCanonicalValueHash([...detail.address.purposes].toSorted()) !==
            computeCanonicalValueHash([...state.purposes].toSorted()) ||
          computeCanonicalValueHash(detail.address.profile) !== computeCanonicalValueHash(profile) ||
          detail.address.savedAddressRef.resourceId !== state.savedAddressRef.resourceId
        ) {
          return yield* unavailable();
        }
        projection.addresses.push(
          yield* Schema.decodeUnknownEffect(ActiveSavedAddressSchema)(detail.address).pipe(
            Effect.mapError(unavailable),
          ),
        );
        return projection;
      }),
    ).pipe(Effect.map(({ addresses }) => addresses));
  },
);

/** Called only after the profile's fresh SOURCE_SYNC permit, never for an ordinary buyer or staff read. */
export const readSourceProfileAddresses = Effect.fn('CustomerProfileSourceRead.addresses')(function* readAddresses(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  item: CustomerProfileSourceItem,
  privacyRequirement: string,
) {
  if (scope.legalEntityId === undefined) {
    return yield* unavailable();
  }
  const { kind: _kind, ...profileRef } = item.profile.profileRef;
  const profile = yield* Schema.decodeUnknownEffect(AddressBookProfileSchema)(
    item.profile.subject.kind === 'COUNTERPARTY'
      ? { counterpartyRef: item.profile.subject.counterpartyRef, kind: 'COUNTERPARTY', profileRef }
      : { kind: 'RETAIL', profileRef },
  ).pipe(Effect.mapError(unavailable));
  const [row] = yield* transaction
    .invoke(candidatesRoutine, [
      scope.principalId,
      {
        profileId: profileRef.resourceId,
        source: item.source,
      },
    ])
    .pipe(Effect.mapError(unavailable));
  if (row === undefined) {
    return yield* unavailable();
  }
  if (row.outcome === 'SOURCE_AUTHORITY_DENIED') {
    return yield* new ReadPermissionDenied({
      code: 'read_permission_denied',
      reason: 'Current source authority does not admit this profile address read',
    });
  }
  return yield* projectSourceProfileAddresses(
    row.candidates,
    profile,
    scope.tenantId,
    savedAddressSourceReadService(transaction, scope, privacyRequirement),
    addressReadServicesForTransaction(transaction, scope),
  );
});
