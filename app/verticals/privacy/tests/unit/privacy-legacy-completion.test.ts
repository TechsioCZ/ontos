import type { LegacyCompletionMessageEvidence } from '@app/core-runtime/legacy-completion-publication';
import {
  LegacyCompletionPublicationError,
  LegacyCompletionTransactionIdSchema,
} from '@app/core-runtime/legacy-completion-publication';
import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { validatePrivacyLegacyRuntimeIdentity } from '../../scripts/legacy-completion-runtime-pair.ts';
import { assessPrivacyLegacyCompletionEvidence } from '../../src/admin/privacy-legacy-completion-evidence.ts';

const handoff = {
  contentScopeRefs: ['account-record'],
  controllerObligationRef: 'obligation-1',
  dispositionDecision: 'DELETE',
  expectedEvidenceRefs: ['deletion-proof'],
  idempotencyKey: 'measure-1:attempt',
  kind: 'DELETE',
  measureId: 'measure-1',
  owningCapability: 'party.registry',
  preconditionRefs: ['no-legal-hold'],
  requestedAt: '2026-09-14T10:00:00Z',
  requestedResult: 'canonical deletion',
  resourceRefs: ['account-1'],
  right: 'ERASURE',
  sourceDecisionRef: 'decision-1',
  sourceDecisionRevision: 2,
  subjectRef: 'subject-1',
  taskId: 'task-1',
  tenantId: 'tenant-1',
} as const;
const dispatch = {
  handoffRecord: handoff,
  idempotencyKey: handoff.idempotencyKey,
  legalEntityId: 'legal-entity-1',
  measureId: handoff.measureId,
  status: 'SUCCEEDED',
  tenantId: handoff.tenantId,
} as const;
const outcomeRecord = {
  attempt: 1,
  evidenceRefs: ['proof-1'],
  idempotencyKey: handoff.idempotencyKey,
  includedResourceRefs: handoff.resourceRefs,
  measureId: handoff.measureId,
  occurredAt: '2026-09-14T10:01:00Z',
  outcomeId: 'outcome-1',
  owningCapability: handoff.owningCapability,
  reason: 'Owner completed the exact approved scope',
  recordedAt: '2026-09-14T10:02:00Z',
  remainingResourceRefs: [],
  sourceDecisionRef: handoff.sourceDecisionRef,
  sourceDecisionRevision: handoff.sourceDecisionRevision,
  status: 'SUCCEEDED',
  taskId: handoff.taskId,
} as const;
const outcome = {
  attempt: 1,
  legalEntityId: dispatch.legalEntityId,
  measureId: dispatch.measureId,
  outcomeId: outcomeRecord.outcomeId,
  outcomeRecord,
  status: 'SUCCEEDED',
  tenantId: dispatch.tenantId,
} as const;
const message: LegacyCompletionMessageEvidence = {
  completionConsumerModuleKey: handoff.owningCapability,
  completionOriginalRevision: 'recorded-original-release',
  deliveries: [
    { consumerModuleKey: handoff.owningCapability, status: 'done', workerKey: 'party.registry.apply-privacy-measure' },
  ],
  outboxMessageId: 'message-1',
  payloadJson: { handoff },
  tenantId: handoff.tenantId,
};

// Synthetic inventories exercise the production assessor only. They do not mint an
// operator lease, prove native locks/runtime pairing, or supply a healthy Party producer.
describe('Privacy legacy completion evidence interpretation', () => {
  it.effect('accepts a complete empty owner/message inventory', () =>
    Effect.gen(function* emptyInventory() {
      expect(yield* assessPrivacyLegacyCompletionEvidence([], [], [])).toBe('VERIFIED_ABSENT');
    }),
  );

  it.effect('keeps genuine unmarked legacy work unresolved even with a done delivery and owner success', () =>
    Effect.gen(function* unmarkedLegacy() {
      expect(
        yield* assessPrivacyLegacyCompletionEvidence(
          [{ ...message, completionConsumerModuleKey: null, completionOriginalRevision: null }],
          [dispatch],
          [outcome],
        ),
      ).toBe('UNRESOLVED');
      expect(message.completionOriginalRevision).toBe('recorded-original-release');
    }),
  );

  it.effect('requires immutable matching owner success as well as current message/ack evidence', () =>
    Effect.gen(function* markedSuccess() {
      expect(yield* assessPrivacyLegacyCompletionEvidence([message], [dispatch], [outcome])).toBe('VERIFIED_ABSENT');
      expect(yield* assessPrivacyLegacyCompletionEvidence([message], [dispatch], [])).toBe('UNRESOLVED');
      expect(
        yield* assessPrivacyLegacyCompletionEvidence([{ ...message, deliveries: [] }], [dispatch], [outcome]),
      ).toBe('UNRESOLVED');
      expect(
        yield* assessPrivacyLegacyCompletionEvidence(
          [
            {
              ...message,
              deliveries: [
                {
                  consumerModuleKey: handoff.owningCapability,
                  status: 'retrying',
                  workerKey: 'party.registry.apply-privacy-measure',
                },
              ],
            },
          ],
          [dispatch],
          [outcome],
        ),
      ).toBe('UNRESOLVED');
    }),
  );

  it.effect('does not mistake non-success owner statuses or a done delivery for completed owner work', () =>
    Effect.gen(function* unfinishedOwnerWork() {
      for (const status of [
        'RECEIVED',
        'IN_PROGRESS',
        'PARTIAL',
        'BUSINESS_REJECTED',
        'NOT_APPLICABLE',
        'TECHNICAL_FAILED',
        'BLOCKED',
        'INDETERMINATE',
      ]) {
        expect(yield* assessPrivacyLegacyCompletionEvidence([message], [{ ...dispatch, status }], [])).toBe(
          'UNRESOLVED',
        );
      }
    }),
  );

  it.effect('keeps retained BUSINESS_REJECTED history unresolved after the Core delivery is done', () =>
    Effect.gen(function* retainedBusinessRejection() {
      const rejectedOutcome = {
        ...outcome,
        outcomeRecord: {
          ...outcomeRecord,
          includedResourceRefs: [],
          reason: 'Owner cannot apply the requested measure',
          remainingResourceRefs: handoff.resourceRefs,
          status: 'BUSINESS_REJECTED',
        },
        status: 'BUSINESS_REJECTED',
      };
      expect(
        yield* assessPrivacyLegacyCompletionEvidence(
          [message],
          [{ ...dispatch, status: 'BUSINESS_REJECTED' }],
          [rejectedOutcome],
        ),
      ).toBe('UNRESOLVED');
      expect(message.deliveries[0]?.status).toBe('done');
      expect(rejectedOutcome.outcomeRecord.remainingResourceRefs).toEqual(handoff.resourceRefs);
    }),
  );

  it.effect('observes unfinished work in another tenant rather than claiming scoped absence', () =>
    Effect.gen(function* otherTenant() {
      const otherHandoff = { ...handoff, measureId: 'measure-2', tenantId: 'tenant-2' };
      const otherMessage = {
        ...message,
        outboxMessageId: 'message-2',
        payloadJson: { handoff: otherHandoff },
        tenantId: 'tenant-2',
      };
      const otherDispatch = {
        ...dispatch,
        handoffRecord: otherHandoff,
        measureId: 'measure-2',
        status: 'RECEIVED',
        tenantId: 'tenant-2',
      };
      expect(
        yield* assessPrivacyLegacyCompletionEvidence([message, otherMessage], [dispatch, otherDispatch], [outcome]),
      ).toBe('UNRESOLVED');
    }),
  );

  it.effect('rejects missing, duplicate, malformed or contradictory owner/message inventories', () =>
    Effect.gen(function* incompleteInventory() {
      expect(yield* assessPrivacyLegacyCompletionEvidence([message], [], [])).toBe('UNKNOWN');
      expect(yield* assessPrivacyLegacyCompletionEvidence([], [dispatch], [outcome])).toBe('UNKNOWN');
      expect(yield* assessPrivacyLegacyCompletionEvidence([message, message], [dispatch], [outcome])).toBe('UNKNOWN');
      expect(yield* assessPrivacyLegacyCompletionEvidence([message], [dispatch, dispatch], [outcome])).toBe('UNKNOWN');
      expect(
        yield* assessPrivacyLegacyCompletionEvidence([{ ...message, payloadJson: {} }], [dispatch], [outcome]),
      ).toBe('UNKNOWN');
      expect(
        yield* assessPrivacyLegacyCompletionEvidence([message], [{ ...dispatch, status: 'unexpected' }], [outcome]),
      ).toBe('UNKNOWN');
    }),
  );

  it.effect('requires the exact tenant, handoff payload, intended consumer and recorded original revision', () =>
    Effect.gen(function* exactMessageEvidence() {
      for (const changed of [
        { ...message, tenantId: 'tenant-2' },
        { ...message, payloadJson: { handoff: { ...handoff, sourceDecisionRevision: 3 } } },
        { ...message, completionConsumerModuleKey: 'commerce.customer-context' },
        { ...message, completionOriginalRevision: null },
        { ...message, completionOriginalRevision: ' ' },
      ]) {
        expect(yield* assessPrivacyLegacyCompletionEvidence([changed], [dispatch], [outcome])).toBe('UNKNOWN');
      }
    }),
  );

  it.effect('requires immutable owner outcome identity and exact successful resource coverage', () =>
    Effect.gen(function* exactOutcomeEvidence() {
      for (const changed of [
        { ...outcome, outcomeId: 'outcome-2' },
        { ...outcome, attempt: 2 },
        { ...outcome, outcomeRecord: { ...outcomeRecord, taskId: 'task-2' } },
        { ...outcome, outcomeRecord: { ...outcomeRecord, sourceDecisionRevision: 3 } },
        { ...outcome, outcomeRecord: { ...outcomeRecord, includedResourceRefs: ['other-resource'] } },
        { ...outcome, outcomeRecord: { ...outcomeRecord, remainingResourceRefs: ['account-1'] } },
      ]) {
        expect(yield* assessPrivacyLegacyCompletionEvidence([message], [dispatch], [changed])).toBe('UNKNOWN');
      }
      expect(
        yield* assessPrivacyLegacyCompletionEvidence(
          [message],
          [dispatch],
          [{ ...outcome, legalEntityId: 'other-entity' }],
        ),
      ).toBe('UNKNOWN');
    }),
  );

  it.effect(
    'verifies 10,001 settled dispatches without discarding immutable history and detects late debt',
    () =>
      Effect.gen(function* retainedHistory() {
        const population = Array.from({ length: 10_001 }, (_, index) => {
          const measureId = `measure-${index}`;
          const idempotencyKey = `${measureId}:attempt`;
          const retainedHandoff = { ...handoff, idempotencyKey, measureId };
          const outcomeId = `outcome-${index}`;
          return {
            dispatch: { ...dispatch, handoffRecord: retainedHandoff, idempotencyKey, measureId },
            message: { ...message, outboxMessageId: `message-${index}`, payloadJson: { handoff: retainedHandoff } },
            outcome: {
              ...outcome,
              measureId,
              outcomeId,
              outcomeRecord: { ...outcomeRecord, idempotencyKey, measureId, outcomeId },
            },
          };
        });
        const messages = population.map((row) => row.message);
        const dispatches = population.map((row) => row.dispatch);
        const outcomes = population.map((row) => row.outcome);
        expect(yield* assessPrivacyLegacyCompletionEvidence(messages, dispatches, outcomes)).toBe('VERIFIED_ABSENT');
        expect(
          yield* assessPrivacyLegacyCompletionEvidence(
            messages,
            dispatches.map((row, index) => (index === 10_000 ? { ...row, status: 'RECEIVED' } : row)),
            outcomes,
          ),
        ).toBe('UNRESOLVED');
        expect(
          yield* assessPrivacyLegacyCompletionEvidence(
            messages.map((row, index) =>
              index === 10_000
                ? { ...row, deliveries: row.deliveries.map((delivery) => ({ ...delivery, status: 'pending' })) }
                : row,
            ),
            dispatches,
            outcomes,
          ),
        ).toBe('UNRESOLVED');
      }),
    // 10,001 rows decode and reconcile one by one; CI runners need more than the 5s default.
    30_000,
  );

  it.effect(
    'fails closed when either owner inventory is contradictory',
    () =>
      Effect.gen(function* boundedInventory() {
        expect(
          yield* assessPrivacyLegacyCompletionEvidence(
            [],
            Array.from({ length: 10_001 }, () => dispatch),
            [],
          ),
        ).toBe('UNKNOWN');
        expect(
          yield* assessPrivacyLegacyCompletionEvidence(
            [],
            [],
            Array.from({ length: 10_001 }, () => outcome),
          ),
        ).toBe('UNKNOWN');
      }),
    30_000,
  );
});

const nativeBinding = Object.freeze({
  databaseName: 'owned_test_database',
  databaseOid: '42',
  databaseUser: 'operator',
  observedAt: DateTime.makeUnsafe('2026-10-21T10:00:00.000Z'),
  runtimeRoleOid: '43',
  runtimeTarget: { databaseName: 'owned_test_database', host: 'localhost', port: 5432, user: 'owned_runtime' },
  runtimeUser: 'owned_runtime',
  systemIdentifier: 'native_server',
  transactionId: Schema.decodeSync(LegacyCompletionTransactionIdSchema)('44'),
});
const runtimeIdentity = {
  challengeAcquired: false,
  databaseName: nativeBinding.databaseName,
  databaseOid: nativeBinding.databaseOid,
  databaseUser: nativeBinding.runtimeUser,
  runtimeRoleOid: nativeBinding.runtimeRoleOid,
  safeRuntime: true,
};

describe('Privacy runtime-pair probe value interpretation', () => {
  it.effect('accepts values reporting exact runtime identity and a contended challenge', () =>
    Effect.gen(function* matchingRuntimeIdentity() {
      yield* validatePrivacyLegacyRuntimeIdentity([runtimeIdentity], nativeBinding);
    }),
  );

  it.effect('refuses an acquired challenge even when a foreign server presents matching names and OIDs', () =>
    Effect.gen(function* foreignNativeServer() {
      const error = yield* Effect.flip(
        validatePrivacyLegacyRuntimeIdentity([{ ...runtimeIdentity, challengeAcquired: true }], nativeBinding),
      );
      expect(Schema.is(LegacyCompletionPublicationError)(error)).toBe(true);
      expect(error.cause).toBeDefined();
    }),
  );

  it.effect('refuses values reporting foreign database/role identities and unsafe runtime privilege', () =>
    Effect.gen(function* mismatchedRuntimeIdentity() {
      const observations = [
        { ...runtimeIdentity, databaseName: 'other_database' },
        { ...runtimeIdentity, databaseOid: 'other_oid' },
        { ...runtimeIdentity, databaseUser: 'operator' },
        { ...runtimeIdentity, runtimeRoleOid: 'other_role_oid' },
        { ...runtimeIdentity, safeRuntime: false },
      ];
      yield* Effect.forEach(
        observations,
        (observation) =>
          Effect.gen(function* assertRefusedRuntime() {
            const error = yield* Effect.flip(validatePrivacyLegacyRuntimeIdentity([observation], nativeBinding));
            expect(Schema.is(LegacyCompletionPublicationError)(error)).toBe(true);
          }),
        { concurrency: 1 },
      );
    }),
  );

  it.effect('refuses absent, ambiguous and malformed native observations', () =>
    Effect.gen(function* incompleteRuntimeIdentity() {
      yield* Effect.forEach(
        [[], [runtimeIdentity, runtimeIdentity], [{}]],
        (rows) =>
          Effect.gen(function* assertRefusedProbe() {
            const error = yield* Effect.flip(validatePrivacyLegacyRuntimeIdentity(rows, nativeBinding));
            expect(Schema.is(LegacyCompletionPublicationError)(error)).toBe(true);
          }),
        { concurrency: 1 },
      );
    }),
  );
});
