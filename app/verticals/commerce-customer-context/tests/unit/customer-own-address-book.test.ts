import {
  ReadResultValidationError,
  ReadRuntime,
  TrustedPrincipalContextSchema,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime';
import type { ReadRuntimeService } from '@app/core-runtime';
import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { readCustomerOwnAddressBook } from '../../api/portal-auth/session/customer-address-book.ts';
import type { CustomerOwnAddressBookScope } from '../../api/portal-auth/session/customer-address-book.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { commercePortalAuthPlatformCryptoLive } from '../../api/portal-auth/deployment.ts';
import { EnrollmentResourceIdSchema } from '../../shared/enrollment-contracts.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const legalEntityId = '00000000-0000-4000-8000-000000000002';
const principalId = '00000000-0000-4000-8000-000000000003';
const authBindingId = '00000000-0000-4000-8000-000000000004';
const profileId = '00000000-0000-4000-8000-000000000005';
const partyId = Schema.decodeSync(EnrollmentResourceIdSchema)('00000000-0000-4000-8000-000000000006');
const profile = {
  kind: 'RETAIL',
  profileRef: {
    moduleId: 'commerce.customer-context',
    resourceId: profileId,
    resourceType: 'commerce.customer-context.retail-customer-profile',
    tenantId,
  },
};
const savedAddressRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'address-a',
  resourceType: 'commerce.customer-context.saved-address',
  tenantId,
};
const address = {
  label: 'Doručení',
  lifecycle: 'ACTIVE',
  origin: {
    kind: 'COMMERCE_ONLY',
    postalAddress: {
      addressLine1: 'Ulice 1',
      addressLine2: 'Patro 2',
      city: 'Praha',
      countryCode: 'CZ',
      postalCode: '11000',
      region: 'Praha',
    },
  },
  profile,
  purposes: ['DELIVERY'],
  revision: 1,
  savedAddressRef,
};
const defaults = { delivery: savedAddressRef, profile, revision: 1 };
const scope: CustomerOwnAddressBookScope = {
  authority: {
    authBindingId,
    partyId,
    principal: trustVerifiedGatewayPrincipalContext(
      Schema.decodeSync(TrustedPrincipalContextSchema)({
        authBindingId,
        authContextRef: 'better-auth-session:ontos.commerce.portal.better-auth.v1:owner-session',
        authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
        authMethod: 'session',
        legalEntityId,
        principalId,
        tenantId,
      }),
      'a'.repeat(64),
    ),
    principalId,
    profileId,
  },
  legalEntityId,
  sessionRef: 'better-auth-session:ontos.commerce.portal.better-auth.v1:owner-session',
  tenantId,
  workloadPrincipal: Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '00000000-0000-4000-8000-000000000007',
    authContextRef: 'better-auth-api-key:storefront',
    authMethod: 'api_key',
    legalEntityId,
    principalId: '00000000-0000-4000-8000-000000000008',
    tenantId,
  }),
};

it.effect('reads only the admitted customer profile under the customer principal, preserving every address field', () =>
  Effect.gen(function* ownAddressBook() {
    const calls: { readonly input: unknown; readonly principal: unknown; readonly readKey: string }[] = [];
    const runtime: ReadRuntimeService = {
      runRead: (input) => {
        calls.push({ input: input.input, principal: input.principal, readKey: input.registration.descriptor.readKey });
        const result = input.registration.descriptor.readKey.endsWith('saved-address-list')
          ? { addresses: [address] }
          : { defaults };
        return Schema.decodeUnknownEffect(input.registration.descriptor.resultSchema)(result).pipe(Effect.orDie);
      },
    };
    const result = yield* readCustomerOwnAddressBook(scope).pipe(Effect.provideService(ReadRuntime, runtime));
    expect(result).toEqual({ addresses: [address], defaults });
    expect(calls.map((call) => call.readKey)).toEqual([
      'commerce.customer-context.api.saved-address-list',
      'commerce.customer-context.api.saved-address-defaults',
    ]);
    for (const call of calls) {
      expect(call.input).toEqual({ profile });
      expect(call.principal).toMatchObject({
        authBindingId,
        authContextRef: scope.sessionRef,
        authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
        authMethod: 'session',
        legalEntityId,
        principalId,
        tenantId,
      });
      expect(call.principal).not.toEqual(scope.workloadPrincipal);
    }
  }).pipe(Effect.provide(commercePortalAuthPlatformCryptoLive)),
);

const otherProfile = {
  ...profile,
  profileRef: { ...profile.profileRef, resourceId: '00000000-0000-4000-8000-000000000009' },
};

for (const fixture of [
  {
    addresses: [{ ...address, profile: otherProfile }],
    defaults,
    name: 'a different customer profile in the same tenant',
  },
  { addresses: [address], defaults: { ...defaults, profile: otherProfile }, name: 'a different profile on defaults' },
  {
    addresses: [address],
    defaults: { ...defaults, delivery: { ...savedAddressRef, resourceId: 'foreign-address' } },
    name: 'a default pointing outside the returned active addresses',
  },
  { addresses: [{ ...address, lifecycle: 'REMOVED' }], defaults, name: 'a removed address' },
  {
    addresses: [address],
    defaults: { ...defaults, billing: savedAddressRef },
    name: 'an unsupported billing default on a delivery-only address',
  },
  {
    addresses: [
      {
        ...address,
        origin: {
          contactPointRef: {
            moduleId: 'party.registry',
            resourceId: '00000000-0000-4000-8000-000000000098',
            resourceType: 'party.registry.party-contact-point',
            tenantId,
          },
          kind: 'PARTY_BACKED',
          partyRef: {
            moduleId: 'party.registry',
            resourceId: '00000000-0000-4000-8000-000000000099',
            resourceType: 'party.registry.party',
            tenantId,
          },
          sourceRevision: 1,
        },
      },
    ],
    defaults,
    name: 'a Party-backed address for a different Party',
  },
]) {
  it.effect(`does not release ${fixture.name}`, () =>
    Effect.gen(function* invalidAddressProjection() {
      const runtime: ReadRuntimeService = {
        runRead: (input) =>
          Schema.decodeUnknownEffect(input.registration.descriptor.resultSchema)(
            input.registration.descriptor.readKey.endsWith('saved-address-list')
              ? { addresses: fixture.addresses }
              : { defaults: fixture.defaults },
          ).pipe(
            Effect.mapError(
              () =>
                new ReadResultValidationError({
                  code: 'read_result_invalid',
                  reason: 'Invalid owner fixture',
                }),
            ),
          ),
      };
      const result = yield* Effect.result(
        readCustomerOwnAddressBook(scope).pipe(Effect.provideService(ReadRuntime, runtime)),
      );
      expect(Result.isFailure(result)).toBe(true);
    }).pipe(Effect.provide(commercePortalAuthPlatformCryptoLive)),
  );
}

it.effect('retains Party-backed source references without inventing postal address fields', () =>
  Effect.gen(function* partyBackedAddress() {
    const backed = {
      ...address,
      origin: {
        contactPointRef: {
          moduleId: 'party.registry',
          resourceId: '00000000-0000-4000-8000-000000000098',
          resourceType: 'party.registry.party-contact-point',
          tenantId,
        },
        kind: 'PARTY_BACKED',
        partyRef: { moduleId: 'party.registry', resourceId: partyId, resourceType: 'party.registry.party', tenantId },
        sourceRevision: 1,
      },
    };
    const runtime: ReadRuntimeService = {
      runRead: (input) =>
        Schema.decodeUnknownEffect(input.registration.descriptor.resultSchema)(
          input.registration.descriptor.readKey.endsWith('saved-address-list') ? { addresses: [backed] } : { defaults },
        ).pipe(Effect.orDie),
    };
    const result = yield* readCustomerOwnAddressBook(scope).pipe(Effect.provideService(ReadRuntime, runtime));
    expect(result.addresses).toEqual([backed]);
  }).pipe(Effect.provide(commercePortalAuthPlatformCryptoLive)),
);

it.effect('does not convert an unavailable owner read to an empty successful address book', () =>
  Effect.gen(function* unavailableOwner() {
    const failure = new ReadResultValidationError({ code: 'read_result_invalid', reason: 'Unavailable projection' });
    const runtime: ReadRuntimeService = { runRead: () => Effect.fail(failure) };
    const result = yield* Effect.result(
      readCustomerOwnAddressBook(scope).pipe(Effect.provideService(ReadRuntime, runtime)),
    );
    expect(Result.isFailure(result) && result.failure).toEqual(failure);
  }).pipe(Effect.provide(commercePortalAuthPlatformCryptoLive)),
);

it.effect('fails closed before any read if the admitted workload tenant differs from the derived target tenant', () =>
  Effect.gen(function* crossTenantScope() {
    const calls: unknown[] = [];
    const runtime: ReadRuntimeService = {
      runRead: (input) => {
        calls.push(input);
        return Effect.die('A rejected subject must not reach the read runtime');
      },
    };
    const result = yield* Effect.result(
      readCustomerOwnAddressBook({ ...scope, tenantId: '00000000-0000-4000-8000-000000000099' }).pipe(
        Effect.provideService(ReadRuntime, runtime),
      ),
    );
    expect(result._tag).toBe('Failure');
    expect(calls).toEqual([]);
  }).pipe(Effect.provide(commercePortalAuthPlatformCryptoLive)),
);
