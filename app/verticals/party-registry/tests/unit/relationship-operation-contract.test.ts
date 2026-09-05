import assert from 'node:assert/strict';
import test from 'node:test';
import { Schema } from 'effect';
import { createPartyRelationshipAction } from '../../src/actions/create-party-relationship.action.ts';
import { endPartyRelationshipAction } from '../../src/actions/end-party-relationship.action.ts';
import { updatePartyRelationshipAction } from '../../src/actions/update-party-relationship.action.ts';
import { partyRelationshipDetailRead } from '../../src/api/party-relationship-detail.read.ts';
import {
  PartyRelationshipDetailRequestSchema,
  PartyRelationshipDetailResponseSchema,
} from '../../shared/apis/party-relationship-detail.ts';
import { OutboxPayloadSchema as RelationshipCreatedOutboxSchema } from '../../shared/outbox/party-registry-relationship-created-v1.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const partyRef = (resourceId: string) => ({
  moduleId: 'party.registry' as const,
  resourceId,
  resourceType: 'party.registry.party' as const,
  tenantId,
});
const relationshipRef = {
  moduleId: 'party.registry',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'party.registry.party-relationship',
  tenantId,
} as const;

test('relationship writes are idempotent tenant Actions with dedicated authority', () => {
  const actions = [
    createPartyRelationshipAction,
    updatePartyRelationshipAction,
    endPartyRelationshipAction,
  ] as const;
  assert.deepEqual(
    actions.map(({ descriptor }) => descriptor.actionKey),
    [
      'party.registry.create-party-relationship',
      'party.registry.update-party-relationship',
      'party.registry.end-party-relationship',
    ],
  );
  for (const { descriptor } of actions) {
    assert.equal(descriptor.idempotency, 'required');
    assert.equal(descriptor.legalEntityScope, 'optional');
    assert.equal(descriptor.owningModuleKey, 'party.registry');
    // SAFETY: These resolvers are intentionally payload-independent tenant authority declarations.
    assert.equal(descriptor.tenantPermission?.({} as never), 'manage_party_relationships');
  }
  assert.deepEqual(Object.keys(createPartyRelationshipAction.descriptor.domainEvents), [
    'party.registry.relationship-created.v1',
  ]);
  assert.deepEqual(Object.keys(updatePartyRelationshipAction.descriptor.domainEvents), [
    'party.registry.relationship-updated.v1',
  ]);
  assert.deepEqual(Object.keys(endPartyRelationshipAction.descriptor.domainEvents), [
    'party.registry.relationship-ended.v1',
  ]);
});

test('relationship detail is a tenant-authorized governed read of one ResourceRef', () => {
  assert.equal(partyRelationshipDetailRead.descriptor.legalEntityScope, 'optional');
  assert.equal(partyRelationshipDetailRead.descriptor.permissionTarget, 'tenant');
  assert.equal(partyRelationshipDetailRead.descriptor.accessKind, 'detail');
  assert.deepEqual(
    Schema.decodeUnknownSync(PartyRelationshipDetailRequestSchema)({ relationshipRef }),
    { relationshipRef },
  );
});

test('relationship detail preserves canonical and stored alias endpoint context', () => {
  const storedFrom = partyRef('22222222-2222-4222-8222-222222222222');
  const canonicalFrom = partyRef('55555555-5555-4555-8555-555555555555');
  const to = partyRef('33333333-3333-4333-8333-333333333333');
  const detail = Schema.decodeUnknownSync(PartyRelationshipDetailResponseSchema)({
    assertionState: 'ACTIVE',
    endHistory: [
      {
        effectiveAt: '2026-09-01T00:00:00.000Z',
        provenance: { method: 'MANUAL_CONFIRMATION', source: 'ENGAGEMENT_REVIEW' },
        reason: 'No longer the contact',
        recordedAt: '2026-08-20T10:00:00.000Z',
      },
    ],
    from: {
      canonicalPartyRef: canonicalFrom,
      requestedAlias: storedFrom,
      storedPartyRef: storedFrom,
    },
    provenance: { method: 'MANUAL_CONFIRMATION', source: 'ENGAGEMENT_REVIEW' },
    recordedAt: '2026-09-01T10:00:00.000Z',
    relationshipRef,
    relationshipType: 'CONTACT_PERSON_OF',
    revision: 4,
    state: 'HISTORICAL',
    to: { canonicalPartyRef: to, requestedAlias: null, storedPartyRef: to },
    validFrom: '2026-01-01T00:00:00.000Z',
    validTo: '2026-09-01T00:00:00.000Z',
  });
  assert.equal(detail.from.canonicalPartyRef.resourceId, canonicalFrom.resourceId);
  assert.equal(detail.from.requestedAlias?.resourceId, storedFrom.resourceId);
  assert.equal(detail.state, 'HISTORICAL');
  assert.equal(detail.endHistory[0]?.reason, 'No longer the contact');
});

test('outbox payloads carry stable refs and no mutable Party or authorization copy', () => {
  const payload = {
    fromPartyRef: partyRef('22222222-2222-4222-8222-222222222222'),
    relationshipRef,
    relationshipType: 'CONTACT_PERSON_OF',
    revision: 1,
    toPartyRef: partyRef('33333333-3333-4333-8333-333333333333'),
    validFrom: '2026-09-01T10:00:00.000Z',
    validTo: null,
  } as const;
  assert.deepEqual(Schema.decodeUnknownSync(RelationshipCreatedOutboxSchema)(payload), payload);
  assert.throws(() =>
    Schema.decodeUnknownSync(RelationshipCreatedOutboxSchema, { onExcessProperty: 'error' })({
      ...payload,
      authorizationGranted: true,
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(RelationshipCreatedOutboxSchema, { onExcessProperty: 'error' })({
      ...payload,
      party: { displayName: 'mutable copy' },
    }),
  );
});
