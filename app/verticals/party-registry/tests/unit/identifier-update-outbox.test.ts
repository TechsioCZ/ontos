import { expect, it } from '@app/effect-rstest';
import { DateTime, Effect, Option, Schema } from 'effect';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionHandler } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { UpdatePartyOfficialIdentifierResultSchema } from '../../shared/actions/update-party-official-identifier.ts';
import type { UpdatePartyOfficialIdentifierPayload } from '../../shared/actions/update-party-official-identifier.ts';
import { OfficialIdentifierClaimConflict } from '../../shared/domain/identifier-contracts.ts';
import { OutboxPayloadSchema } from '../../shared/outbox/party-registry-official-identifier-updated-v1.ts';
import { updatePartyOfficialIdentifierAction } from '../../src/actions/update-party-official-identifier.action.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const partyRef = {
  moduleId: 'party.registry',
  resourceId: '20000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const officialIdentifierRef = {
  moduleId: 'party.registry',
  resourceId: '30000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party-official-identifier',
  tenantId,
} as const;
const before = {
  state: 'ACTIVE',
  validTo: null,
  verification: 'UNVERIFIED',
  verifiedAt: null,
  verifiedByPrincipalId: null,
} as const;
const changes: readonly UpdatePartyOfficialIdentifierPayload['change'][] = [
  { expectedVerification: 'UNVERIFIED', type: 'SET_VERIFICATION', verification: 'VERIFIED' },
  { type: 'END_VALIDITY', validTo: DateTime.makeUnsafe('2026-01-02T00:00:00.000Z') },
];

for (const change of changes) {
  it.effect(
    `${change.type} links one stable-reference outbox message to its committed Domain Event`,
    () =>
      Effect.gen(function* successfulUpdate() {
        const collector = createActionCollector(
          updatePartyOfficialIdentifierAction.descriptor.domainEvents,
          'party.registry',
          updatePartyOfficialIdentifierAction.descriptor.accessEvidencePolicy,
        );
        const handler = getActionHandler(updatePartyOfficialIdentifierAction);
        const encodedValidTo =
          change.type === 'END_VALIDITY'
            ? yield* Schema.encodeEffect(Schema.DateTimeUtcFromString)(change.validTo)
            : null;
        const after =
          change.type === 'SET_VERIFICATION'
            ? {
                ...before,
                verification: 'VERIFIED' as const,
                verifiedAt: '2026-01-02T00:00:00.000Z',
                verifiedByPrincipalId: '40000000-0000-4000-8000-000000000001',
              }
            : {
                ...before,
                state: 'ENDED' as const,
                validTo: encodedValidTo,
              };
        const result = {
          officialIdentifierRef,
          partyRef,
          state: after.state,
          validTo: change.type === 'END_VALIDITY' ? Option.some(change.validTo) : Option.none(),
          verification: after.verification,
        };
        yield* handler(
          {
            change,
            evidenceRefs: ['evidence:identifier-update'],
            officialIdentifierRef,
            reason: 'Accepted registry evidence',
          },
          {
            actionInvocationId: '50000000-0000-4000-8000-000000000001',
            addDomainEvent: collector.addDomainEvent,
            addOutboxMessage: collector.addOutboxMessage,
            recordAuditEvidence: collector.recordAuditEvidence,
            recordDataAccess: collector.recordDataAccess,
            scope: {
              authMethod: 'system',
              correlationId: 'identifier-outbox-test',
              principalId: '40000000-0000-4000-8000-000000000001',
              tenantId,
            },
            services: { update: () => Effect.succeed({ after, before, result }) },
          },
        );
        const snapshot = collector.snapshot();
        expect(snapshot.domainEvents.length).toBe(1);
        expect(snapshot.outboxMessages.length).toBe(1);
        expect(snapshot.outboxMessages[0]?.domainEventIndex).toBe(0);
        expect(snapshot.outboxMessages[0]?.message.topic).toBe(
          'party.registry.official-identifier-updated.v1',
        );
        expect(snapshot.outboxMessages[0]?.message.payloadJson).toEqual({
          officialIdentifierRef,
          partyRef,
        });
        expect(snapshot.domainEvents[0]?.subjectResourceId).toBe(officialIdentifierRef.resourceId);
        const event = snapshot.domainEvents[0]?.payloadJson;
        expect(event !== undefined).toBe(true);
        expect(event).toEqual({
          after,
          before,
          changeType: change.type,
          evidenceRefs: ['evidence:identifier-update'],
          officialIdentifierRef,
          partyRef,
          reason: 'Accepted registry evidence',
        });
      }),
  );
}

it.effect('rejected identifier updates publish neither Domain Event nor outbox message', () =>
  Effect.gen(function* rejectedUpdate() {
    const collector = createActionCollector(
      updatePartyOfficialIdentifierAction.descriptor.domainEvents,
      'party.registry',
      updatePartyOfficialIdentifierAction.descriptor.accessEvidencePolicy,
    );
    const failure = new OfficialIdentifierClaimConflict({
      code: 'party_identifier_claim_conflict',
      reason: 'Already claimed by another Party',
    });
    const error = yield* getActionHandler(updatePartyOfficialIdentifierAction)(
      {
        change: {
          expectedVerification: 'UNVERIFIED',
          type: 'SET_VERIFICATION',
          verification: 'VERIFIED',
        },
        evidenceRefs: ['evidence:identifier-update'],
        officialIdentifierRef,
        reason: 'Accepted registry evidence',
      },
      {
        actionInvocationId: '50000000-0000-4000-8000-000000000001',
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope: {
          authMethod: 'system',
          correlationId: 'identifier-outbox-test',
          principalId: '40000000-0000-4000-8000-000000000001',
          tenantId,
        },
        services: { update: () => Effect.fail(failure) },
      },
    ).pipe(Effect.flip);
    expect(error).toBe(failure);
    expect(collector.snapshot().domainEvents.length).toBe(0);
    expect(collector.snapshot().outboxMessages.length).toBe(0);
  }),
);

it.effect('published identifier update payload contains references only', () =>
  Effect.gen(function* verifyOutboxPayload() {
    const decode = Schema.decodeUnknownEffect(OutboxPayloadSchema, { onExcessProperty: 'error' });
    expect(yield* decode({ officialIdentifierRef, partyRef })).toEqual({
      officialIdentifierRef,
      partyRef,
    });
    const error = yield* Effect.flip(
      decode({ officialIdentifierRef, partyRef, verification: 'VERIFIED' }),
    );
    expect(error).toBeDefined();
  }),
);

it.effect('identifier update results keep DateTime and Option internally with nullable JSON', () =>
  Effect.gen(function* identifierUpdateResultWireRoundTrip() {
    const wire = {
      officialIdentifierRef,
      partyRef,
      state: 'ENDED',
      validTo: '2026-01-02T00:00:00.000Z',
      verification: 'VERIFIED',
    } as const;
    const decoded = yield* Schema.decodeUnknownEffect(UpdatePartyOfficialIdentifierResultSchema)(
      wire,
    );
    expect(Option.isSome(decoded.validTo)).toBe(true);
    expect(
      Option.match(decoded.validTo, {
        onNone: () => null,
        onSome: DateTime.formatIso,
      }),
    ).toBe(wire.validTo);
    expect(yield* Schema.encodeEffect(UpdatePartyOfficialIdentifierResultSchema)(decoded)).toEqual(
      wire,
    );
  }),
);
