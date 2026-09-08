import { expect, it } from '@app/effect-rstest';
import { Effect, DateTime, Option, Schema } from 'effect';
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

it('relationship writes are idempotent tenant Actions with dedicated authority', () => {
  const actions = [
    createPartyRelationshipAction,
    updatePartyRelationshipAction,
    endPartyRelationshipAction,
  ] as const;
  expect(actions.map(({ descriptor }) => descriptor.actionKey)).toEqual([
    'party.registry.create-party-relationship',
    'party.registry.update-party-relationship',
    'party.registry.end-party-relationship',
  ]);
  for (const { descriptor } of actions) {
    expect(descriptor.idempotency).toBe('required');
    expect(descriptor.legalEntityScope).toBe('optional');
    expect(descriptor.owningModuleKey).toBe('party.registry');
    // SAFETY: These resolvers are intentionally payload-independent tenant authority declarations.
    expect(descriptor.tenantPermission?.({} as never)).toBe('manage_party_relationships');
  }
  expect(Object.keys(createPartyRelationshipAction.descriptor.domainEvents)).toEqual([
    'party.registry.relationship-created.v1',
  ]);
  expect(Object.keys(updatePartyRelationshipAction.descriptor.domainEvents)).toEqual([
    'party.registry.relationship-updated.v1',
  ]);
  expect(Object.keys(endPartyRelationshipAction.descriptor.domainEvents)).toEqual([
    'party.registry.relationship-ended.v1',
  ]);
});

it.effect('relationship detail is a tenant-authorized governed read of one ResourceRef', () =>
  Effect.gen(function* schemaContract1() {
    expect(partyRelationshipDetailRead.descriptor.legalEntityScope).toBe('optional');
    expect(partyRelationshipDetailRead.descriptor.permissionTarget).toBe('tenant');
    expect(partyRelationshipDetailRead.descriptor.accessKind).toBe('detail');
    expect(
      yield* Schema.decodeUnknownEffect(PartyRelationshipDetailRequestSchema)({ relationshipRef }),
    ).toEqual({ relationshipRef });
  }),
);

it.effect('relationship detail preserves canonical and stored alias endpoint context', () =>
  Effect.gen(function* schemaContract2() {
    const storedFrom = partyRef('22222222-2222-4222-8222-222222222222');
    const canonicalFrom = partyRef('55555555-5555-4555-8555-555555555555');
    const to = partyRef('33333333-3333-4333-8333-333333333333');
    const detail = yield* Schema.decodeUnknownEffect(PartyRelationshipDetailResponseSchema)({
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
    expect(detail.from.canonicalPartyRef.resourceId).toBe(canonicalFrom.resourceId);
    expect(Option.getOrThrow(detail.from.requestedAlias).resourceId).toBe(storedFrom.resourceId);
    expect(detail.state).toBe('HISTORICAL');
    const [endEvidence] = detail.endHistory;
    expect(endEvidence).toBeDefined();
    if (endEvidence === undefined) {
      throw new Error('Expected endEvidence');
    }
    expect(Option.getOrThrow(endEvidence.reason)).toBe('No longer the contact');
    expect(DateTime.formatIso(Option.getOrThrow(detail.validTo))).toBe('2026-09-01T00:00:00.000Z');
  }),
);

it.effect('outbox payloads carry stable refs and no mutable Party or authorization copy', () =>
  Effect.gen(function* schemaContract3() {
    const payload = {
      fromPartyRef: partyRef('22222222-2222-4222-8222-222222222222'),
      relationshipRef,
      relationshipType: 'CONTACT_PERSON_OF',
      revision: 1,
      toPartyRef: partyRef('33333333-3333-4333-8333-333333333333'),
      validFrom: '2026-09-01T10:00:00.000Z',
      validTo: null,
    } as const;
    const decoded = yield* Schema.decodeUnknownEffect(RelationshipCreatedOutboxSchema)(payload);
    expect(yield* Schema.encodeEffect(RelationshipCreatedOutboxSchema)(decoded)).toEqual(payload);
    expect(() =>
      Schema.decodeUnknownSync(RelationshipCreatedOutboxSchema, { onExcessProperty: 'error' })({
        ...payload,
        authorizationGranted: true,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(RelationshipCreatedOutboxSchema, { onExcessProperty: 'error' })({
        ...payload,
        party: { displayName: 'mutable copy' },
      }),
    ).toThrow();
  }),
);
