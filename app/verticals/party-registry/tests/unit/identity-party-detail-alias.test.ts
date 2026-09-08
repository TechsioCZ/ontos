import { expect, it } from '@app/effect-rstest';
import { DateTime, Effect, Option, Schema, Predicate } from 'effect';
import { PartyDetailResponseSchema } from '../../shared/apis/party-detail.ts';
import { PartySchema } from '../../shared/domain/identity-contracts.ts';
import type { Party } from '../../shared/domain/identity-contracts.ts';
import type { PartyRef } from '../../shared/resources/party.ts';
import { readPartyDetailFromServices } from '../../src/api/party-detail.read.ts';
import { makePartyAliasResolutionService } from '../../src/merge/party-alias-resolution.service.ts';
import type { PartyAliasLookupRow } from '../../src/merge/party-alias-resolution.service.ts';
import type { PartyLookup } from '../../src/services/party-identity-persistence.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '22222222-2222-4222-8222-222222222222';
const partyRef = (resourceId: string): PartyRef => ({
  moduleId: 'party.registry',
  resourceId,
  resourceType: 'party.registry.party',
  tenantId,
});
const canonicalPartyWire = {
  archivedAt: null,
  createdAt: '2026-09-01T10:00:00.000Z',
  displayName: 'Canonical Party',
  partyRef: partyRef('party-c'),
  partyType: 'ORGANIZATION',
  revision: 3,
  updatedAt: '2026-09-03T10:00:00.000Z',
} as const;
const canonicalParty: Party = Schema.decodeUnknownSync(PartySchema)(canonicalPartyWire);
const alias = (aliasPartyId: string, canonicalPartyId: string): PartyAliasLookupRow => ({
  aliasPartyId,
  canonicalPartyId,
  tenantId,
});
const makeServices = (
  aliases: readonly PartyAliasLookupRow[],
  party: Party | null = canonicalParty,
) => {
  const lookups: string[] = [];
  const resolver = makePartyAliasResolutionService({
    findAlias: (_tenantId, partyId) =>
      Effect.succeed(
        Option.fromNullishOr(aliases.find(({ aliasPartyId }) => aliasPartyId === partyId)),
      ),
    partyExists: (_tenantId, partyId) => Effect.succeed(party?.partyRef.resourceId === partyId),
  });
  return {
    lookups,
    services: {
      facts: () => Effect.succeed({ currentFactAssertions: [], factHistory: Option.none() }),
      find: (partyId: string): Effect.Effect<PartyLookup> => {
        lookups.push(partyId);
        return Effect.succeed(
          party?.partyRef.resourceId === partyId
            ? { _tag: 'found', value: party }
            : { _tag: 'not_found' },
        );
      },
      resolve: (partyId: string) => resolver.resolvePartyAlias(tenantId, partyId),
    },
  };
};

it.effect(
  'Party Detail reads the final canonical Party after the complete historical alias chain',
  () =>
    Effect.gen(function* verifyPartyDetail1() {
      const { lookups, services } = makeServices([
        alias('party-b', 'party-a'),
        alias('party-a', 'party-c'),
      ]);
      const result = yield* readPartyDetailFromServices(partyRef('party-b'), tenantId, services);

      expect(result).toEqual({
        currentFactAssertions: [],
        factHistory: Option.none(),
        party: canonicalParty,
        resolution: {
          aliasChain: [partyRef('party-b'), partyRef('party-a')],
          canonicalPartyRef: partyRef('party-c'),
          kind: 'ALIAS',
          requestedPartyRef: partyRef('party-b'),
        },
      });
      expect(lookups).toEqual(['party-c']);
      expect(Schema.is(PartyDetailResponseSchema)(result)).toBe(true);
      const encoded = yield* Schema.encodeEffect(PartyDetailResponseSchema)(result);
      expect(encoded.factHistory).toBe(null);
      expect(encoded.party).toEqual(canonicalPartyWire);
    }),
);

it.effect(
  'Party Detail preserves archived lifecycle independently of direct resolution metadata',
  () =>
    Effect.gen(function* verifyPartyDetail2() {
      const archivedAt = '2026-09-02T10:00:00.000Z';
      const archivedParty = yield* Schema.decodeUnknownEffect(PartySchema)({
        ...canonicalPartyWire,
        archivedAt,
      });
      const { services } = makeServices([], archivedParty);
      const result = yield* readPartyDetailFromServices(partyRef('party-c'), tenantId, services);

      expect(result.party.archivedAt).toEqual(Option.some(DateTime.makeUnsafe(archivedAt)));
      expect(result.resolution).toEqual({
        aliasChain: [],
        canonicalPartyRef: partyRef('party-c'),
        kind: 'DIRECT',
        requestedPartyRef: partyRef('party-c'),
      });
    }),
);

it.effect(
  'Party Detail fails closed for cycles and broken historical chains without reading an alias Party',
  () =>
    Effect.gen(function* verifyPartyDetail3() {
      for (const aliases of [
        [alias('party-a', 'party-b'), alias('party-b', 'party-a')],
        [alias('party-a', 'missing')],
      ]) {
        const { lookups, services } = makeServices(aliases);
        const error = yield* Effect.flip(
          readPartyDetailFromServices(partyRef('party-a'), tenantId, services),
        );
        expect(Predicate.isTagged(error, 'ReadHandlerUnavailable')).toBe(true);
        expect(lookups).toEqual([]);
      }
    }),
);

it.effect('Party Detail hides a missing direct Party and a cross-tenant requested reference', () =>
  Effect.gen(function* verifyPartyDetail4() {
    const { lookups, services } = makeServices([]);
    for (const requested of [
      partyRef('missing'),
      { ...partyRef('party-c'), tenantId: otherTenantId },
    ]) {
      const error = yield* Effect.flip(readPartyDetailFromServices(requested, tenantId, services));
      expect(Predicate.isTagged(error, 'ReadHandlerNotFound')).toBe(true);
    }
    expect(lookups).toEqual([]);
  }),
);
