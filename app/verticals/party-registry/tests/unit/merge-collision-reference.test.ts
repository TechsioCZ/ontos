import assert from 'node:assert/strict';
import test from 'node:test';
import type { PartyRef } from '../../shared/resources/party.ts';
import { analyzeMergeCollisions } from '../../src/merge/merge-collision-analysis.ts';
import { planReferencePreservation } from '../../src/merge/reference-preservation-plan.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const party = (resourceId: string): PartyRef => ({
  moduleId: 'party.registry',
  resourceId,
  resourceType: 'party.registry.party',
  tenantId,
});

test('blocks authoritative non-strong identifier conflicts without unrelated relationship blockers', () => {
  const collisions = analyzeMergeCollisions({
    absorbedPartyRefs: [party('party-b')],
    connectorCorrelations: [],
    consumerProfiles: [],
    counterparties: [],
    counterpartyRoles: [],
    officialIdentifiers: ['party-a', 'party-b'].map((id) => ({
      active: true,
      authoritative: true,
      identifierId: `id-${id}`,
      identifierTypeKey: 'REGISTRY_ID',
      namespace: 'registry',
      normalizedValue: id,
      partyRef: party(id),
      strongClaim: false,
    })),
    relationships: ['unrelated-1', 'unrelated-2'].map((relationshipId) => ({
      forbidsOverlap: true,
      fromPartyRef: party('unrelated-party'),
      relationshipId,
      relationshipTypeKey: 'CONTACT_PERSON_OF',
      toPartyRef: party('unrelated-party'),
      validFrom: '2025-01-01T00:00:00.000Z',
      validTo: null,
    })),
    survivorPartyRef: party('party-a'),
  });
  assert.deepEqual(
    collisions.map(({ code }) => code),
    ['STRONG_IDENTIFIER_CONFLICT'],
  );
});

test('requires reconciliation for Counterparty and consumer uniqueness collisions', () => {
  const collisions = analyzeMergeCollisions({
    absorbedPartyRefs: [party('party-b')],
    connectorCorrelations: [
      { connectorKey: 'erp', externalSubjectId: 'erp-a', partyRef: party('party-a') },
      { connectorKey: 'erp', externalSubjectId: 'erp-b', partyRef: party('party-b') },
    ],
    consumerProfiles: [
      {
        consumerKey: 'engagement',
        partyRef: party('party-a'),
        profileId: 'engagement-a',
        uniquePerParty: true,
      },
      {
        consumerKey: 'engagement',
        partyRef: party('party-b'),
        profileId: 'engagement-b',
        uniquePerParty: true,
      },
    ],
    counterparties: [
      { counterpartyId: 'cp-a', legalEntityId: 'le-1', partyRef: party('party-a') },
      { counterpartyId: 'cp-b', legalEntityId: 'le-1', partyRef: party('party-b') },
    ],
    counterpartyRoles: [],
    officialIdentifiers: [],
    relationships: [],
    survivorPartyRef: party('party-a'),
  });

  assert.deepEqual(
    collisions.map(({ code, ownerKey }) => ({ code, ownerKey })),
    [
      { code: 'COUNTERPARTY_COLLISION', ownerKey: 'party.registry' },
      { code: 'CONSUMER_PROFILE_COLLISION', ownerKey: 'engagement' },
      { code: 'CONNECTOR_CORRELATION_COLLISION', ownerKey: 'erp' },
    ],
  );
  assert.ok(collisions.every(({ resolution }) => resolution === 'RECONCILIATION_REQUIRED'));
});

test('blocks strong identifier conflicts and flags forbidden relationship and role overlaps', () => {
  const collisions = analyzeMergeCollisions({
    absorbedPartyRefs: [party('party-b')],
    connectorCorrelations: [],
    consumerProfiles: [],
    counterparties: [],
    counterpartyRoles: [
      {
        legalEntityId: 'le-1',
        partyRef: party('party-a'),
        rolePeriodId: 'role-a',
        roleType: 'CUSTOMER',
        validFrom: '2025-01-01T00:00:00.000Z',
        validTo: null,
      },
      {
        legalEntityId: 'le-1',
        partyRef: party('party-b'),
        rolePeriodId: 'role-b',
        roleType: 'CUSTOMER',
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: null,
      },
    ],
    officialIdentifiers: [
      {
        active: true,
        authoritative: true,
        identifierId: 'ico-a',
        identifierTypeKey: 'ICO',
        namespace: 'CZ',
        normalizedValue: '12345678',
        partyRef: party('party-a'),
        strongClaim: true,
      },
      {
        active: true,
        authoritative: false,
        identifierId: 'ico-b',
        identifierTypeKey: 'ICO',
        namespace: 'CZ',
        normalizedValue: '87654321',
        partyRef: party('party-b'),
        strongClaim: true,
      },
    ],
    relationships: [
      {
        forbidsOverlap: true,
        fromPartyRef: party('party-a'),
        relationshipId: 'relationship-a',
        relationshipTypeKey: 'CONTACT_PERSON_OF',
        toPartyRef: party('party-b'),
        validFrom: '2025-01-01T00:00:00.000Z',
        validTo: null,
      },
    ],
    survivorPartyRef: party('party-a'),
  });

  assert.deepEqual(
    collisions.map(({ code, resolution }) => ({ code, resolution })),
    [
      { code: 'STRONG_IDENTIFIER_CONFLICT', resolution: 'CORRECTION_REQUIRED' },
      { code: 'RELATIONSHIP_SELF_REFERENCE', resolution: 'RECONCILIATION_REQUIRED' },
      { code: 'COUNTERPARTY_ROLE_PERIOD_COLLISION', resolution: 'RECONCILIATION_REQUIRED' },
    ],
  );
});

test('plans canonical resolution for supported refs without rewriting historical snapshots', () => {
  const snapshot = Object.freeze({ address: 'Historical street 1', name: 'Historical Party B' });
  const result = planReferencePreservation({
    aliases: [
      {
        aliasPartyRef: party('party-b'),
        createdAt: '2026-01-01T00:00:00.000Z',
        mergeRef: {
          moduleId: 'party.registry',
          resourceId: 'merge-1',
          resourceType: 'party.registry.party-merge',
          tenantId,
        },
        survivorPartyRef: party('party-a'),
      },
    ],
    consumerReconciliation: [
      'core',
      'events',
      'engagement',
      'commerce',
      'connector.registry',
      'invoicing',
    ].map((consumerKey) => ({
      collisionBehaviorTested: true,
      consumerKey,
      evidenceRefs: [`test:${consumerKey}`],
      idempotent: true,
      partialRetrySupported: true,
    })),
    references: [
      { class: 'DIRECT_RESOURCE_REF', ownerKey: 'core', partyRef: party('party-b') },
      { class: 'EVENT_OR_OUTBOX_PAYLOAD', ownerKey: 'events', partyRef: party('party-b') },
      { class: 'COUNTERPARTY', ownerKey: 'party.registry', partyRef: party('party-b') },
      { class: 'ENGAGEMENT_PROFILE', ownerKey: 'engagement', partyRef: party('party-b') },
      { class: 'COMMERCE_PROFILE', ownerKey: 'commerce', partyRef: party('party-b') },
      {
        class: 'CONNECTOR_CORRELATION',
        ownerKey: 'connector.registry',
        partyRef: party('party-b'),
      },
      {
        class: 'HISTORICAL_DOCUMENT',
        historicalSnapshot: snapshot,
        ownerKey: 'invoicing',
        partyRef: party('party-b'),
      },
    ],
  });

  assert.equal(result._tag, 'ReferencePreservationPlanned');
  if (result._tag === 'ReferencePreservationPlanned') {
    assert.ok(
      result.references.every(
        ({ canonicalPartyRef }) => canonicalPartyRef.resourceId === 'party-a',
      ),
    );
    assert.deepEqual(result.references.at(-1)?.historicalSnapshot, snapshot);
    assert.equal(result.requiresPhysicalRewrite, false);
  }
});

test('detects overlapping resolved relationship periods but permits adjacent role periods', () => {
  const collisions = analyzeMergeCollisions({
    absorbedPartyRefs: [party('party-b')],
    connectorCorrelations: [],
    consumerProfiles: [],
    counterparties: [],
    counterpartyRoles: [
      {
        legalEntityId: 'le-1',
        partyRef: party('party-a'),
        rolePeriodId: 'role-a',
        roleType: 'CUSTOMER',
        validFrom: '2025-01-01T00:00:00.000Z',
        validTo: '2026-01-01T00:00:00.000Z',
      },
      {
        legalEntityId: 'le-1',
        partyRef: party('party-b'),
        rolePeriodId: 'role-b',
        roleType: 'CUSTOMER',
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: null,
      },
    ],
    officialIdentifiers: [],
    relationships: [
      {
        forbidsOverlap: true,
        fromPartyRef: party('party-a'),
        relationshipId: 'relationship-a',
        relationshipTypeKey: 'CONTACT_PERSON_OF',
        toPartyRef: party('party-outside'),
        validFrom: '2025-01-01T00:00:00.000Z',
        validTo: null,
      },
      {
        forbidsOverlap: true,
        fromPartyRef: party('party-b'),
        relationshipId: 'relationship-b',
        relationshipTypeKey: 'CONTACT_PERSON_OF',
        toPartyRef: party('party-outside'),
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: null,
      },
    ],
    survivorPartyRef: party('party-a'),
  });

  assert.deepEqual(collisions, [
    {
      code: 'RELATIONSHIP_PERIOD_COLLISION',
      ownerKey: 'party.registry',
      recordIds: ['relationship-a', 'relationship-b'],
      resolution: 'RECONCILIATION_REQUIRED',
    },
  ]);
});

test('blocks readiness for unsupported references and incomplete retry contracts', () => {
  const result = planReferencePreservation({
    aliases: [],
    consumerReconciliation: [
      {
        collisionBehaviorTested: true,
        consumerKey: 'engagement',
        evidenceRefs: ['test:engagement'],
        idempotent: true,
        partialRetrySupported: false,
      },
    ],
    references: [
      { class: 'UNSUPPORTED', ownerKey: 'custom-module', partyRef: party('party-b') },
      { class: 'ENGAGEMENT_PROFILE', ownerKey: 'engagement', partyRef: party('party-b') },
    ],
  });

  assert.deepEqual(result, {
    _tag: 'ReferencePreservationBlocked',
    blockers: [
      { code: 'UNSUPPORTED_REFERENCE_CLASS', ownerKey: 'custom-module' },
      { code: 'CONSUMER_PARTIAL_RETRY_UNPROVEN', ownerKey: 'engagement' },
    ],
  });
});

test('blocks every external reference owner without reconciliation evidence', () => {
  const result = planReferencePreservation({
    aliases: [],
    references: [{ class: 'COMMERCE_PROFILE', ownerKey: 'commerce', partyRef: party('party-b') }],
  });

  assert.deepEqual(result, {
    _tag: 'ReferencePreservationBlocked',
    blockers: [{ code: 'CONSUMER_RECONCILIATION_UNPROVEN', ownerKey: 'commerce' }],
  });
});
