// @effect-diagnostics nodeBuiltinImport:off -- This focused contract test inspects the generated custom migration; expires: 2027-03-31.
import type { OutboxWorkerHandlerContext, OutboxWorkerLegalEntityScopeFanoutService } from '@app/core-runtime';
import { makeOutboxWorkerLegalEntityScopeFanout, OutboxWorkerLegalEntityScopeFanout } from '@app/core-runtime';
import type { OutboxPayload } from '@app/privacy/outbox/privacy-retention-evaluation-requested';
import { expect, it } from 'effect-rstest';
import { Array as EffectArray, Effect, Order, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { readFileSync } from 'node:fs';

import { makeRetentionEvaluationWork } from '../../shared/domain/privacy-retention-disposition.ts';
import type { RetentionEvaluationWork } from '../../shared/domain/privacy-retention-disposition.ts';
import type { RetentionEvaluationRoutineRow } from '../../src/persistence/retention-evaluation-worker-persistence.ts';
import { handleRetentionEvaluation, retentionEvaluationWorker } from '../../src/workers/retention-evaluation.worker.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000002';
const otherLegalEntityId = '30000000-0000-4000-8000-000000000003';
const messageId = '40000000-0000-4000-8000-000000000004';
const evaluatedAt = '2026-09-14T12:00:00.000Z';
const dueAt = '2026-09-13T12:00:00.000Z';

const work = makeRetentionEvaluationWork({
  contentScopeRefs: ['customer.contact.email'],
  dueAt: Schema.decodeUnknownSync(Schema.String)(dueAt),
  ruleRef: 'retention:customer-contact-email',
  ruleVersion: 2,
  source: 'PERIODIC',
});
const payload: OutboxPayload = { work };

const context: OutboxWorkerHandlerContext = {
  attemptNumber: 1,
  claimId: 'claim-1',
  consumerModuleKey: 'privacy.core',
  deliveryId: 'delivery-1',
  domainEventId: 'event-1',
  messageId,
  producerModuleKey: 'privacy.core',
  tenantId,
  tenantSequenceNo: 10n,
  topic: 'privacy.retention.evaluation.requested',
  workerKey: 'privacy.core.retention-evaluation',
};

const row = (
  status: Exclude<RetentionEvaluationWork['status'], 'PENDING' | 'INDETERMINATE'>,
  options: {
    readonly outcome?: RetentionEvaluationRoutineRow['outcome'];
    readonly ownerOutcomeRef?: string | null;
    readonly reason?: string;
  } = {},
): RetentionEvaluationRoutineRow => ({
  blocker_refs: status === 'BLOCKED' ? ['legal-hold:hold:customer-email'] : [],
  evaluated_at: new Date(evaluatedAt),
  outcome: options.outcome ?? 'EVALUATED',
  owner_outcome_ref: options.ownerOutcomeRef ?? null,
  reason: options.reason ?? 'RETENTION_EVALUATED',
  status,
  work_record: {
    ...work,
    evaluatedAt,
    status,
    workerEvaluation: {
      evaluatedAt,
      messageId,
      ownerOutcomeRef: options.ownerOutcomeRef ?? null,
    },
  },
  work_ref: work.workRef,
});

const notFoundRow: RetentionEvaluationRoutineRow = {
  blocker_refs: [],
  evaluated_at: null,
  outcome: 'NOT_FOUND',
  owner_outcome_ref: null,
  reason: 'WORK_NOT_FOUND_IN_SCOPE',
  status: null,
  work_record: null,
  work_ref: null,
};

interface RoutineCapture {
  legalEntityId: string;
  values: readonly unknown[];
}

const required = <Value>(value: Value | undefined, reason: string): Value => {
  if (value === undefined) {
    throw new Error(reason);
  }
  return value;
};

/* oxlint-disable sonarjs/no-nested-functions -- The test double mirrors Core's nested owner transaction and scoped routine lifetime. */
const fanout = (
  results: Readonly<Record<string, RetentionEvaluationRoutineRow>>,
  captures: RoutineCapture[] = [],
  callbackCompleted?: { value: boolean },
): OutboxWorkerLegalEntityScopeFanoutService => ({
  forEachScope: (workerContext, observe) =>
    Effect.forEach(
      EffectArray.sort(Object.keys(results), Order.String),
      (scopeLegalEntityId) =>
        observe({
          completionPublisher: {
            publish: () => Effect.die(new Error('Retention evaluation does not publish worker completions')),
          },
          legalEntityId: scopeLegalEntityId,
          // SAFETY: The test double preserves the scoped invoker's generic output contract for the
          // exact retention routine and records only its three owner inputs.
          routineInvoker: {
            invoke: (_routine, values) => {
              captures.push({ legalEntityId: scopeLegalEntityId, values });
              return Effect.succeed([results[scopeLegalEntityId]]);
            },
          },
          tenantId: workerContext.tenantId,
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (callbackCompleted !== undefined) {
                callbackCompleted.value = true;
              }
            }),
          ),
        ),
      { concurrency: 1, discard: true },
    ),
});
/* oxlint-enable sonarjs/no-nested-functions */

const runWorker = (
  results: Readonly<Record<string, RetentionEvaluationRoutineRow>>,
  captures?: RoutineCapture[],
  callbackCompleted?: { value: boolean },
) =>
  handleRetentionEvaluation(payload, context).pipe(
    Effect.provideService(OutboxWorkerLegalEntityScopeFanout, fanout(results, captures, callbackCompleted)),
  );

it.effect('processes overdue work only in the one verified owner scope that contains its exact workRef', () =>
  Effect.gen(function* processOverdueWork() {
    yield* TestClock.setTime(Date.parse(evaluatedAt));
    const captures: RoutineCapture[] = [];
    yield* runWorker(
      {
        [legalEntityId]: row('READY'),
        [otherLegalEntityId]: notFoundRow,
      },
      captures,
    );

    expect(captures).toHaveLength(2);
    const matchingInvocation = required(
      captures.find(({ legalEntityId: captured }) => captured === legalEntityId),
      'Expected the exact Legal Entity routine invocation',
    );
    const [capturedWorkRef, capturedMessageId, capturedEvaluatedAt] = matchingInvocation.values;
    expect(capturedWorkRef).toBe(work.workRef);
    expect(capturedMessageId).toBe(messageId);
    const routineEvaluatedAt = required(
      Schema.is(Schema.Date)(capturedEvaluatedAt) ? capturedEvaluatedAt : undefined,
      'Expected the routine processing time as a Date',
    );
    expect(routineEvaluatedAt.toISOString()).toBe(evaluatedAt);
  }),
);

it.effect('commits an indeterminate routine result before returning a typed retryable failure', () => {
  const callbackCompleted = { value: false };
  const indeterminate: RetentionEvaluationRoutineRow = {
    ...row('READY'),
    outcome: 'STATE_AMBIGUOUS',
    reason: 'CURRENT_RULE_AMBIGUOUS',
    status: 'INDETERMINATE',
    work_record: { ...work, evaluatedAt, status: 'INDETERMINATE' },
  };
  return Effect.gen(function* failAfterScopeCommit() {
    yield* TestClock.setTime(Date.parse(evaluatedAt));
    const failure = yield* Effect.flip(runWorker({ [legalEntityId]: indeterminate }, [], callbackCompleted));
    expect(callbackCompleted.value).toBe(true);
    expect(failure.code).toBe('RETENTION_STATE_AMBIGUOUS');
    expect(failure.retryable).toBe(true);
  });
});

it.effect('fails retryably when the exact work is absent from every verified Legal Entity', () =>
  Effect.gen(function* rejectMissingWork() {
    yield* TestClock.setTime(Date.parse(evaluatedAt));
    const failure = yield* Effect.flip(runWorker({ [legalEntityId]: notFoundRow, [otherLegalEntityId]: notFoundRow }));
    expect(failure.code).toBe('RETENTION_STATE_UNAVAILABLE');
    expect(failure.retryable).toBe(true);
  }),
);

it.effect('never accepts COMPLETED without a matching owner execution outcome reference', () =>
  Effect.gen(function* requireOwnerOutcome() {
    yield* TestClock.setTime(Date.parse(evaluatedAt));
    const missingOutcome = yield* Effect.flip(runWorker({ [legalEntityId]: row('COMPLETED') }));
    expect(missingOutcome.code).toBe('RETENTION_STATE_AMBIGUOUS');
    expect(missingOutcome.retryable).toBe(true);

    yield* runWorker({
      [legalEntityId]: row('COMPLETED', { ownerOutcomeRef: 'owner-outcome:customer-email:1' }),
    });
  }),
);

it.effect('requires Core-attested fan-out before invoking any owner routine', () => {
  let listed = 0;
  const verifiedFanout = makeOutboxWorkerLegalEntityScopeFanout({
    list: () => {
      listed += 1;
      return Effect.succeed([{ legalEntityId, status: 'active', tenantId }]);
    },
    run: () => Effect.void,
  });
  return Effect.gen(function* rejectUnattestedContext() {
    yield* TestClock.setTime(Date.parse(evaluatedAt));
    const failure = yield* Effect.flip(
      handleRetentionEvaluation(payload, context).pipe(
        Effect.provideService(OutboxWorkerLegalEntityScopeFanout, verifiedFanout),
      ),
    );
    expect(listed).toBe(0);
    expect(failure.code).toBe('WORKER_CONTEXT_INVALID');
    expect(failure.retryable).toBe(false);
  });
});

it('keeps the generated worker identity and a hardened owner-scoped SQL routine', () => {
  expect(retentionEvaluationWorker.descriptor.entrypoint.authorization.kind).toBe('owner_local_background');
  expect(retentionEvaluationWorker.descriptor.workerKey).toBe('privacy.core.retention-evaluation');
  expect(retentionEvaluationWorker.descriptor.topic).toBe('privacy.retention.evaluation.requested');

  const migration = readFileSync(
    new URL('../../drizzle/20260914160009_retention-evaluation-worker-routine/migration.sql', import.meta.url),
    'utf-8',
  );
  const correction = readFileSync(
    new URL('../../drizzle/20260914161231_fix-retention-evaluation-jsonb-comparisons/migration.sql', import.meta.url),
    'utf-8',
  );
  expect(migration).toContain('SECURITY DEFINER');
  expect(migration).toContain('SET row_security = on');
  expect(migration).toContain("current_setting('ontos.tenant_id', true)");
  expect(migration).toContain("current_setting('ontos.legal_entity_id', true)");
  expect(migration).toContain('FROM privacy.retention_rules AS rule');
  expect(migration).toContain('FROM privacy.retention_exceptions AS exception');
  expect(migration).toContain('FROM privacy.legal_holds AS hold');
  expect(migration).toContain('FROM privacy.owner_execution_outcomes AS owner_outcome');
  expect(migration).toContain("IF v_status = 'COMPLETED' AND v_owner_outcome_ref IS NULL");
  expect(migration).toContain('UPDATE privacy.retention_evaluation_work AS work');
  expect(migration).toContain(
    'REVOKE ALL ON FUNCTION "privacy"."process_retention_evaluation_work"(uuid,uuid,text,uuid,timestamptz) FROM PUBLIC',
  );
  expect(migration).toContain(
    'GRANT EXECUTE ON FUNCTION "privacy"."process_retention_evaluation_work"(uuid,uuid,text,uuid,timestamptz) TO "ontos_runtime"',
  );
  expect(correction).toContain('pg_get_functiondef');
  expect(correction).toContain("'(v_record->''contentScopeRefs'')'");
  expect(correction).toContain(
    'REVOKE ALL ON FUNCTION "privacy"."process_retention_evaluation_work"(uuid,uuid,text,uuid,timestamptz) FROM PUBLIC',
  );
});
