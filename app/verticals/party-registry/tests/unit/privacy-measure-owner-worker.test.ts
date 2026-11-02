import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import type { OwnerExecutionOutcome, OwnerExecutionStatus } from '@app/privacy/domain/privacy-measure-handoff';
import type { OutboxPayload } from '@app/privacy/outbox/privacy-measure-dispatched';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { fingerprintPrivacyMeasureHandoff } from '../../src/privacy-measure-handoff.ts';
import { handleExecutePrivacyMeasure } from '../../src/workers/execute-privacy-measure.worker.ts';
import {
  ExecutePrivacyMeasureWorkerRejected,
  PrivacyMeasureOwnerGateway,
} from '../../src/workers/privacy-measure-owner-gateway.ts';
import type { PrivacyMeasureOwnerGatewayService } from '../../src/workers/privacy-measure-owner-gateway.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000002';
const payload: OutboxPayload = {
  handoff: {
    contentScopeRefs: ['party.registry.counterparty.lifecycle'],
    controllerObligationRef: 'obligation:1',
    dispositionDecision: 'RESTRICT',
    expectedEvidenceRefs: ['party.registry.counterparty.archived'],
    idempotencyKey: 'party-privacy-measure:1',
    kind: 'RESTRICT',
    measureId: 'measure:1',
    owningCapability: 'party.registry',
    preconditionRefs: ['decision:1'],
    requestedAt: '2026-09-14T10:00:00.000Z',
    requestedResult: 'RESTRICTED',
    resourceRefs: [`party.registry|party.registry.counterparty|${legalEntityId}|30000000-0000-4000-8000-000000000003`],
    right: null,
    sourceDecisionRef: 'decision:1',
    sourceDecisionRevision: 1,
    subjectRef: 'subject:1',
    taskId: 'task:1',
    tenantId,
  },
};
const context: OutboxWorkerHandlerContext = {
  compositionRevision: 'test-composition',
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
  includedResourceRefs: [],
  measureId: payload.handoff.measureId,
  occurredAt: '2026-09-14T10:01:00.000Z',
  outcomeId: 'outcome:1',
  owningCapability: 'party.registry',
  reason: 'No approved owner semantic contract',
  recordedAt: '2026-09-14T10:01:00.000Z',
  remainingResourceRefs: payload.handoff.resourceRefs,
  sourceDecisionRef: payload.handoff.sourceDecisionRef,
  sourceDecisionRevision: payload.handoff.sourceDecisionRevision,
  status: 'BUSINESS_REJECTED',
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

const terminalStatuses: readonly OwnerExecutionStatus[] = ['SUCCEEDED', 'BUSINESS_REJECTED', 'NOT_APPLICABLE'];
for (const status of terminalStatuses) {
  it.effect(`acknowledges terminal ${status} only after reporting the authoritative outcome`, () =>
    Effect.gen(function* terminalOutcome() {
      const calls: string[] = [];
      const terminal: OwnerExecutionOutcome =
        status === 'SUCCEEDED'
          ? { ...outcome, includedResourceRefs: payload.handoff.resourceRefs, remainingResourceRefs: [], status }
          : { ...outcome, status };
      yield* run({
        execute: () =>
          Effect.sync(() => {
            calls.push('execute');
            return terminal;
          }),
        load: () =>
          Effect.sync(() => {
            calls.push('load');
          }).pipe(Effect.andThen(Effect.succeedNone)),
        report: (value, scope, correlation, revision) =>
          Effect.sync(() => {
            calls.push('report');
            expect(value).toEqual(terminal);
            expect(scope).toBe(legalEntityId);
            expect(correlation).toBe(context.messageId);
            expect(revision).toBe(context.compositionRevision);
          }),
      });
      expect(calls).toEqual(['load', 'execute', 'report']);
    }),
  );
}

const unresolvedStatuses: readonly OwnerExecutionStatus[] = [
  'RECEIVED',
  'IN_PROGRESS',
  'PARTIAL',
  'TECHNICAL_FAILED',
  'BLOCKED',
  'INDETERMINATE',
];
for (const status of unresolvedStatuses) {
  it.effect(`reports ${status} truthfully but rejects completion on execution and receipt replay`, () =>
    Effect.gen(function* unresolvedOutcome() {
      const unresolved = { ...outcome, status };
      const calls: string[] = [];
      let durable = false;
      const gateway: PrivacyMeasureOwnerGatewayService = {
        execute: () =>
          Effect.sync(() => {
            calls.push('execute');
            durable = true;
            return unresolved;
          }),
        load: () =>
          Effect.sync(() => {
            calls.push('load');
          }).pipe(
            Effect.flatMap(() =>
              durable
                ? Effect.succeedSome({
                    actionInvocationId: '40000000-0000-4000-8000-000000000004',
                    handoffFingerprint: fingerprintPrivacyMeasureHandoff(payload.handoff),
                    outcome: unresolved,
                  })
                : Effect.succeedNone,
            ),
          ),
        report: (value) =>
          Effect.sync(() => {
            calls.push('report');
            expect(value).toEqual(unresolved);
          }),
      };
      const first = yield* run(gateway).pipe(Effect.match({ onFailure: (failure) => failure, onSuccess: () => null }));
      const retry = yield* run(gateway, payload, { ...context, attemptNumber: 2 }).pipe(
        Effect.match({ onFailure: (failure) => failure, onSuccess: () => null }),
      );
      expect(Schema.is(ExecutePrivacyMeasureWorkerRejected)(first)).toBe(true);
      expect(first).toMatchObject({ code: 'OWNER_COMMIT_INDETERMINATE', retryable: true });
      expect(retry).toMatchObject({ code: 'OWNER_COMMIT_INDETERMINATE', retryable: true });
      expect(calls).toEqual(['load', 'execute', 'report', 'load', 'report']);
    }),
  );
}

it.effect('retries a lost report using the exact durable receipt without repeating execution', () =>
  Effect.gen(function* reportRecovery() {
    let executions = 0;
    let reports = 0;
    const gateway: PrivacyMeasureOwnerGatewayService = {
      execute: () =>
        Effect.sync(() => {
          executions += 1;
          return outcome;
        }),
      load: () =>
        executions === 0
          ? Effect.succeedNone
          : Effect.succeedSome({
              actionInvocationId: '40000000-0000-4000-8000-000000000004',
              handoffFingerprint: fingerprintPrivacyMeasureHandoff(payload.handoff),
              outcome,
            }),
      report: () => {
        reports += 1;
        return reports === 1
          ? Effect.fail(
              new ExecutePrivacyMeasureWorkerRejected({
                code: 'OWNER_COMMIT_INDETERMINATE',
                reason: 'Report acknowledgement unavailable',
                retryable: true,
              }),
            )
          : Effect.void;
      },
    };
    const failure = yield* Effect.flip(run(gateway));
    expect(failure.code).toBe('OWNER_COMMIT_INDETERMINATE');
    yield* run(gateway, payload, { ...context, attemptNumber: 2 });
    expect(executions).toBe(1);
    expect(reports).toBe(2);
  }),
);

const failurePhases: readonly ('load' | 'execute' | 'report')[] = ['load', 'execute', 'report'];
for (const phase of failurePhases) {
  it.effect(`preserves a ${phase} gateway failure without acknowledging or continuing`, () =>
    Effect.gen(function* gatewayFailure() {
      const failure = new ExecutePrivacyMeasureWorkerRejected({
        code: 'OWNER_GATEWAY_UNAVAILABLE',
        reason: 'Gateway temporarily unavailable',
        retryable: true,
      });
      const calls: string[] = [];
      const actual = yield* Effect.flip(
        run({
          execute: () => {
            calls.push('execute');
            return phase === 'execute' ? Effect.fail(failure) : Effect.succeed(outcome);
          },
          load: () => {
            calls.push('load');
            return phase === 'load' ? Effect.fail(failure) : Effect.succeedNone;
          },
          report: () => {
            calls.push('report');
            return Effect.fail(failure);
          },
        }),
      );
      expect(actual).toBe(failure);
      const expectedCalls = { load: ['load'], execute: ['load', 'execute'], report: ['load', 'execute', 'report'] };
      expect(calls).toEqual(expectedCalls[phase]);
    }),
  );
}

const mismatchKinds: readonly ('fingerprint' | 'identity' | 'partition' | 'success-with-remaining')[] = [
  'fingerprint',
  'identity',
  'partition',
  'success-with-remaining',
];
for (const mismatch of mismatchKinds) {
  it.effect(`rejects ${mismatch} receipt conflicts before reporting`, () =>
    Effect.gen(function* receiptConflict() {
      let reports = 0;
      let executions = 0;
      const conflictingOutcomes = {
        fingerprint: outcome,
        identity: { ...outcome, taskId: 'other-task' },
        partition: { ...outcome, includedResourceRefs: payload.handoff.resourceRefs },
        'success-with-remaining': { ...outcome, status: 'SUCCEEDED' },
      } satisfies Record<typeof mismatch, OwnerExecutionOutcome>;
      const conflicting = conflictingOutcomes[mismatch];
      const failure = yield* Effect.flip(
        run({
          execute: () => {
            executions += 1;
            return Effect.succeed(outcome);
          },
          load: () =>
            Effect.succeedSome({
              actionInvocationId: '40000000-0000-4000-8000-000000000004',
              handoffFingerprint:
                mismatch === 'fingerprint' ? 'foreign' : fingerprintPrivacyMeasureHandoff(payload.handoff),
              outcome: conflicting,
            }),
          report: () =>
            Effect.sync(() => {
              reports += 1;
            }),
        }),
      );
      expect(failure.code).toBe('OWNER_RECEIPT_CONFLICT');
      expect(failure.retryable).toBe(false);
      expect(executions).toBe(0);
      expect(reports).toBe(0);
    }),
  );
}
