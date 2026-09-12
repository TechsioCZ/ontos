import { Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { GuestPartyResolutionResponse } from '@app/party-registry/api';
import {
  makePartyRegistryGuestResolver,
  PartyRegistryGuestResolverFactory,
  partyRegistryGuestResolverFactoryLive,
} from '../../src/integrations/party-registry-guest-resolver.ts';
import { ProfilePersistenceDependencyFailure } from '../../src/persistence/profile-persistence.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const otherTenantId = '20000000-0000-4000-8000-000000000002';
const legalEntityId = '30000000-0000-4000-8000-000000000003';
const partyId = '40000000-0000-4000-8000-000000000004';

const request = {
  correlationRoot: 'guest-correlation',
  guestEvidenceRef: 'opaque-guest-evidence',
  legalEntityId,
  requestedAt: '2026-09-09T10:00:00.000Z',
  tenantId,
} as const;

const scope = {
  legalEntityId,
  requestCorrelation: 'guest-resolution-correlation',
  tenantId,
} as const;

const resolveWith = (response: GuestPartyResolutionResponse) =>
  makePartyRegistryGuestResolver(scope, () => Effect.succeed(response))(request);

it.effect('rejects guest resolution when the request scope crosses Tenant or Legal Entity', () =>
  Effect.flip(
    makePartyRegistryGuestResolver(scope, () =>
      Effect.succeed({
        outcome: 'EXISTING_PARTY_RESOLVED',
        partyRef: {
          moduleId: 'party.registry',
          resourceId: partyId,
          resourceType: 'party.registry.party',
          tenantId,
        },
      } as const),
    )({ ...request, tenantId: otherTenantId }),
  ).pipe(
    Effect.tap((failure) =>
      Effect.sync(() => {
        expect(Schema.is(ProfilePersistenceDependencyFailure)(failure)).toBe(true);
        expect(failure.reason).toBe('Guest Party resolution scope is not trusted');
      }),
    ),
  ),
);

it.effect('maps a valid Party owner outcome without making CCC infer identity', () =>
  resolveWith({
    outcome: 'EXISTING_PARTY_RESOLVED',
    partyRef: {
      moduleId: 'party.registry',
      resourceId: partyId,
      resourceType: 'party.registry.party',
      tenantId,
    },
  }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result.outcome).toBe('EXISTING_PARTY_RESOLVED');
        if (result.outcome !== 'EXISTING_PARTY_RESOLVED') {
          throw new Error('Expected an existing Party owner outcome');
        }
        expect(result.partyRef.resourceId).toBe(partyId);
      }),
    ),
  ),
);

it.effect('preserves ambiguous owner evidence as a scoped review case', () => {
  const caseRef = {
    moduleId: 'party.registry' as const,
    resourceId: '50000000-0000-4000-8000-000000000005',
    resourceType: 'party.registry.duplicate-candidate-case' as const,
    tenantId,
  };
  return resolveWith({ caseRef, outcome: 'AMBIGUOUS_MATCH' }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result).toEqual({
          caseRef: caseRef.resourceId,
          outcome: 'AMBIGUOUS_MATCH',
        });
      }),
    ),
  );
});

it.effect('rejects owner Party references from another Tenant before CCC mutation', () =>
  Effect.flip(
    resolveWith({
      outcome: 'EXISTING_PARTY_RESOLVED',
      partyRef: {
        moduleId: 'party.registry',
        resourceId: partyId,
        resourceType: 'party.registry.party',
        tenantId: otherTenantId,
      },
    }),
  ).pipe(
    Effect.tap((failure) =>
      Effect.sync(() => {
        expect(Schema.is(ProfilePersistenceDependencyFailure)(failure)).toBe(true);
        expect(failure.reason).toBe('The Party Registry returned a Party outside the trusted Tenant');
      }),
    ),
  ),
);

it.effect('installs the live factory as the production-injectable owner seam', () =>
  Effect.gen(function* verifyLayer() {
    const factory = yield* PartyRegistryGuestResolverFactory;
    expect(Predicate.isFunction(factory.make)).toBe(true);
  }).pipe(Effect.provide(partyRegistryGuestResolverFactoryLive)),
);
