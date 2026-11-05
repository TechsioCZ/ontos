import { ReadHandlerUnavailable, ReadRuntime, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { ReadCoreError, TrustedPrincipalContext } from '@app/core-runtime';
import { Crypto, Effect, Schema } from 'effect';

import type { SavedAddressListResponse } from '../../../shared/apis/saved-address-list.ts';
import type { SavedAddressDefaultsResponse } from '../../../shared/apis/saved-address-defaults.ts';
import type { CurrentCustomerAuthority } from './customer-authority.ts';
import {
  COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  CommerceSessionReferenceSchema,
} from '../../../shared/portal-auth-contracts.ts';
import { SavedAddressListResponseSchema } from '../../../shared/apis/saved-address-list.ts';
import { SavedAddressDefaultsResponseSchema } from '../../../shared/apis/saved-address-defaults.ts';
import { savedAddressListRead } from '../../../src/api/saved-address-list.read.ts';
import { savedAddressDefaultsRead } from '../../../src/api/saved-address-defaults.read.ts';
import { isAddressEligibleFor } from '../../../shared/domain/address-book.ts';
import type { AddressBookProfile, SavedAddress } from '../../../shared/domain/address-book.ts';

/** Server-only values obtained from admitCustomerAccount, never from a request payload. */
export interface CustomerOwnAddressBookScope {
  readonly authority: CurrentCustomerAuthority;
  readonly legalEntityId: string;
  readonly sessionRef: string;
  readonly tenantId: string;
  readonly workloadPrincipal: Readonly<TrustedPrincipalContext>;
}

export type CustomerOwnAddressBook = SavedAddressListResponse & SavedAddressDefaultsResponse;

const unavailable = () =>
  new ReadHandlerUnavailable({
    code: 'read_handler_unavailable',
    reason: 'The admitted customer address book is unavailable',
  });

const belongsToCustomer = (profile: AddressBookProfile, scope: CustomerOwnAddressBookScope) =>
  profile.kind === 'RETAIL' &&
  profile.profileRef.tenantId === scope.tenantId &&
  profile.profileRef.resourceId === scope.authority.profileId;

const validDefaults = (result: CustomerOwnAddressBook) =>
  (['billing', 'delivery'] as const).every((purpose) => {
    const ref = result.defaults[purpose];
    return (
      ref === undefined ||
      result.addresses.filter(
        (address) =>
          address.savedAddressRef.resourceId === ref.resourceId &&
          address.savedAddressRef.tenantId === ref.tenantId &&
          isAddressEligibleFor(address, purpose === 'billing' ? 'BILLING' : 'DELIVERY'),
      ).length === 1
    );
  });

const belongsToParty = (address: SavedAddress, scope: CustomerOwnAddressBookScope) =>
  address.origin.kind !== 'PARTY_BACKED' || address.origin.partyRef.resourceId === scope.authority.partyId;

/** Reuses governed owner reads, with the freshly admitted customer as the effective principal. */
export const readCustomerOwnAddressBook = Effect.fn('CustomerOwnAddressBook.read')(function* readAddressBook(
  scope: CustomerOwnAddressBookScope,
) {
  if (
    scope.tenantId !== scope.workloadPrincipal.tenantId ||
    scope.legalEntityId !== scope.workloadPrincipal.legalEntityId
  ) {
    return yield* unavailable();
  }
  const sessionRef = yield* Schema.decodeEffect(CommerceSessionReferenceSchema)(scope.sessionRef).pipe(
    Effect.catchTag('SchemaError', () => unavailable()),
  );
  const principal = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
    authBindingId: scope.authority.authBindingId,
    authContextRef: sessionRef,
    authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
    authMethod: 'session',
    legalEntityId: scope.legalEntityId,
    principalId: scope.authority.principalId,
    tenantId: scope.tenantId,
  }).pipe(Effect.catchTag('SchemaError', () => unavailable()));
  const profile = {
    kind: 'RETAIL',
    profileRef: {
      moduleId: 'commerce.customer-context',
      resourceId: scope.authority.profileId,
      resourceType: 'commerce.customer-context.retail-customer-profile',
      tenantId: scope.tenantId,
    },
  } as const;
  const runtime = yield* ReadRuntime;
  const crypto = yield* Crypto.Crypto;
  const correlationId = yield* crypto
    .randomUUIDv4()
    .pipe(Effect.mapError((cause) => Object.assign(unavailable(), { cause })));
  const addressesRead: Effect.Effect<SavedAddressListResponse, ReadCoreError> = runtime
    .runRead({
      audience: 'commerce-customer-context',
      input: { profile },
      principal,
      registration: savedAddressListRead,
      transport: { correlationId },
    })
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(SavedAddressListResponseSchema)),
      Effect.catchTag('SchemaError', () => Effect.fail(unavailable())),
    );
  const defaultsRead: Effect.Effect<SavedAddressDefaultsResponse, ReadCoreError> = runtime
    .runRead({
      audience: 'commerce-customer-context',
      input: { profile },
      principal,
      registration: savedAddressDefaultsRead,
      transport: { correlationId },
    })
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(SavedAddressDefaultsResponseSchema)),
      Effect.catchTag('SchemaError', () => Effect.fail(unavailable())),
    );
  // Resolve generic read channels before Effect.all's contextual Effect<any> constraint.
  // Both governed reads share one request's budget; preserve list-before-defaults ordering.
  const { addresses, defaults } = yield* Effect.all(
    { addresses: addressesRead, defaults: defaultsRead },
    { concurrency: 1 },
  );
  const result: CustomerOwnAddressBook = { ...addresses, ...defaults };
  if (
    !belongsToCustomer(result.defaults.profile, scope) ||
    result.addresses.some((address) => !belongsToCustomer(address.profile, scope) || !belongsToParty(address, scope)) ||
    !validDefaults(result)
  ) {
    return yield* unavailable();
  }
  return result;
});
