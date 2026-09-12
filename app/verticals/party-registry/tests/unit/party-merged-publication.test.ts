import { expect, it } from 'effect-rstest';
import { DateTime, Effect, Predicate, Schema } from 'effect';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '../../shared/outbox/party-registry-party-merged-v1.ts';
import type { PartyMerge } from '../../shared/resources/party-merge.ts';
import type { PartyRef } from '../../shared/resources/party.ts';
import {
  createPartyMergedOutboxMessage,
  createPartyMergedPayload,
  evaluatePartyMergedPublicationGate,
  PartyMergedPublicationDisabled,
  publishPartyMerged,
} from '../../src/merge/party-merged-publication.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const party = (resourceId: string): PartyRef => ({
  moduleId: 'party.registry',
  resourceId,
  resourceType: 'party.registry.party',
  tenantId,
});
const merge: PartyMerge = {
  absorbedPartyRefs: [party('party-b'), party('party-c')],
  confirmedDuplicateDecisionId: 'decision-1',
  createdAt: DateTime.makeUnsafe('2026-09-09T09:00:00.000Z'),
  decisionActorPrincipalId: 'principal-1',
  mergeRef: {
    moduleId: 'party.registry',
    resourceId: 'merge-1',
    resourceType: 'party.registry.party-merge',
    tenantId,
  },
  policyVersion: 'party-merge.v1',
  selectionEvidenceChain: [],
  selectionReason: 'AUTHORITATIVE_EVIDENCE',
  state: 'PREPARED',
  survivorPartyRef: party('party-a'),
};

it.effect('publishes the exact identity-only PartyMerged v1 contract', () =>
  Effect.gen(function* exactPartyMergedContract() {
    const payload = createPartyMergedPayload(merge, '2026-09-09T10:00:00.000Z');
    const decoded = yield* Schema.decodeEffect(OutboxPayloadSchema, {
      onExcessProperty: 'error',
    })(payload);
    expect(decoded.absorbedPartyRefs).toEqual([party('party-b'), party('party-c')]);
    expect(decoded.mergeId).toBe('merge-1');
    expect(decoded.occurredAt).toBe('2026-09-09T10:00:00.000Z');
    expect(decoded.policyVersion).toBe('party-merge.v1');
    expect(decoded.survivorPartyRef).toEqual(party('party-a'));
    expect(decoded.tenantId).toBe(tenantId);
    expect(Object.keys(payload).toSorted()).toEqual([
      'absorbedPartyRefs',
      'mergeId',
      'occurredAt',
      'policyVersion',
      'survivorPartyRef',
      'tenantId',
    ]);
    expect(createPartyMergedOutboxMessage(payload)).toEqual({
      payloadJson: payload,
      producerModuleKey: outboxProducerModuleKey,
      topic: outboxTopic,
    });
  }),
);

it('rejects cross-tenant, duplicate, and survivor-in-absorbed event identities', () => {
  const payload = createPartyMergedPayload(merge, '2026-09-09T10:00:00.000Z');
  expect(() =>
    Schema.decodeSync(OutboxPayloadSchema)({
      ...payload,
      absorbedPartyRefs: [party('party-b'), { ...party('party-c'), tenantId: '22222222-2222-4222-8222-222222222222' }],
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeSync(OutboxPayloadSchema)({
      ...payload,
      absorbedPartyRefs: [party('party-b'), party('party-b')],
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeSync(OutboxPayloadSchema)({
      ...payload,
      absorbedPartyRefs: [party('party-a')],
    }),
  ).toThrow();
});

it.effect('keeps publication disabled after complete consumer reconciliation evidence', () =>
  Effect.gen(function* disabledPublication() {
    const evidence = [
      {
        collisionBehaviorTested: true,
        consumerKey: 'commerce.customer-context',
        evidenceRefs: ['test:commerce-customer-context-party-merge-reconciliation'],
        idempotent: true,
        partialRetrySupported: true,
      },
    ];
    const gate = evaluatePartyMergedPublicationGate(['commerce.customer-context'], evidence);
    expect(gate).toEqual({
      blockers: [{ code: 'PRODUCTION_MERGE_DISABLED', ownerKey: 'party.registry' }],
      publicationEnabled: false,
      status: 'DISABLED',
    });

    const failure = yield* publishPartyMerged(['commerce.customer-context'], evidence).pipe(Effect.flip);
    expect(Predicate.isTagged(failure, 'PartyMergedPublicationDisabled')).toBe(true);
    expect(Schema.is(PartyMergedPublicationDisabled)(failure)).toBe(true);
    expect(failure.publicationEnabled).toBe(false);
    expect(failure.blockers).toEqual([{ code: 'PRODUCTION_MERGE_DISABLED', ownerKey: 'party.registry' }]);
  }),
);

it('reports missing and partial-retry consumer evidence without duplicate owner blockers', () => {
  const gate = evaluatePartyMergedPublicationGate(
    ['missing.consumer', 'partial.consumer', 'missing.consumer'],
    [
      {
        collisionBehaviorTested: true,
        consumerKey: 'partial.consumer',
        evidenceRefs: ['test:partial'],
        idempotent: true,
        partialRetrySupported: false,
      },
    ],
  );

  expect(gate.blockers).toEqual([
    { code: 'PRODUCTION_MERGE_DISABLED', ownerKey: 'party.registry' },
    { code: 'CONSUMER_RECONCILIATION_UNPROVEN', ownerKey: 'missing.consumer' },
    { code: 'CONSUMER_PARTIAL_RETRY_UNPROVEN', ownerKey: 'partial.consumer' },
  ]);
});
