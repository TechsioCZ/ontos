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
    contentScopeRefs: ['party.registry.counterparty.lifecycle'],
    controllerObligationRef: 'obligation:1',
    dispositionDecision: null,
    expectedEvidenceRefs: ['party.registry.counterparty.archived'],
    idempotencyKey: 'party-privacy-measure:1',
    kind: 'RESTRICT',
    measureId: 'measure:1',
    owningCapability: 'party.registry',
    preconditionRefs: ['decision:1'],
    requestedAt: '2026-09-14T10:00:00.000Z',
    requestedResult: 'ARCHIVED',
    resourceRefs: [`party.registry|party.registry.counterparty|${legalEntityId}|30000000-0000-4000-8000-000000000003`],
    right: 'RESTRICTION',
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
  consumerModuleKey: 'party.registry',
  deliveryId: 'delivery:1',
  domainEventId: 'event:1',
  messageId: 'message:1',
  producerModuleKey: 'privacy.core',
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'privacy.measure.dispatched',
  workerKey: 'party.registry.execute-privacy-measure-worker',
};
const outcome: OwnerExecutionOutcome = {
  attempt: 1,
  evidenceRefs: ['party.registry.privacy-measure-execution:1'],
  idempotencyKey: payload.handoff.idempotencyKey,
  includedResourceRefs: payload.handoff.resourceRefs,
  measureId: payload.handoff.measureId,
  occurredAt: '2026-09-14T10:01:00.000Z',
  outcomeId: 'outcome:1',
  owningCapability: 'party.registry',
  reason: 'Counterparty archived',
  recordedAt: '2026-09-14T10:01:00.000Z',
  remainingResourceRefs: [],
  sourceDecisionRef: payload.handoff.sourceDecisionRef,
  sourceDecisionRevision: payload.handoff.sourceDecisionRevision,
  status: 'SUCCEEDED',
  taskId: payload.handoff.taskId,
};

const run = (gateway: PrivacyMeasureOwnerGatewayService, input = payload, workerContext = context) =>
  handleExecutePrivacyMeasure(input, workerContext).pipe(Effect.provideService(PrivacyMeasureOwnerGateway, gateway));

it.effect('executes an exact Party handoff once and reports the durable owner outcome', () => {
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

it.effect('reconciles a durable Party receipt without repeating the owner mutation', () => {
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

it.effect('fails closed when an owner Resource reference crosses Legal Entity scope', () =>
  Effect.gen(function* crossScope() {
    const failure = yield* Effect.flip(
      run(
        {
          execute: () => Effect.succeed(outcome),
          load: () => Effect.succeedNone,
          report: () => Effect.void,
        },
        {
          handoff: {
            ...payload.handoff,
            resourceRefs: [
              ...payload.handoff.resourceRefs,
              'party.registry|party.registry.counterparty|50000000-0000-4000-8000-000000000005|60000000-0000-4000-8000-000000000006',
            ],
          },
        },
      ),
    );
    expect(failure.code).toBe('WORKER_CONTEXT_INVALID');
  }),
);
