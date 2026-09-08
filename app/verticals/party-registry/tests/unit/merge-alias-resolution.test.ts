import { expect, it } from 'effect-rstest';

import { DateTime, Predicate, Struct, Schema } from 'effect';
import type { PartyRef } from '../../shared/resources/party.ts';
import {
  CanonicalPartyResolutionSchema,
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

  expect(Schema.is(CanonicalPartyResolutionSchema.members[1])(result)).toBe(true);
  expect(Struct.omit(result, ['_tag'])).toEqual({
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
  const aliasWriteRejection = assertCanonicalWriteTarget(party('party-b'), [
    alias('party-b', 'party-a'),
  ]);
  expect(Predicate.isTagged(aliasWriteRejection, 'AliasWriteRejected')).toBe(true);
  expect(Struct.omit(aliasWriteRejection, ['_tag'])).toEqual({
    aliasPartyRef: party('party-b'),
    canonicalPartyRef: party('party-a'),
    code: 'ALIAS_WRITE_FORBIDDEN',
  });
  const canonicalWriteAcceptance = assertCanonicalWriteTarget(party('party-a'), [
    alias('party-b', 'party-a'),
  ]);
  expect(Predicate.isTagged(canonicalWriteAcceptance, 'CanonicalWriteTargetAccepted')).toBe(true);
  expect(Struct.omit(canonicalWriteAcceptance, ['_tag'])).toEqual({
    partyRef: party('party-a'),
  });
});
