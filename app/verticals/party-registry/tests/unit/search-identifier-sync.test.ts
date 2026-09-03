import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Schema } from 'effect';
import {
  makeCoreSearchIngestion,
  makeCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
} from '@app/core-runtime';
import type { OutboxMessage, OutboxWorkerHandlerContext } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { updatePartyOfficialIdentifierAction } from '../../src/actions/update-party-official-identifier.action.ts';
import { createPartyAction } from '../../src/actions/create-party.action.ts';
import { resolveDuplicateCandidateMatchAction } from '../../src/actions/resolve-duplicate-candidate-match.action.ts';
import {
  makePartySearchProjector,
  PartySearchProjector,
} from '../../src/services/party-search-projection.service.ts';
import type {
  PartySearchSourceSnapshot,
  PartySearchSourceValue,
} from '../../src/services/party-search-projection.service.ts';
import {
  handleProjectOfficialIdentifierAddedToSearch,
  projectOfficialIdentifierAddedToSearchWorker,
} from '../../src/workers/project-official-identifier-added-to-search.worker.ts';
import {
  handleProjectOfficialIdentifierUpdatedToSearch,
  projectOfficialIdentifierUpdatedToSearchWorker,
} from '../../src/workers/project-official-identifier-updated-to-search.worker.ts';

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
const decisionRef = {
  moduleId: 'party.registry',
  resourceId: '40000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party-match-decision',
  tenantId,
} as const;
const caseRef = {
  moduleId: 'party.registry',
  resourceId: '70000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.duplicate-candidate-case',
  tenantId,
} as const;
const principal = {
  authBindingId: '60000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:identifier-sync-test',
  authMethod: 'session',
  principalId: '50000000-0000-4000-8000-000000000001',
  tenantId,
} as const;
const identifier: PartySearchSourceValue = {
  state: 'ACTIVE',
  validFrom: '2026-01-01T00:00:00.000Z',
  value: 'CZ12345678',
};
const baseContext: OutboxWorkerHandlerContext = {
  attemptNumber: 1,
  claimId: 'claim-1',
  deliveryId: 'delivery-1',
  domainEventId: 'event-1',
  messageId: 'message-1',
  producerModuleKey: 'party.registry',
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'party.registry.party-updated.v1',
  workerKey: 'party.registry.project-party-updated-to-search',
};

const makeSearchFixture = (identifiers: readonly PartySearchSourceValue[]) => {
  let canonical: PartySearchSourceSnapshot = {
    counterparties: [],
    parties: [
      {
        aliases: [],
        archived: false,
        contacts: [],
        displayName: 'Acme',
        identifiers,
        ref: partyRef,
      },
    ],
    projectionVersion: '1',
    removedRefs: [],
    tenantId,
  };
  const store = makeInMemoryCoreSearchProjectionStore();
  const projector = makePartySearchProjector(
    {
      load: (context, target) =>
        Effect.sync(() => {
          assert.equal(context.tenantId, tenantId);
          assert.deepEqual(target, { partyId: partyRef.resourceId });
          return canonical;
        }),
    },
    makeCoreSearchIngestion(store),
    store,
  );
  const replaceIdentifiers = (values: readonly PartySearchSourceValue[]) =>
    Effect.sync(() => {
      canonical = {
        ...canonical,
        parties: canonical.parties.map((party) => ({ ...party, identifiers: values })),
        projectionVersion: '2',
      };
    });
  const deliver = (message: OutboxMessage) =>
    Effect.gen(function* deliverIdentifierMessage() {
      if (message.topic === 'party.registry.official-identifier-added.v1') {
        const { descriptor } = projectOfficialIdentifierAddedToSearchWorker;
        const payload = yield* Schema.decodeUnknownEffect(descriptor.payloadSchema)(
          message.payloadJson,
        );
        yield* handleProjectOfficialIdentifierAddedToSearch(payload, {
          ...baseContext,
          topic: message.topic,
          workerKey: descriptor.workerKey,
        }).pipe(Effect.provideService(PartySearchProjector, projector));
      } else {
        assert.equal(message.topic, 'party.registry.official-identifier-updated.v1');
        const { descriptor } = projectOfficialIdentifierUpdatedToSearchWorker;
        const payload = yield* Schema.decodeUnknownEffect(descriptor.payloadSchema)(
          message.payloadJson,
        );
        yield* handleProjectOfficialIdentifierUpdatedToSearch(payload, {
          ...baseContext,
          topic: message.topic,
          workerKey: descriptor.workerKey,
        }).pipe(Effect.provideService(PartySearchProjector, projector));
      }
    });
  return {
    deliver,
    query: () =>
      makeCoreSearchQueryRuntime(store).search({
        effectiveAt: '2026-09-03T00:00:00.000Z',
        includeArchived: false,
        moduleId: 'party.registry',
        query: identifier.value,
        resourceType: 'party.registry.party',
        tenantId,
      }),
    replaceIdentifiers,
    seed: projector.project(baseContext, { partyId: partyRef.resourceId }),
  };
};

const assertAttachedIdentifierDelivery = (
  harness: ReturnType<typeof makeActionTestHarness>,
  search: ReturnType<typeof makeSearchFixture>,
) =>
  Effect.gen(function* verifyCommittedIdentifierDelivery() {
    const [commit] = harness.snapshot().committed;
    assert.ok(commit);
    assert.equal(commit.evidence.outboxMessages.length, 1);
    const [outbox] = commit.evidence.outboxMessages;
    assert.ok(outbox);
    assert.equal(
      commit.evidence.domainEvents[outbox.domainEventIndex]?.eventType,
      'party.registry.official-identifier-added.v1',
    );
    assert.deepEqual(outbox.message.payloadJson, { officialIdentifierRef, partyRef });
    assert.deepEqual(yield* search.query(), []);
    yield* search.deliver(outbox.message);
    const hits = yield* search.query();
    assert.deepEqual(
      hits.map((hit) => hit.ref),
      [partyRef],
    );
    yield* search.deliver(outbox.message);
    assert.deepEqual(yield* search.query(), hits);
  });

test('CreateParty MATCHED_EXISTING publishes an attached identifier and indexes it after delivery only', () =>
  Effect.runPromise(
    Effect.gen(function* matchedExistingCreateScenario() {
      const search = makeSearchFixture([]);
      yield* search.seed;
      const harness = makeActionTestHarness({
        actionPermission: 'allowed',
        services: [
          bindActionTestServices(createPartyAction, {
            createOrMatch: () =>
              search.replaceIdentifiers([identifier]).pipe(
                Effect.as({
                  addedOfficialIdentifierRefs: [officialIdentifierRef],
                  decisionRef,
                  outcome: 'MATCHED_EXISTING' as const,
                  partyRef,
                }),
              ),
          }),
        ],
        tenantPermission: 'allowed',
      });
      const result = yield* harness.runtime.runAction({
        payload: {
          candidate: {
            displayName: 'Acme',
            evidenceRefs: ['evidence:confirmed-tax-registration'],
            officialIdentifiers: [
              { identifierType: 'CZ_DIC', value: identifier.value, verification: 'VERIFIED' },
            ],
            partyType: 'ORGANIZATION',
            provenance: { method: 'DOCUMENT_REVIEW', source: 'USER_ASSERTION' },
            validFrom: identifier.validFrom,
          },
        },
        principal,
        registration: createPartyAction,
        transport: { correlationId: 'identifier-sync', idempotencyKey: 'match-identifier-1' },
      });
      assert.deepEqual(result, { decisionRef, outcome: 'MATCHED_EXISTING', partyRef });
      yield* assertAttachedIdentifierDelivery(harness, search);
    }),
  ));

test('reviewed MATCH_EXISTING publishes an attached identifier and indexes it after delivery only', () =>
  Effect.runPromise(
    Effect.gen(function* reviewedMatchScenario() {
      const search = makeSearchFixture([]);
      yield* search.seed;
      const harness = makeActionTestHarness({
        actionPermission: 'allowed',
        services: [
          bindActionTestServices(resolveDuplicateCandidateMatchAction, {
            resolve: () =>
              search.replaceIdentifiers([identifier]).pipe(
                Effect.as({
                  addedOfficialIdentifierRefs: [officialIdentifierRef],
                  caseRef,
                  decisionRef,
                  lifecycleState: 'RESOLVED' as const,
                  outcome: 'MATCH_EXISTING' as const,
                  partyRef,
                }),
              ),
          }),
        ],
        tenantPermission: 'allowed',
      });
      const result = yield* harness.runtime.runAction({
        payload: {
          caseRef,
          expectedRevision: 1,
          reason: 'Confirmed existing Party from source evidence',
          selectedPartyRef: partyRef,
        },
        principal,
        registration: resolveDuplicateCandidateMatchAction,
        transport: {
          correlationId: 'identifier-sync',
          idempotencyKey: 'review-match-identifier-1',
        },
      });
      assert.deepEqual(result, {
        caseRef,
        decisionRef,
        lifecycleState: 'RESOLVED',
        outcome: 'MATCH_EXISTING',
        partyRef,
      });
      yield* assertAttachedIdentifierDelivery(harness, search);
    }),
  ));

test('END_VALIDITY refreshes search only after its committed identifier message and remains replay-safe', () =>
  Effect.runPromise(
    Effect.gen(function* endIdentifierSearchScenario() {
      const search = makeSearchFixture([identifier]);
      yield* search.seed;
      const validTo = '2026-08-01T00:00:00.000Z';
      const before = {
        state: 'ACTIVE',
        validTo: null,
        verification: 'VERIFIED',
        verifiedAt: null,
        verifiedByPrincipalId: null,
      } as const;
      const after = { ...before, state: 'ENDED', validTo } as const;
      const harness = makeActionTestHarness({
        actionPermission: 'allowed',
        services: [
          bindActionTestServices(updatePartyOfficialIdentifierAction, {
            update: () =>
              search.replaceIdentifiers([{ ...identifier, state: 'ENDED', validTo }]).pipe(
                Effect.as({
                  after,
                  before,
                  result: {
                    officialIdentifierRef,
                    partyRef,
                    state: 'ENDED',
                    validTo,
                    verification: 'VERIFIED',
                  },
                }),
              ),
          }),
        ],
        tenantPermission: 'allowed',
      });
      yield* harness.runtime.runAction({
        payload: {
          change: { type: 'END_VALIDITY', validTo },
          evidenceRefs: ['evidence:retired'],
          officialIdentifierRef,
          reason: 'Identifier validly retired',
        },
        principal,
        registration: updatePartyOfficialIdentifierAction,
        transport: { correlationId: 'identifier-sync', idempotencyKey: 'end-identifier-1' },
      });
      const [commit] = harness.snapshot().committed;
      assert.ok(commit);
      assert.equal(commit.evidence.outboxMessages.length, 1);
      const [outbox] = commit.evidence.outboxMessages;
      assert.ok(outbox);
      assert.equal(
        commit.evidence.domainEvents[outbox.domainEventIndex]?.eventType,
        'party.registry.official-identifier-updated.v1',
      );
      assert.deepEqual(outbox.message.payloadJson, { officialIdentifierRef, partyRef });
      assert.equal((yield* search.query()).length, 1);
      yield* search.deliver(outbox.message);
      assert.deepEqual(yield* search.query(), []);
      yield* search.deliver(outbox.message);
      assert.deepEqual(yield* search.query(), []);
    }),
  ));
