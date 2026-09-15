// fallow-ignore-file code-duplication -- Owner-local protocol code intentionally mirrors its peer owner while preserving separate deployment and persistence authority.
/* jscpd:ignore-start -- Owner-local protocol code intentionally mirrors its peer owner while preserving separate deployment and persistence authority. */
import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import type { OwnerExecutionOutcome } from '@app/privacy/domain/privacy-measure-handoff';
import type { OutboxPayload } from '@app/privacy/outbox/privacy-measure-dispatched';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { fingerprintPrivacyMeasureHandoff } from '../../src/privacy-measure-handoff.ts';
import { handleExecutePrivacyMeasure } from '../../src/workers/execute-privacy-measure.worker.ts';
import { PrivacyMeasureOwnerGateway } from '../../src/workers/privacy-measure-owner-gateway.ts';
import type { PrivacyMeasureOwnerGatewayService } from '../../src/workers/privacy-measure-owner-gateway.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000002';
const payload: OutboxPayload = {
  handoff: {
    contentScopeRefs: ['commerce.customer-context.customer-profile.lifecycle'],
    controllerObligationRef: 'obligation:1',
    dispositionDecision: null,
    expectedEvidenceRefs: ['commerce.customer-context.customer-profile.suspended'],
    idempotencyKey: 'commerce-privacy-measure:1',
    kind: 'RESTRICT',
    measureId: 'measure:1',
    owningCapability: 'commerce.customer-context',
    preconditionRefs: ['decision:1'],
    requestedAt: '2026-09-14T10:00:00.000Z',
    requestedResult: 'SUSPENDED',
    resourceRefs: [
      `commerce.customer-context|commerce.customer-context.retail-customer-profile|${legalEntityId}|30000000-0000-4000-8000-000000000003`,
    ],
    right: 'OBJECTION',
    sourceDecisionRef: 'decision:1',
    sourceDecisionRevision: 1,
    subjectRef: 'subject:1',
    taskId: 'task:1',
    tenantId,
  },
};
const context: OutboxWorkerHandlerContext = {
  attemptNumber: 1,
  claimId: 'claim:1',
  consumerModuleKey: 'commerce.customer-context',
  deliveryId: 'delivery:1',
  domainEventId: 'event:1',
  messageId: 'message:1',
  producerModuleKey: 'privacy.core',
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'privacy.measure.dispatched',
  workerKey: 'commerce.customer-context.execute-privacy-measure-worker',
};
const outcome: OwnerExecutionOutcome = {
  attempt: 1,
  evidenceRefs: ['commerce.customer-context.privacy-measure-execution:1'],
  idempotencyKey: payload.handoff.idempotencyKey,
  includedResourceRefs: payload.handoff.resourceRefs,
  measureId: payload.handoff.measureId,
  occurredAt: '2026-09-14T10:01:00.000Z',
  outcomeId: 'outcome:1',
  owningCapability: 'commerce.customer-context',
  reason: 'Customer Profile suspended',
  recordedAt: '2026-09-14T10:01:00.000Z',
  remainingResourceRefs: [],
  sourceDecisionRef: payload.handoff.sourceDecisionRef,
  sourceDecisionRevision: payload.handoff.sourceDecisionRevision,
  status: 'SUCCEEDED',
  taskId: payload.handoff.taskId,
};
const run = (gateway: PrivacyMeasureOwnerGatewayService, input = payload, workerContext = context) =>
  handleExecutePrivacyMeasure(input, workerContext).pipe(Effect.provideService(PrivacyMeasureOwnerGateway, gateway));

it.effect('executes an exact Commerce handoff once and reports the durable owner outcome', () => {
  let executeCalls = 0;
  let reported: OwnerExecutionOutcome | undefined;
  return run({
    execute: () => {
      executeCalls += 1;
      return Effect.succeed(outcome);
    },
    load: () => Effect.succeedNone,
    report: (value) =>
      Effect.sync(() => {
        reported = value;
      }),
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        expect(executeCalls).toBe(1);
        expect(reported).toEqual(outcome);
      }),
    ),
  );
});

it.effect('reconciles a durable Commerce receipt without repeating the owner mutation', () => {
  let executeCalls = 0;
  return run({
    execute: () => {
      executeCalls += 1;
      return Effect.succeed(outcome);
    },
    load: () =>
      Effect.succeedSome({
        actionInvocationId: '40000000-0000-4000-8000-000000000004',
        handoffFingerprint: fingerprintPrivacyMeasureHandoff(payload.handoff),
        outcome,
      }),
    report: () => Effect.void,
  }).pipe(Effect.tap(() => Effect.sync(() => expect(executeCalls).toBe(0))));
});

it.effect('fails closed when the Commerce delivery context is not exact', () =>
  Effect.gen(function* invalidContext() {
    const failure = yield* Effect.flip(
      run(
        {
          execute: () => Effect.succeed(outcome),
          load: () => Effect.succeedNone,
          report: () => Effect.void,
        },
        payload,
        { ...context, tenantId: '50000000-0000-4000-8000-000000000005' },
      ),
    );
    expect(failure.code).toBe('WORKER_CONTEXT_INVALID');
  }),
);
/* jscpd:ignore-end */
