import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import { makePartyAliasResolutionService } from '../../src/merge/party-alias-resolution.service.ts';
import type { PartyAliasLookup } from '../../src/merge/party-alias-resolution.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const lookup = (overrides: Partial<PartyAliasLookup> = {}): PartyAliasLookup => ({
  findAlias: (requestedTenantId, aliasPartyId) =>
    Effect.succeed(
      new Map([
        ['party-b', { aliasPartyId: 'party-b', canonicalPartyId: 'party-a', tenantId }],
        ['party-a', { aliasPartyId: 'party-a', canonicalPartyId: 'party-c', tenantId }],
      ]).get(aliasPartyId) ?? null,
    ),
  partyExists: (_requestedTenantId, partyId) => Effect.succeed(partyId === 'party-c'),
  ...overrides,
});

test('central resolution service walks the complete canonical alias chain in one scoped transaction seam', () => {
  const service = makePartyAliasResolutionService(lookup());
  const result = Effect.runSync(service.resolvePartyAlias(tenantId, 'party-b'));

  assert.deepEqual(result, {
    canonicalPartyId: 'party-c',
    requestedPartyId: 'party-b',
    traversedAliasIds: ['party-b', 'party-a'],
    wasAlias: true,
  });
});

test('central resolution fails closed for cycles, cross-tenant targets, and broken chains', () => {
  const cycle = makePartyAliasResolutionService(
    lookup({
      findAlias: (_requestedTenantId, aliasPartyId) =>
        Effect.succeed(
          aliasPartyId === 'party-a'
            ? { aliasPartyId: 'party-a', canonicalPartyId: 'party-b', tenantId }
            : { aliasPartyId: 'party-b', canonicalPartyId: 'party-a', tenantId },
        ),
    }),
  );
  const cycleError = Effect.runSync(Effect.flip(cycle.resolvePartyAlias(tenantId, 'party-a')));
  assert.equal(cycleError._tag, 'PartyAliasResolutionCycle');

  const crossTenant = makePartyAliasResolutionService(
    lookup({
      findAlias: () =>
        Effect.succeed({
          aliasPartyId: 'party-b',
          canonicalPartyId: 'party-a',
          tenantId: '22222222-2222-4222-8222-222222222222',
        }),
    }),
  );
  const crossTenantError = Effect.runSync(
    Effect.flip(crossTenant.resolvePartyAlias(tenantId, 'party-b')),
  );
  assert.equal(crossTenantError._tag, 'PartyAliasResolutionCrossTenant');

  const broken = makePartyAliasResolutionService(
    lookup({ findAlias: () => Effect.succeed(null), partyExists: () => Effect.succeed(false) }),
  );
  const brokenError = Effect.runSync(Effect.flip(broken.resolvePartyAlias(tenantId, 'missing')));
  assert.equal(brokenError._tag, 'PartyAliasResolutionBrokenChain');
});

test('central write guard returns typed canonical-survivor guidance and never forwards', () => {
  const service = makePartyAliasResolutionService(lookup());
  const rejection = Effect.runSync(
    Effect.flip(service.requireCanonicalWriteTarget(tenantId, 'party-b')),
  );

  assert.equal(rejection._tag, 'PartyAliasWriteRejected');
  assert.deepEqual(rejection.aliasPartyRef, {
    moduleId: 'party.registry',
    resourceId: 'party-b',
    resourceType: 'party.registry.party',
    tenantId,
  });
  assert.deepEqual(rejection.canonicalPartyRef, {
    moduleId: 'party.registry',
    resourceId: 'party-c',
    resourceType: 'party.registry.party',
    tenantId,
  });
  assert.equal(rejection.code, 'party_alias_write_rejected');
});
