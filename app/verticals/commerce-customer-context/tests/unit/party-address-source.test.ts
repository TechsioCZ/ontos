import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import type { executePartyContactPointDetail } from '@app/party-registry/api/client';
import {
  PartyContactPointDetailAuthenticationProblemSchema,
  PartyContactPointDetailForbiddenProblemSchema,
  PartyContactPointDetailInternalProblemSchema,
  PartyContactPointDetailInvalidProblemSchema,
  PartyContactPointDetailNotFoundProblemSchema,
  PartyContactPointDetailPolicyConflictProblemSchema,
  PartyContactPointDetailPolicyProblemSchema,
  PartyContactPointDetailResponseSchema,
  PartyContactPointDetailUnavailableProblemSchema,
} from '@app/party-registry/api/client';
import { Crypto, DateTime, Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { AddressBookUnavailable, SavedAddressInvalidSchema } from '../../shared/domain/address-errors.ts';
import {
  PartyAddressSourceExecutor,
  partyBackedAddressSourceValidator,
  partyBackedAddressSourceValidatorForScope,
  partyBackedPostalAddressResolver,
  partyBackedPostalAddressResolverForScope,
} from '../../src/integrations/party-address-source.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const contactPointRef = {
  moduleId: 'party.registry',
  resourceId: '20000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party-contact-point',
  tenantId,
} as const;
const partyRef = {
  moduleId: 'party.registry',
  resourceId: '30000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const profile = {
  kind: 'RETAIL',
  profileRef: {
    moduleId: 'commerce.customer-context',
    resourceId: '40000000-0000-4000-8000-000000000001',
    resourceType: 'commerce.customer-context.retail-customer-profile',
    tenantId,
  },
} as const;
const origin = {
  contactPointRef,
  kind: 'PARTY_BACKED',
  partyRef,
  sourceRevision: 7,
} as const;
const payload = {
  origin,
  profile,
  purposes: ['BILLING'],
  reason: 'The customer selected this Party postal address',
} as const;
const savedPartyAddress = {
  lifecycle: 'ACTIVE',
  origin,
  profile,
  purposes: ['BILLING'],
  revision: 2,
  savedAddressRef: {
    moduleId: 'commerce.customer-context',
    resourceId: '50000000-0000-4000-8000-000000000001',
    resourceType: 'commerce.customer-context.saved-address',
    tenantId,
  },
} as const;
const at = '2026-09-09T10:00:00.000Z';
const provenance = {
  authoritative: true,
  method: 'MANUAL_CONFIRMATION',
  source: 'PARTY_DECLARATION',
} as const;
const verification = { state: 'VERIFIED' } as const;
const currentPostalContactPoint = Schema.decodeUnknownSync(PartyContactPointDetailResponseSchema)({
  contactPointRef,
  current: true,
  end: null,
  partyRef,
  privacyClassification: 'BUSINESS_SENSITIVE',
  provenance,
  recordedAt: at,
  revision: 7,
  state: 'ACTIVE',
  storedPartyRef: partyRef,
  validFrom: at,
  validTo: null,
  value: {
    address: {
      addressLine1: '1 Main Street',
      addressLine2: null,
      city: 'Prague',
      countryCode: 'CZ',
      postalCode: '11000',
      region: null,
    },
    purposes: [
      {
        current: true,
        end: null,
        preferred: true,
        provenance,
        purpose: 'BILLING',
        recordedAt: at,
        revision: 7,
        state: 'ACTIVE',
        validFrom: at,
        validTo: null,
        verification,
      },
    ],
    type: 'ADDRESS',
  },
  verification,
});

interface ObservedInvocation {
  readonly correlation: string;
  readonly request: Parameters<typeof executePartyContactPointDetail>[0];
}

it.effect('validates an exact Current Party postal Contact Point through the public client', () =>
  Effect.gen(function* currentPartyAddress() {
    let observed: ObservedInvocation | undefined;
    const execute = (
      request: Parameters<typeof executePartyContactPointDetail>[0],
      correlation: string,
    ): ReturnType<typeof executePartyContactPointDetail> => {
      observed = { correlation, request };
      return Effect.succeed(currentPostalContactPoint);
    };

    yield* partyBackedAddressSourceValidator('address-correlation', execute)(payload);
    expect(observed).toEqual({
      correlation: 'address-correlation',
      request: { contactPointRef },
    });
  }),
);

it.effect('rejects a stale Party source revision before address persistence', () =>
  Effect.gen(function* stalePartyAddress() {
    const execute = (): ReturnType<typeof executePartyContactPointDetail> =>
      Effect.succeed({ ...currentPostalContactPoint, revision: 8 });
    const failure = yield* Effect.flip(partyBackedAddressSourceValidator('address-correlation', execute)(payload));

    expect(Schema.is(SavedAddressInvalidSchema)(failure)).toBe(true);
    expect(failure).toMatchObject({
      code: 'saved_address_invalid',
      reason: 'The Party-backed address source revision is stale',
    });
  }),
);

it.effect('classifies definitive Party HTTP outcomes without making them retryable', () =>
  Effect.gen(function* definitivePartyFailures() {
    const problems = [
      [
        PartyContactPointDetailInvalidProblemSchema,
        'PartyContactPointDetailInvalidProblem',
        400,
        'saved_address_invalid',
      ],
      [
        PartyContactPointDetailForbiddenProblemSchema,
        'PartyContactPointDetailForbiddenProblem',
        403,
        'saved_address_not_found',
      ],
      [
        PartyContactPointDetailNotFoundProblemSchema,
        'PartyContactPointDetailNotFoundProblem',
        404,
        'saved_address_not_found',
      ],
      [
        PartyContactPointDetailPolicyConflictProblemSchema,
        'PartyContactPointDetailPolicyConflictProblem',
        409,
        'saved_address_conflict',
      ],
      [
        PartyContactPointDetailPolicyProblemSchema,
        'PartyContactPointDetailPolicyProblem',
        422,
        'saved_address_invalid',
      ],
    ] as const;
    for (const [problemSchema, tag, status, expectedCode] of problems) {
      const problem = Schema.decodeUnknownSync(problemSchema)({
        _tag: tag,
        detail: 'Definitive Party response',
        status,
        title: 'Party Contact Point rejected',
        type: 'https://ontos.dev/problems/party-contact-point',
      });
      const execute = (): ReturnType<typeof executePartyContactPointDetail> => Effect.fail(problem);
      const failure = yield* Effect.flip(partyBackedAddressSourceValidator('address-correlation', execute)(payload));
      expect(failure.code).toBe(expectedCode);
      expect(Schema.is(AddressBookUnavailable)(failure)).toBe(false);
    }
  }),
);

it.effect('preserves a retryable Party 503 as typed Address Book unavailability', () =>
  Effect.gen(function* retryablePartyFailure() {
    const problem = Schema.decodeUnknownSync(PartyContactPointDetailUnavailableProblemSchema)({
      _tag: 'PartyContactPointDetailUnavailableProblem',
      detail: 'Party Registry is unavailable',
      retryable: true,
      status: 503,
      title: 'Unavailable',
      type: 'https://ontos.dev/problems/party-contact-point-unavailable',
    });
    const execute = (): ReturnType<typeof executePartyContactPointDetail> => Effect.fail(problem);
    const failure = yield* Effect.flip(partyBackedAddressSourceValidator('address-correlation', execute)(payload));
    expect(Schema.is(AddressBookUnavailable)(failure)).toBe(true);
    if (Schema.is(AddressBookUnavailable)(failure)) {
      expect(failure.retryable).toBe(true);
    }
  }),
);

it.effect('classifies Party authentication and internal HTTP outcomes as dependency unavailability', () =>
  Effect.gen(function* transientPartyFailures() {
    const problems = [
      [PartyContactPointDetailAuthenticationProblemSchema, 'PartyContactPointDetailAuthenticationProblem', 401],
      [PartyContactPointDetailInternalProblemSchema, 'PartyContactPointDetailInternalProblem', 500],
    ] as const;
    for (const [problemSchema, tag, status] of problems) {
      const problem = Schema.decodeUnknownSync(problemSchema)({
        _tag: tag,
        detail: 'Party Registry dependency failure',
        status,
        title: 'Party Contact Point request failed',
        type: 'https://ontos.dev/problems/party-contact-point',
      });
      const execute = (): ReturnType<typeof executePartyContactPointDetail> => Effect.fail(problem);
      const failure = yield* Effect.flip(partyBackedAddressSourceValidator('address-correlation', execute)(payload));
      expect(Schema.is(AddressBookUnavailable)(failure)).toBe(true);
    }
  }),
);

it.effect('resolves the Current Party-backed postal snapshot through the public client', () =>
  Effect.gen(function* currentPartyPostalSnapshot() {
    const execute = (): ReturnType<typeof executePartyContactPointDetail> => Effect.succeed(currentPostalContactPoint);
    const resolved = yield* partyBackedPostalAddressResolver('address-correlation', execute)(savedPartyAddress);

    expect(resolved).toEqual({
      kind: 'FOUND',
      value: {
        currentContactPointRef: contactPointRef,
        currentPartyRef: partyRef,
        currentSourceRevision: 7,
        kind: 'PARTY_BACKED',
        postalAddress: {
          addressLine1: '1 Main Street',
          city: 'Prague',
          countryCode: 'CZ',
          postalCode: '11000',
        },
      },
    });
  }),
);

it.effect('accepts a canonical Party alias and carries the corrected Current source revision', () =>
  Effect.gen(function* canonicalAliasCorrection() {
    const canonicalPartyRef = {
      ...partyRef,
      resourceId: '30000000-0000-4000-8000-000000000099',
    };
    const execute = (): ReturnType<typeof executePartyContactPointDetail> =>
      Effect.succeed({
        ...currentPostalContactPoint,
        partyRef: canonicalPartyRef,
        revision: 8,
        storedPartyRef: partyRef,
      });
    const resolved = yield* partyBackedPostalAddressResolver('address-correlation', execute)(savedPartyAddress);

    expect(resolved).toMatchObject({
      kind: 'FOUND',
      value: {
        currentContactPointRef: contactPointRef,
        currentPartyRef: canonicalPartyRef,
        currentSourceRevision: 8,
        kind: 'PARTY_BACKED',
      },
    });
    expect(savedPartyAddress.origin).toEqual(origin);
  }),
);

it.effect('rejects a different same-Tenant Contact Point returned by the dependency', () =>
  Effect.gen(function* mismatchedContactPoint() {
    const execute = (): ReturnType<typeof executePartyContactPointDetail> =>
      Effect.succeed({
        ...currentPostalContactPoint,
        contactPointRef: {
          ...contactPointRef,
          resourceId: '20000000-0000-4000-8000-000000000099',
        },
      });
    const resolved = yield* partyBackedPostalAddressResolver('address-correlation', execute)(savedPartyAddress);

    expect(resolved).toEqual({ kind: 'NOT_FOUND' });
  }),
);

it.effect('accepts finite future whole-End from the Current Party owner for Add and explicit Update', () =>
  Effect.gen(function* futureWholeEnd() {
    const finite = { ...currentPostalContactPoint, validTo: DateTime.makeUnsafe('2031-01-01T00:00:00.000Z') };
    const execute = (): ReturnType<typeof executePartyContactPointDetail> => Effect.succeed(finite);
    yield* partyBackedAddressSourceValidator('future-end-add', execute)(payload);
    yield* partyBackedAddressSourceValidator(
      'future-end-update',
      execute,
    )({
      ...payload,
      expectedRevision: savedPartyAddress.revision,
      savedAddressRef: savedPartyAddress.savedAddressRef,
    });
    expect(yield* partyBackedPostalAddressResolver('future-end-resolve', execute)(savedPartyAddress)).toMatchObject({
      kind: 'FOUND',
      value: { currentSourceRevision: origin.sourceRevision, kind: 'PARTY_BACKED' },
    });
    expect(DateTime.formatIso(finite.validTo)).toBe('2031-01-01T00:00:00.000Z');
  }),
);
it.effect('retains owner Current and exact revision guards for finite postal sources', () =>
  Effect.gen(function* finiteSourceGuards() {
    for (const patch of [{ current: false }, { state: 'ENDED' as const }, { revision: 8 }]) {
      const execute = (): ReturnType<typeof executePartyContactPointDetail> =>
        Effect.succeed({
          ...currentPostalContactPoint,
          validTo: DateTime.makeUnsafe('2031-01-01T00:00:00.000Z'),
          ...patch,
        });
      const failure = yield* Effect.flip(partyBackedAddressSourceValidator('finite-denial', execute)(payload));
      expect(Schema.is(SavedAddressInvalidSchema)(failure)).toBe(true);
    }
    const execute = (): ReturnType<typeof executePartyContactPointDetail> =>
      Effect.succeed({
        ...currentPostalContactPoint,
        current: false,
        validTo: DateTime.makeUnsafe('2031-01-01T00:00:00.000Z'),
      });
    expect(yield* partyBackedPostalAddressResolver('exclusive-end', execute)(savedPartyAddress)).toEqual({
      kind: 'NOT_FOUND',
    });
  }),
);
it.effect('keeps COMMERCE_ONLY and omitted Update origins independent of Party availability', () =>
  Effect.gen(function* independentAddressOrigins() {
    let calls = 0;
    const execute = (): ReturnType<typeof executePartyContactPointDetail> => {
      calls += 1;
      return Effect.succeed(currentPostalContactPoint);
    };
    const validate = partyBackedAddressSourceValidator('independent-origin', execute);
    yield* validate({
      ...payload,
      origin: {
        kind: 'COMMERCE_ONLY',
        postalAddress: { addressLine1: '1 Main Street', city: 'Prague', countryCode: 'CZ', postalCode: '11000' },
      },
    });
    yield* validate({
      expectedRevision: 2,
      label: 'Renamed',
      profile,
      reason: 'Label only',
      savedAddressRef: savedPartyAddress.savedAddressRef,
    });
    expect(calls).toBe(0);
  }),
);

it.effect('requires explicit owner transport composition and preserves source validation', () =>
  Effect.gen(function* composedSourceTransport() {
    expect(yield* PartyAddressSourceExecutor).toBeUndefined();
    let calls = 0;
    const execute: typeof executePartyContactPointDetail = () => {
      calls += 1;
      return Effect.succeed({
        ...currentPostalContactPoint,
        revision: 8,
        validTo: DateTime.makeUnsafe('2031-01-01T00:00:00.000Z'),
      });
    };
    const failure = yield* Effect.flip(
      partyBackedAddressSourceValidator('composed-stale')(payload).pipe(
        Effect.provideService(PartyAddressSourceExecutor, execute),
      ),
    );
    expect(Schema.is(SavedAddressInvalidSchema)(failure)).toBe(true);
    expect(calls).toBe(1);
    yield* partyBackedAddressSourceValidator('composed-fresh')({
      ...payload,
      origin: { ...origin, sourceRevision: 8 },
    }).pipe(Effect.provideService(PartyAddressSourceExecutor, execute));
    expect(calls).toBe(2);
  }),
);

it.effect('keeps finite-source identity and contact kind checks strict', () =>
  Effect.gen(function* finiteIdentityGuards() {
    const foreignTenant = '10000000-0000-4000-8000-000000000099';
    const sources = [
      { ...currentPostalContactPoint, partyRef: { ...partyRef, resourceId: '30000000-0000-4000-8000-000000000099' } },
      { ...currentPostalContactPoint, contactPointRef: { ...contactPointRef, tenantId: foreignTenant } },
      {
        ...currentPostalContactPoint,
        value: {
          displayValue: 'owner@example.test',
          lookupValue: 'owner@example.test',
          preferred: false,
          type: 'EMAIL' as const,
        },
      },
    ];
    for (const source of sources) {
      const execute: typeof executePartyContactPointDetail = () =>
        Effect.succeed({ ...source, validTo: DateTime.makeUnsafe('2031-01-01T00:00:00.000Z') });
      expect(
        Schema.is(SavedAddressInvalidSchema)(
          yield* Effect.flip(partyBackedAddressSourceValidator('finite-identity', execute)(payload)),
        ),
      ).toBe(true);
    }
  }),
);

it.effect('rejects missing required postal fields without requiring optional fields or an open end', () =>
  Effect.gen(function* completePostalAdmission() {
    const completePostalAddress = {
      addressLine1: '1 Main Street',
      addressLine2: null,
      city: 'Prague',
      countryCode: 'CZ',
      postalCode: '11000',
      region: null,
    };

    for (const validTo of [null, DateTime.makeUnsafe('2031-01-01T00:00:00.000Z')]) {
      for (const field of ['addressLine1', 'city', 'postalCode'] as const) {
        const incomplete = {
          ...currentPostalContactPoint,
          validTo,
          value: {
            ...currentPostalContactPoint.value,
            address: { ...completePostalAddress, [field]: null },
            purposes:
              currentPostalContactPoint.value.type === 'ADDRESS' ? currentPostalContactPoint.value.purposes : [],
            type: 'ADDRESS' as const,
          },
        };
        const execute: typeof executePartyContactPointDetail = () => Effect.succeed(incomplete);
        const result = yield* Effect.result(partyBackedAddressSourceValidator('incomplete-source', execute)(payload));
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(Schema.is(SavedAddressInvalidSchema)(result.failure)).toBe(true);
        }
        expect(yield* partyBackedPostalAddressResolver('incomplete-source', execute)(savedPartyAddress)).toEqual({
          kind: 'NOT_FOUND',
        });
      }
      const execute: typeof executePartyContactPointDetail = () =>
        Effect.succeed({ ...currentPostalContactPoint, validTo });
      yield* partyBackedAddressSourceValidator('complete-optional-fields-absent', execute)(payload);
    }
  }),
);

const unverifiedScope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '40000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:postal-relay-unit',
    authMethod: 'session',
    principalId: '10000000-0000-4000-8000-000000000001',
    tenantId,
  }),
  audience: 'commerce-customer-context',
  correlationId: 'postal-relay-unit',
};

it.effect('keeps the actual COMMERCE_ONLY adapter independent of Party relay credentials', () =>
  Effect.gen(function* localAddress() {
    const crypto = yield* Crypto.Crypto;
    const localOrigin = {
      kind: 'COMMERCE_ONLY',
      postalAddress: { addressLine1: '1 Main Street', city: 'Prague', countryCode: 'CZ', postalCode: '11000' },
    } as const;
    yield* partyBackedAddressSourceValidatorForScope(
      unverifiedScope,
      crypto,
      'commerce.customer-context.requirement.add-saved-address-party',
    )({ ...payload, origin: localOrigin });
    const resolved = yield* partyBackedPostalAddressResolverForScope(
      unverifiedScope,
      crypto,
      'commerce.customer-context.requirement.delivery-destination-resolution-party',
    )({ ...savedPartyAddress, origin: localOrigin });
    expect(resolved).toEqual({
      kind: 'FOUND',
      value: { kind: 'COMMERCE_ONLY', postalAddress: localOrigin.postalAddress },
    });
  }).pipe(Effect.provide(nodeCryptoLayer)),
);

it.effect('fails closed at the actual Party-backed adapter without trusted source admission', () =>
  Effect.gen(function* unverifiedPartySource() {
    const crypto = yield* Crypto.Crypto;
    const failure = yield* Effect.flip(partyBackedAddressSourceValidatorForScope(unverifiedScope, crypto)(payload));
    expect(Schema.is(AddressBookUnavailable)(failure)).toBe(true);
    const readFailure = yield* Effect.flip(
      partyBackedPostalAddressResolverForScope(unverifiedScope, crypto)(savedPartyAddress),
    );
    expect(Schema.is(AddressBookUnavailable)(readFailure)).toBe(true);
  }).pipe(Effect.provide(nodeCryptoLayer)),
);

it.effect('does not invoke a configured Party transport without a genuine operation lease', () =>
  Effect.gen(function* missingOperationLease() {
    const crypto = yield* Crypto.Crypto;
    let calls = 0;
    const execute: typeof executePartyContactPointDetail = () => {
      calls += 1;
      return Effect.succeed(currentPostalContactPoint);
    };
    const validation = yield* Effect.flip(
      partyBackedAddressSourceValidatorForScope(
        unverifiedScope,
        crypto,
        'commerce.customer-context.requirement.add-saved-address-party',
      )(payload).pipe(Effect.provideService(PartyAddressSourceExecutor, execute)),
    );
    expect(Schema.is(AddressBookUnavailable)(validation)).toBe(true);
    const resolution = yield* Effect.flip(
      partyBackedPostalAddressResolverForScope(
        unverifiedScope,
        crypto,
        'commerce.customer-context.requirement.delivery-destination-resolution-party',
      )(savedPartyAddress).pipe(Effect.provideService(PartyAddressSourceExecutor, execute)),
    );
    expect(Schema.is(AddressBookUnavailable)(resolution)).toBe(true);
    expect(calls).toBe(0);
  }).pipe(Effect.provide(nodeCryptoLayer)),
);
