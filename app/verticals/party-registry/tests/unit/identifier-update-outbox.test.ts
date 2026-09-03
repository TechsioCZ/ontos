import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Schema } from 'effect';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionHandler } from '../../../../packages/core-runtime/src/actions/definition.ts';
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
  { type: 'END_VALIDITY', validTo: '2026-01-02T00:00:00.000Z' },
];

for (const change of changes) {
  test(`${change.type} links one stable-reference outbox message to its committed Domain Event`, () =>
    Effect.runPromise(
      Effect.gen(function* successfulUpdate() {
        const collector = createActionCollector(
          updatePartyOfficialIdentifierAction.descriptor.domainEvents,
          'party.registry',
          updatePartyOfficialIdentifierAction.descriptor.accessEvidencePolicy,
        );
        const handler = getActionHandler(updatePartyOfficialIdentifierAction);
        const after =
          change.type === 'SET_VERIFICATION'
            ? {
                ...before,
                verification: 'VERIFIED' as const,
                verifiedAt: '2026-01-02T00:00:00.000Z',
                verifiedByPrincipalId: '40000000-0000-4000-8000-000000000001',
              }
            : { ...before, state: 'ENDED' as const, validTo: change.validTo };
        const result = {
          officialIdentifierRef,
          partyRef,
          state: after.state,
          validTo: after.validTo,
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
        assert.equal(snapshot.domainEvents.length, 1);
        assert.equal(snapshot.outboxMessages.length, 1);
        assert.equal(snapshot.outboxMessages[0]?.domainEventIndex, 0);
        assert.equal(
          snapshot.outboxMessages[0]?.message.topic,
          'party.registry.official-identifier-updated.v1',
        );
        assert.deepEqual(snapshot.outboxMessages[0]?.message.payloadJson, {
          officialIdentifierRef,
          partyRef,
        });
        assert.equal(snapshot.domainEvents[0]?.subjectResourceId, officialIdentifierRef.resourceId);
        const event = snapshot.domainEvents[0]?.payloadJson;
        assert.ok(event !== undefined);
        assert.deepEqual(event, {
          after,
          before,
          changeType: change.type,
          evidenceRefs: ['evidence:identifier-update'],
          officialIdentifierRef,
          partyRef,
          reason: 'Accepted registry evidence',
        });
      }),
    ));
}

test('rejected identifier updates publish neither Domain Event nor outbox message', () =>
  Effect.runPromise(
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
      assert.equal(error, failure);
      assert.equal(collector.snapshot().domainEvents.length, 0);
      assert.equal(collector.snapshot().outboxMessages.length, 0);
    }),
  ));

test('published identifier update payload contains references only', () => {
  const decode = Schema.decodeUnknownSync(OutboxPayloadSchema, { onExcessProperty: 'error' });
  assert.deepEqual(decode({ officialIdentifierRef, partyRef }), {
    officialIdentifierRef,
    partyRef,
  });
  assert.throws(() => decode({ officialIdentifierRef, partyRef, verification: 'VERIFIED' }));
});
