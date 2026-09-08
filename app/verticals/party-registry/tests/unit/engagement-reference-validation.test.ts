import assert from 'node:assert/strict';
import test from 'node:test';

import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import { Effect } from 'effect';

import type { PartyRef } from '../../shared/party-registry-references.ts';
import { validatePartyRegistryReferences } from '../../src/services/engagement-reference-validation.service.ts';
import type { PartyRegistryReferenceOperations } from '../../src/services/engagement-reference-validation.service.ts';

const tenantId = 'c1000000-0000-4000-8000-000000000001';
const partyRef: PartyRef = {
  moduleId: 'party.registry',
  resourceId: 'c2000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party',
  tenantId,
};

const operations: PartyRegistryReferenceOperations = {
  readCounterparty: () => Effect.die('Counterparty lookup is not expected'),
  readParty: (requestedPartyRef) =>
    Effect.succeed({
      archived: false,
      partyRef: requestedPartyRef,
      partyType: 'ORGANIZATION',
      requestedPartyRef,
    }),
};

test('validates engagement references through owner-local Party Registry operations', () =>
  runEffectTestPromise(
    validatePartyRegistryReferences(
      operations,
      { partyRef },
      { expectedPartyType: 'ORGANIZATION' }
    )
  ));

test('rejects a profile whose Party type belongs to a different engagement kind', () =>
  runEffectTestPromise(
    Effect.gen(function* verifyPartyTypeMismatch() {
      const error = yield* Effect.flip(
        validatePartyRegistryReferences(
          operations,
          { partyRef },
          { expectedPartyType: 'PERSON' }
        )
      );
      assert.equal(error.code, 'contacts_party_type_mismatch');
    })
  ));
