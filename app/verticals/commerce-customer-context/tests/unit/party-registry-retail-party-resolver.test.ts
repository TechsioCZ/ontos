import { DateTime, Effect, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { PartyDetailResponseSchema } from '@app/party-registry/api/client';
import type { PartyDetailResponse } from '@app/party-registry/api/client';
import {
  makePartyRegistryRetailPartyResolver,
  PartyRegistryRetailPartyResolverFactory,
  partyRegistryRetailPartyResolverFactoryLive,
} from '../../src/integrations/party-registry-retail-party-resolver.ts';
import { ProfilePersistenceDependencyFailure } from '../../src/persistence/profile-persistence.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const otherTenantId = '20000000-0000-4000-8000-000000000002';
const partyId = '30000000-0000-4000-8000-000000000003';
const scope = { requestCorrelation: 'retail-owner-correlation', tenantId } as const;
const request = { partyResourceId: partyId, tenantId } as const;
const partyRef = (resourceId: string, refTenantId = tenantId) => ({
  moduleId: 'party.registry' as const,
  resourceId,
  resourceType: 'party.registry.party' as const,
  tenantId: refTenantId,
});

const response = (overrides: Partial<PartyDetailResponse> = {}) =>
  Schema.decodeUnknownSync(PartyDetailResponseSchema)({
    currentFactAssertions: [],
    factHistory: null,
    party: {
      archivedAt: null,
      createdAt: '2026-09-09T09:00:00.000Z',
      displayName: 'Retail Owner',
      partyRef: partyRef(partyId),
      partyType: 'PERSON',
      revision: 7,
      updatedAt: '2026-09-09T09:00:00.000Z',
    },
    resolution: {
      aliasChain: [],
      canonicalPartyRef: partyRef(partyId),
      kind: 'DIRECT',
      requestedPartyRef: partyRef(partyId),
    },
    ...overrides,
  });

it.effect(
  'accepts only the exact current canonical Party and returns owner revision evidence',
  () =>
    makePartyRegistryRetailPartyResolver(scope, () => Effect.succeed(response()))(request).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toEqual({
            outcome: 'CURRENT_PARTY_RESOLVED',
            partyResourceId: partyId,
            partyResourceRevision: '7',
          });
        }),
      ),
    ),
);

it.effect(
  'rejects aliases, archived Parties, and cross-Tenant owner payloads without mutation',
  () =>
    Effect.gen(function* adversarialOwnerPayloads() {
      const alias = yield* makePartyRegistryRetailPartyResolver(scope, () =>
        Effect.succeed(
          response({
            resolution: {
              aliasChain: [partyRef('party-alias')],
              canonicalPartyRef: partyRef(partyId),
              kind: 'ALIAS',
              requestedPartyRef: partyRef('party-alias'),
            },
          }),
        ),
      )(request);
      expect(alias).toEqual({ outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE' });

      const archivedResponse = response();
      const archived = yield* makePartyRegistryRetailPartyResolver(scope, () =>
        Effect.succeed({
          ...archivedResponse,
          party: {
            ...archivedResponse.party,
            archivedAt: Option.some(DateTime.makeUnsafe('2026-09-09T10:00:00.000Z')),
          },
        }),
      )(request);
      expect(archived).toEqual({ outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE' });

      const crossTenantResponse = response();
      const crossTenant = yield* makePartyRegistryRetailPartyResolver(scope, () =>
        Effect.succeed({
          ...crossTenantResponse,
          party: { ...crossTenantResponse.party, partyRef: partyRef(partyId, otherTenantId) },
          resolution: {
            aliasChain: [],
            canonicalPartyRef: partyRef(partyId, otherTenantId),
            kind: 'DIRECT' as const,
            requestedPartyRef: partyRef(partyId, otherTenantId),
          },
        }),
      )(request);
      expect(crossTenant).toEqual({ outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE' });
    }),
);

it.effect(
  'fails closed when the owner operation is unavailable or the request scope is forged',
  () =>
    Effect.gen(function* unavailableOwner() {
      let calls = 0;
      const resolver = makePartyRegistryRetailPartyResolver(scope, () => {
        calls += 1;
        return Effect.fail(new Error('owner unavailable'));
      });
      const unavailable = yield* Effect.flip(resolver(request));
      expect(Schema.is(ProfilePersistenceDependencyFailure)(unavailable)).toBe(true);
      expect(unavailable.reason).toContain('Party Detail operation is unavailable');

      const forged = yield* Effect.flip(resolver({ ...request, tenantId: otherTenantId }));
      expect(Predicate.isTagged(forged, 'ProfilePersistenceDependencyFailure')).toBe(true);
      expect(forged.reason).toBe('Retail Party resolution scope is not trusted');
      expect(calls).toBe(1);
    }),
);

it.effect('installs the owner adapter as a production-injectable factory', () =>
  Effect.gen(function* verifyLayer() {
    const factory = yield* PartyRegistryRetailPartyResolverFactory;
    expect(Predicate.isFunction(factory.make)).toBe(true);
  }).pipe(Effect.provide(partyRegistryRetailPartyResolverFactoryLive)),
);
