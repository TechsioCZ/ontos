import { Effect, Match, Option, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeBatchPartyAliasResolution, makePartyAliasResolutionService } from '../../src/merge/party-alias-resolution.service.ts';
import type { PartyAliasLookup } from '../../src/merge/party-alias-resolution.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const lookup = (overrides: Partial<PartyAliasLookup> = {}): PartyAliasLookup => ({
  findAlias: (requestedTenantId, aliasPartyId) =>
    Effect.succeed(
      Option.fromNullishOr(
        new Map([
          ['party-b', { aliasPartyId: 'party-b', canonicalPartyId: 'party-a', tenantId }],
          ['party-a', { aliasPartyId: 'party-a', canonicalPartyId: 'party-c', tenantId }],
        ]).get(aliasPartyId),
      ),
    ),
  partyExists: (_requestedTenantId, partyId) => Effect.succeed(partyId === 'party-c'),
  ...overrides,
});

it.effect('central resolution service walks the complete canonical alias chain in one scoped transaction seam', () =>
  Effect.gen(function* aliasResolution1() {
    const service = makePartyAliasResolutionService(lookup());
    const result = yield* service.resolvePartyAlias(tenantId, 'party-b');

    expect(result).toEqual({
      canonicalPartyId: 'party-c',
      requestedPartyId: 'party-b',
      traversedAliasIds: ['party-b', 'party-a'],
      wasAlias: true,
    });
  }),
);

it.effect('central resolution fails closed for cycles, cross-tenant targets, and broken chains', () =>
  Effect.gen(function* aliasResolution2() {
    const cycle = makePartyAliasResolutionService(
      lookup({
        findAlias: (_requestedTenantId, aliasPartyId) =>
          Effect.succeedSome(
            aliasPartyId === 'party-a'
              ? {
                  aliasPartyId: 'party-a',
                  canonicalPartyId: 'party-b',
                  tenantId,
                }
              : {
                  aliasPartyId: 'party-b',
                  canonicalPartyId: 'party-a',
                  tenantId,
                },
          ),
      }),
    );
    const cycleError = yield* Effect.flip(cycle.resolvePartyAlias(tenantId, 'party-a'));
    expect(Predicate.isTagged(cycleError, 'PartyAliasResolutionCycle')).toBe(true);

    const crossTenant = makePartyAliasResolutionService(
      lookup({
        findAlias: () =>
          Effect.succeedSome({
            aliasPartyId: 'party-b',
            canonicalPartyId: 'party-a',
            tenantId: '22222222-2222-4222-8222-222222222222',
          }),
      }),
    );
    const crossTenantError = yield* Effect.flip(crossTenant.resolvePartyAlias(tenantId, 'party-b'));
    expect(Predicate.isTagged(crossTenantError, 'PartyAliasResolutionCrossTenant')).toBe(true);

    const broken = makePartyAliasResolutionService(
      lookup({
        findAlias: () => Effect.succeedNone,
        partyExists: () => Effect.succeed(false),
      }),
    );
    const brokenError = yield* Effect.flip(broken.resolvePartyAlias(tenantId, 'missing'));
    expect(Predicate.isTagged(brokenError, 'PartyAliasResolutionBrokenChain')).toBe(true);
  }),
);

it.effect('central write guard returns typed canonical-survivor guidance and never forwards', () =>
  Effect.gen(function* aliasResolution3() {
    const service = makePartyAliasResolutionService(lookup());
    const rejection = yield* Effect.flip(service.requireCanonicalWriteTarget(tenantId, 'party-b'));

    expect(Predicate.isTagged(rejection, 'PartyAliasWriteRejected')).toBe(true);
    const aliasRejection = Match.value(rejection).pipe(
      Match.tag('PartyAliasWriteRejected', (failure) => failure),
      Match.orElse(() => {
        throw new Error('Expected alias write rejection');
      }),
    );
    expect(aliasRejection.aliasPartyRef).toEqual({
      moduleId: 'party.registry',
      resourceId: 'party-b',
      resourceType: 'party.registry.party',
      tenantId,
    });
    expect(aliasRejection.canonicalPartyRef).toEqual({
      moduleId: 'party.registry',
      resourceId: 'party-c',
      resourceType: 'party.registry.party',
      tenantId,
    });
    expect(rejection.code).toBe('party_alias_write_rejected');
  }),
);

const batchLookup = (aliases: readonly { readonly aliasPartyId: string; readonly canonicalPartyId: string; readonly tenantId: string }[], parties: readonly string[]) => {
  const calls: string[] = [];
  return {
    calls,
    lookup: {
      existingParties: (_tenantId: string, ids: readonly string[]) => {
        calls.push(`parties:${ids.join(',')}`);
        return Effect.succeed(new Set(ids.filter((id) => parties.includes(id))) as ReadonlySet<string>);
      },
      findAliases: (_tenantId: string, ids: readonly string[]) => {
        calls.push(`aliases:${ids.join(',')}`);
        return Effect.succeed(aliases.filter((alias) => ids.includes(alias.aliasPartyId)));
      },
    },
  };
};

it.effect('batch resolution matches the per-Party service with two lookups per chain level', () =>
  Effect.gen(function* batchAliasResolution1() {
    const { calls, lookup: batch } = batchLookup(
      [
        { aliasPartyId: 'party-b', canonicalPartyId: 'party-a', tenantId },
        { aliasPartyId: 'party-a', canonicalPartyId: 'party-c', tenantId },
      ],
      ['party-c', 'party-d'],
    );
    const resolved = yield* makeBatchPartyAliasResolution(batch)(tenantId, ['party-b', 'party-d', 'party-a', 'party-d']);
    const single = makePartyAliasResolutionService(lookup({ partyExists: (_tenantId, partyId) => Effect.succeed(partyId === 'party-c' || partyId === 'party-d') }));
    for (const partyId of ['party-b', 'party-d', 'party-a']) {
      expect(resolved.get(partyId)).toBe((yield* single.resolvePartyAlias(tenantId, partyId)).canonicalPartyId);
    }
    expect(resolved.size).toBe(3);
    expect(calls).toEqual([
      'aliases:party-b,party-d,party-a',
      'parties:party-d',
      'aliases:party-a,party-c',
      'parties:party-c',
      'aliases:party-c',
      'parties:party-c',
    ]);
  }),
);

it.effect('batch resolution fails closed for cycles, cross-tenant targets, and broken chains', () =>
  Effect.gen(function* batchAliasResolution2() {
    const cycle = batchLookup(
      [
        { aliasPartyId: 'party-a', canonicalPartyId: 'party-b', tenantId },
        { aliasPartyId: 'party-b', canonicalPartyId: 'party-a', tenantId },
      ],
      [],
    );
    const cycleError = yield* Effect.flip(makeBatchPartyAliasResolution(cycle.lookup)(tenantId, ['party-a']));
    expect(Predicate.isTagged(cycleError, 'PartyAliasResolutionCycle')).toBe(true);

    const crossTenant = batchLookup([{ aliasPartyId: 'party-a', canonicalPartyId: 'party-b', tenantId: 'other' }], ['party-b']);
    const crossError = yield* Effect.flip(makeBatchPartyAliasResolution(crossTenant.lookup)(tenantId, ['party-a']));
    expect(Predicate.isTagged(crossError, 'PartyAliasResolutionCrossTenant')).toBe(true);

    const broken = batchLookup([], ['party-a']);
    const brokenError = yield* Effect.flip(makeBatchPartyAliasResolution(broken.lookup)(tenantId, ['party-a', 'party-x']));
    expect(Predicate.isTagged(brokenError, 'PartyAliasResolutionBrokenChain')).toBe(true);
  }),
);
