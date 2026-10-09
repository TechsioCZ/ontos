import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import {
  canRetryPrivacyMeasure,
  createPrivacyMeasureDispatch,
  prepareOwnerActionRequest,
  PrivacyMeasureInvariantError,
  recordOwnerExecutionOutcome,
  recoverPrivacyMeasureDispatch,
  reconcilePrivacyMeasure,
} from '../../shared/domain/privacy-measure-handoff.ts';

const handoff = {
  contentScopeRefs: ['account-record'],
  controllerObligationRef: 'obligation-1',
  dispositionDecision: 'DELETE',
  expectedEvidenceRefs: ['deletion-proof'],
  idempotencyKey: 'measure-1:attempt',
  kind: 'DELETE',
  measureId: 'measure-1',
  owningCapability: 'accounts',
  preconditionRefs: ['no-legal-hold'],
  requestedAt: '2026-09-14T10:00:00Z',
  requestedResult: 'canonical deletion',
  resourceRefs: ['account-1', 'account-2'],
  right: 'ERASURE',
  sourceDecisionRef: 'decision-1',
  sourceDecisionRevision: 2,
  subjectRef: 'subject-1',
  taskId: 'task-1',
  tenantId: 'tenant-1',
} as const;

const outcome = (status: 'SUCCEEDED' | 'PARTIAL' | 'INDETERMINATE') =>
  ({
    attempt: 1,
    evidenceRefs: ['proof-1'],
    idempotencyKey: 'measure-1:attempt',
    includedResourceRefs: status === 'PARTIAL' ? ['account-1'] : ['account-1', 'account-2'],
    measureId: 'measure-1',
    occurredAt: '2026-09-14T10:01:00Z',
    outcomeId: `outcome-${status}`,
    owningCapability: 'accounts',
    reason: status,
    recordedAt: '2026-09-14T10:02:00Z',
    remainingResourceRefs: status === 'PARTIAL' ? ['account-2'] : [],
    sourceDecisionRef: 'decision-1',
    sourceDecisionRevision: 2,
    status,
    taskId: 'task-1',
  }) as const;

describe('Privacy Measure owner handoff', () => {
  it.effect('does not confuse owner Action receipt with execution', () =>
    Effect.gen(function* preservesReceiptState() {
      const dispatch = yield* createPrivacyMeasureDispatch(handoff, '2026-09-14T10:00:01Z');
      expect(dispatch.status).toBe('RECEIVED');
      expect(prepareOwnerActionRequest(dispatch, 'accounts.delete').idempotencyKey).toBe('measure-1:attempt');
    }),
  );

  it.effect('keeps partial progress and reports changed retry payloads through the typed error channel', () =>
    Effect.gen(function* reportsPayloadConflict() {
      const dispatch = yield* createPrivacyMeasureDispatch(handoff, '2026-09-14T10:00:01Z');
      const request = prepareOwnerActionRequest(dispatch, 'accounts.delete');
      const partial = yield* recordOwnerExecutionOutcome(dispatch, request, outcome('PARTIAL'), '2026-09-14T10:01:01Z');
      expect(partial.status).toBe('PARTIAL');
      expect(partial.attempts[0]?.outcome?.remainingResourceRefs).toEqual(['account-2']);
      const conflictEffect = recordOwnerExecutionOutcome(
        partial,
        { ...request, handoff: { ...handoff, resourceRefs: ['account-99'] } },
        outcome('SUCCEEDED'),
        '2026-09-14T10:03:00Z',
      );
      expect(conflictEffect).toBeDefined();
      expect(Schema.is(PrivacyMeasureInvariantError)(yield* Effect.flip(conflictEffect))).toBe(true);
      const tenantConflict = recordOwnerExecutionOutcome(
        partial,
        { ...request, handoff: { ...handoff, tenantId: 'tenant-99' } },
        outcome('SUCCEEDED'),
        '2026-09-14T10:03:00Z',
      );
      expect(Schema.is(PrivacyMeasureInvariantError)(yield* Effect.flip(tenantConflict))).toBe(true);
    }),
  );

  it.effect('rejects SUCCEEDED with remaining work and PARTIAL without remaining work', () =>
    Effect.gen(function* rejectsStatusPartitionMismatch() {
      const dispatch = yield* createPrivacyMeasureDispatch(handoff, '2026-09-14T10:00:01Z');
      const request = prepareOwnerActionRequest(dispatch, 'accounts.delete');
      const incompleteSuccess = {
        ...outcome('SUCCEEDED'),
        includedResourceRefs: ['account-1'],
        remainingResourceRefs: ['account-2'],
      } as const;
      const completePartial = {
        ...outcome('PARTIAL'),
        includedResourceRefs: ['account-1', 'account-2'],
        remainingResourceRefs: [],
      } as const;

      expect(
        Schema.is(PrivacyMeasureInvariantError)(
          yield* Effect.flip(recordOwnerExecutionOutcome(dispatch, request, incompleteSuccess, '2026-09-14T10:03:00Z')),
        ),
      ).toBe(true);
      expect(
        Schema.is(PrivacyMeasureInvariantError)(
          yield* Effect.flip(recordOwnerExecutionOutcome(dispatch, request, completePartial, '2026-09-14T10:03:00Z')),
        ),
      ).toBe(true);
    }),
  );

  it.effect('requires reconciliation before indeterminate work can continue', () =>
    Effect.gen(function* requiresReconciliation() {
      const dispatch = yield* createPrivacyMeasureDispatch(handoff, '2026-09-14T10:00:01Z');
      const request = prepareOwnerActionRequest(dispatch, 'accounts.delete');
      const uncertain = yield* recordOwnerExecutionOutcome(
        dispatch,
        request,
        outcome('INDETERMINATE'),
        '2026-09-14T10:01:01Z',
      );
      expect(canRetryPrivacyMeasure(uncertain)).toBe(false);
      expect(canRetryPrivacyMeasure(recoverPrivacyMeasureDispatch({ ...uncertain, status: 'IN_PROGRESS' }))).toBe(
        false,
      );
      const prematureRetry = recordOwnerExecutionOutcome(
        uncertain,
        request,
        outcome('SUCCEEDED'),
        '2026-09-14T10:03:00Z',
      );
      expect(Schema.is(PrivacyMeasureInvariantError)(yield* Effect.flip(prematureRetry))).toBe(true);

      const reconciled = yield* reconcilePrivacyMeasure(uncertain, outcome('SUCCEEDED'), '2026-09-14T10:04:00Z');
      expect(reconciled.status).toBe('SUCCEEDED');
      expect(reconciled.attempts).toHaveLength(2);
      expect(reconciled.attempts[1]?.outcome?.status).toBe('SUCCEEDED');
    }),
  );

  it.effect('keeps a timeout unresolved until reconciliation proves the same decision revision', () =>
    Effect.gen(function* rejectsMismatchedRevision() {
      const dispatch = yield* createPrivacyMeasureDispatch(handoff, '2026-09-14T10:00:01Z');
      const request = prepareOwnerActionRequest(dispatch, 'accounts.delete');
      const timedOut = yield* recordOwnerExecutionOutcome(
        dispatch,
        request,
        outcome('INDETERMINATE'),
        '2026-09-14T10:01:01Z',
      );
      expect(timedOut.status).toBe('INDETERMINATE');
      const mismatch = reconcilePrivacyMeasure(
        timedOut,
        { ...outcome('SUCCEEDED'), sourceDecisionRevision: 3 },
        '2026-09-14T10:04:00Z',
      );
      expect(Schema.is(PrivacyMeasureInvariantError)(yield* Effect.flip(mismatch))).toBe(true);
    }),
  );

  it.effect('rejects an invalid handoff lazily through the typed error channel', () =>
    Effect.gen(function* rejectsInvalidHandoff() {
      const invalid = createPrivacyMeasureDispatch({ ...handoff, resourceRefs: [] }, '2026-09-14T10:00:01Z');
      expect(invalid).toBeDefined();
      expect(Schema.is(PrivacyMeasureInvariantError)(yield* Effect.flip(invalid))).toBe(true);
    }),
  );
});
