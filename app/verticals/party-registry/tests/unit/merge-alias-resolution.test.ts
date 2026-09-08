import { expect, it } from '@app/effect-rstest';

import { DateTime, Predicate } from 'effect';
import type { PartyRef } from '../../shared/resources/party.ts';
import {
  assertCanonicalWriteTarget,
  resolveCanonicalPartyRef,
} from '../../src/merge/party-alias-resolution.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const party = (resourceId: string, tenant = tenantId): PartyRef => ({
  moduleId: 'party.registry',
  resourceId,
  resourceType: 'party.registry.party',
  tenantId: tenant,
});
const alias = (aliasPartyId: string, survivorPartyId: string, tenant = tenantId) => ({
  aliasPartyRef: party(aliasPartyId, tenant),
  createdAt: DateTime.makeUnsafe('2026-01-01T00:00:00.000Z'),
  mergeRef: {
    moduleId: 'party.registry' as const,
    resourceId: `merge-${aliasPartyId}`,
    resourceType: 'party.registry.party-merge' as const,
    tenantId: tenant,
  },
  survivorPartyRef: party(survivorPartyId, tenant),
});

it('resolves an historical alias chain to one final canonical Party', () => {
  const result = resolveCanonicalPartyRef(party('party-b'), [
    alias('party-b', 'party-a'),
    alias('party-a', 'party-c'),
  ]);

  expect(result).toEqual({
    _tag: 'CanonicalPartyResolved',
    canonicalPartyRef: party('party-c'),
    requestedAlias: party('party-b'),
    traversedAliasPartyRefs: [party('party-b'), party('party-a')],
  });
});

it('rejects alias cycles, self aliases, and cross-tenant targets', () => {
  expect(
    Predicate.isTagged(
      resolveCanonicalPartyRef(party('party-a'), [
        alias('party-a', 'party-b'),
        alias('party-b', 'party-a'),
      ]),
      'PartyAliasCycleRejected',
    ),
  ).toBe(true);
  expect(
    Predicate.isTagged(
      resolveCanonicalPartyRef(party('party-a'), [alias('party-a', 'party-a')]),
      'PartyAliasSelfReferenceRejected',
    ),
  ).toBe(true);
  expect(
    Predicate.isTagged(
      resolveCanonicalPartyRef(party('party-a'), [
        {
          ...alias('party-a', 'party-b'),
          survivorPartyRef: party('party-b', '22222222-2222-4222-8222-222222222222'),
        },
      ]),
      'PartyAliasCrossTenantRejected',
    ),
  ).toBe(true);
});

it('rejects new writes addressed to an absorbed alias instead of forwarding them', () => {
  expect(assertCanonicalWriteTarget(party('party-b'), [alias('party-b', 'party-a')])).toEqual({
    _tag: 'AliasWriteRejected',
    aliasPartyRef: party('party-b'),
    canonicalPartyRef: party('party-a'),
    code: 'ALIAS_WRITE_FORBIDDEN',
  });
  expect(assertCanonicalWriteTarget(party('party-a'), [alias('party-b', 'party-a')])).toEqual({
    _tag: 'CanonicalWriteTargetAccepted',
    partyRef: party('party-a'),
  });
});
