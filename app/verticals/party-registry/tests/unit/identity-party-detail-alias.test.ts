import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Schema } from 'effect';
import { PartyDetailResponseSchema } from '../../shared/apis/party-detail.ts';
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
const canonicalParty: Party = {
  archivedAt: null,
  createdAt: '2026-09-01T10:00:00.000Z',
  displayName: 'Canonical Party',
  partyRef: partyRef('party-c'),
  partyType: 'ORGANIZATION',
  revision: 3,
  updatedAt: '2026-09-03T10:00:00.000Z',
};
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
      Effect.succeed(aliases.find(({ aliasPartyId }) => aliasPartyId === partyId) ?? null),
    partyExists: (_tenantId, partyId) => Effect.succeed(party?.partyRef.resourceId === partyId),
  });
  return {
    lookups,
    services: {
      facts: () => Effect.succeed({ currentFactAssertions: [], factHistory: null }),
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

test('Party Detail reads the final canonical Party after the complete historical alias chain', () => {
  const { lookups, services } = makeServices([
    alias('party-b', 'party-a'),
    alias('party-a', 'party-c'),
  ]);
  const result = Effect.runSync(
    readPartyDetailFromServices(partyRef('party-b'), tenantId, services),
  );

  assert.deepEqual(result, {
    currentFactAssertions: [],
    factHistory: null,
    party: canonicalParty,
    resolution: {
      aliasChain: [partyRef('party-b'), partyRef('party-a')],
      canonicalPartyRef: partyRef('party-c'),
      kind: 'ALIAS',
      requestedPartyRef: partyRef('party-b'),
    },
  });
  assert.deepEqual(lookups, ['party-c']);
  assert.deepEqual(Schema.decodeUnknownSync(PartyDetailResponseSchema)(result), result);
});

test('Party Detail preserves archived lifecycle independently of direct resolution metadata', () => {
  const archivedParty = { ...canonicalParty, archivedAt: '2026-09-02T10:00:00.000Z' };
  const { services } = makeServices([], archivedParty);
  const result = Effect.runSync(
    readPartyDetailFromServices(partyRef('party-c'), tenantId, services),
  );

  assert.equal(result.party.archivedAt, '2026-09-02T10:00:00.000Z');
  assert.deepEqual(result.resolution, {
    aliasChain: [],
    canonicalPartyRef: partyRef('party-c'),
    kind: 'DIRECT',
    requestedPartyRef: partyRef('party-c'),
  });
});

test('Party Detail fails closed for cycles and broken historical chains without reading an alias Party', () => {
  for (const aliases of [
    [alias('party-a', 'party-b'), alias('party-b', 'party-a')],
    [alias('party-a', 'missing')],
  ]) {
    const { lookups, services } = makeServices(aliases);
    const error = Effect.runSync(
      Effect.flip(readPartyDetailFromServices(partyRef('party-a'), tenantId, services)),
    );
    assert.equal(error._tag, 'ReadHandlerUnavailable');
    assert.deepEqual(lookups, []);
  }
});

test('Party Detail hides a missing direct Party and a cross-tenant requested reference', () => {
  const { lookups, services } = makeServices([]);
  for (const requested of [
    partyRef('missing'),
    { ...partyRef('party-c'), tenantId: otherTenantId },
  ]) {
    const error = Effect.runSync(
      Effect.flip(readPartyDetailFromServices(requested, tenantId, services)),
    );
    assert.equal(error._tag, 'ReadHandlerNotFound');
  }
  assert.deepEqual(lookups, []);
});
