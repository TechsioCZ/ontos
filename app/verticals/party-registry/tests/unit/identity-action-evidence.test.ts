import {
  bindActionTestServices,
  makeActionTestHarness,
} from '@app/core-runtime/testing/actions';
import { DateTime, Effect, Option, Schema, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionHandler } from '../../../../packages/core-runtime/src/actions/definition.ts';
import type { ActionEvidenceSnapshot } from '../../../../packages/core-runtime/src/actions/events.ts';
import {
  PartySchema,
  makePartyRef,
} from '../../shared/domain/identity-contracts.ts';
import { makeDuplicateCandidateCaseRef } from '../../shared/resources/duplicate-candidate-case.ts';
import { makePartyMatchDecisionRef } from '../../shared/resources/party-match-decision.ts';
import { archivePartyAction } from '../../src/actions/archive-party.action.ts';
import { unarchivePartyAction } from '../../src/actions/unarchive-party.action.ts';
import { updatePartyAction } from '../../src/actions/update-party.action.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const partyId = '22222222-2222-4222-8222-222222222222';
const actionInvocationId = '33333333-3333-4333-8333-333333333333';
const scope = {
  authMethod: 'system' as const,
  correlationId: 'identity-invariant-evidence-test',
  principalId: '44444444-4444-4444-8444-444444444444',
  tenantId,
};
const party = Schema.decodeSync(PartySchema)({
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  displayName: 'Example organization',
  partyRef: makePartyRef(tenantId, partyId),
  partyType: 'ORGANIZATION',
  revision: 2,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const assertInvariantEvidence = (snapshot: ActionEvidenceSnapshot) => {
  expect(snapshot.dataAccessEvents.length).toBe(1);
  const [access] = snapshot.dataAccessEvents;
  expect(access?.evidenceCaptureMode).toBe('metadata_only');
  expect(access?.targetResourceId).toBe(partyId);
  expect(access?.targetResourceType).toBe('party.registry.party');
  expect(access?.resultCount).toBe(1);
  expect(access?.evidencePayloadJson).toBe(undefined);
  expect(snapshot.domainEvents.length).toBe(1);
  expect(snapshot.outboxMessages.length).toBe(1);
};

it.effect(
  'Update Party records metadata-only invariant evidence with its event and outbox',
  () =>
    Effect.gen(function* verifyUpdateEvidence() {
      const collector = createActionCollector(
        updatePartyAction.descriptor.domainEvents,
        'party.registry',
        updatePartyAction.descriptor.accessEvidencePolicy
      );
      yield* getActionHandler(updatePartyAction)(
        {
          displayName: 'Example organization',
          expectedRevision: 1,
          partyRef: party.partyRef,
          provenanceMethod: 'MANUAL',
          provenanceSource: 'test',
          validFrom: DateTime.makeUnsafe('2026-01-01T00:00:00.000Z'),
        },
        {
          ...collector,
          actionInvocationId,
          scope,
          services: {
            update: () => Effect.succeed({ _tag: 'found', value: party }),
          },
        }
      );
      assertInvariantEvidence(collector.snapshot());
    })
);

it.effect(
  'Archive Party records metadata-only invariant evidence with its event and outbox',
  () =>
    Effect.gen(function* verifyArchiveEvidence() {
      const collector = createActionCollector(
        archivePartyAction.descriptor.domainEvents,
        'party.registry',
        archivePartyAction.descriptor.accessEvidencePolicy
      );
      yield* getActionHandler(archivePartyAction)(
        {
          expectedRevision: 1,
          partyRef: party.partyRef,
          reason: 'No longer active',
        },
        {
          ...collector,
          actionInvocationId,
          scope,
          services: {
            transition: () => Effect.succeed({ _tag: 'found', value: party }),
          },
        }
      );
      assertInvariantEvidence(collector.snapshot());
    })
);

it.effect(
  'Unarchive Party records metadata-only invariant evidence with its event and outbox',
  () =>
    Effect.gen(function* verifyUnarchiveEvidence() {
      const collector = createActionCollector(
        unarchivePartyAction.descriptor.domainEvents,
        'party.registry',
        unarchivePartyAction.descriptor.accessEvidencePolicy
      );
      yield* getActionHandler(unarchivePartyAction)(
        {
          expectedRevision: 1,
          partyRef: party.partyRef,
          reason: 'Active again',
        },
        {
          ...collector,
          actionInvocationId,
          scope,
          services: {
            unarchive: () => Effect.succeed({ _tag: 'found', value: party }),
          },
        }
      );
      assertInvariantEvidence(collector.snapshot());
    })
);

it.effect(
  'Unarchive review outcome commits once and replays without an unarchive event or outbox',
  () =>
    Effect.gen(function* verifyUnarchiveConflictEvidence() {
      let calls = 0;
      const blocked = {
        caseRef: makeDuplicateCandidateCaseRef(tenantId, partyId),
        decisionRef: makePartyMatchDecisionRef(tenantId, actionInvocationId),
        outcome: 'BLOCKED' as const,
        party: {
          ...party,
          archivedAt: Option.some(
            DateTime.makeUnsafe('2026-01-01T00:00:00.000Z')
          ),
        },
        reasonCode: 'EXACT_CLAIM_CONFLICT' as const,
      };
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        services: [
          bindActionTestServices(unarchivePartyAction, {
            unarchive: () =>
              Effect.sync(() => {
                calls += 1;
                return { _tag: 'blocked' as const, value: blocked };
              }),
          }),
        ],
        tenantPermission: 'allowed',
      });
      const request = {
        payload: {
          expectedRevision: 1,
          partyRef: party.partyRef,
          reason: 'Active again',
        },
        principal: {
          authBindingId: '60000000-0000-4000-8000-000000000001',
          authContextRef: 'better-auth-session:unarchive-review-test',
          authMethod: 'session' as const,
          principalId: scope.principalId,
          tenantId,
        },
        registration: unarchivePartyAction,
        transport: {
          correlationId: 'unarchive-review',
          idempotencyKey: 'unarchive-once',
        },
      };
      expect(yield* harness.runtime.runAction(request)).toEqual(blocked);
      const replay = yield* harness.runtime
        .runAction(request)
        .pipe(Effect.flip);
      expect(Predicate.isTagged(replay, 'ActionAlreadyCommitted')).toBe(true);
      expect(calls).toBe(1);
      const snapshot = harness.snapshot();
      expect(snapshot.committed.length).toBe(1);
      expect(snapshot.invocations[0]?.status).toBe('succeeded');
      expect(snapshot.committed[0]?.evidence.dataAccessEvents.length).toBe(1);
      expect(snapshot.committed[0]?.evidence.domainEvents).toEqual([]);
      expect(snapshot.committed[0]?.evidence.outboxMessages).toEqual([]);
    })
);
