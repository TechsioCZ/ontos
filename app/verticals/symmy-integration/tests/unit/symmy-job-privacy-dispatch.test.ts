import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import { executeRecordOwnerExecutionOutcomeWithAuthorization } from '@app/privacy/api/client';
import {
  RecordOwnerExecutionOutcomeActionAlreadyCommittedProblemSchema,
  RecordOwnerExecutionOutcomeActionConflictProblemSchema,
  RecordOwnerExecutionOutcomeActionCommitIndeterminateProblemSchema,
} from '@app/privacy/api/record-owner-execution-outcome-action';
import { OwnerExecutionOutcomeSchema, PrivacyMeasureHandoffSchema } from '@app/privacy/domain/privacy-measure-handoff';
import type { OwnerExecutionOutcome } from '@app/privacy/domain/privacy-measure-handoff';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Layer, Option, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';
import { SymmyJobPrivacyExecutionReceiptSchema } from '../../shared/domain/symmy-job-privacy-execution.ts';
import type { SymmyJobPrivacyExecutionReceipt } from '../../shared/domain/symmy-job-privacy-execution.ts';
import { SymmyJobPrivacyDispatchError } from '../../src/services/symmy-job-privacy-dispatch-error.ts';
import {
  symmyJobPrivacyDispatchCommandKey,
  symmyJobPrivacyOutcomeAlreadyRecorded,
  SymmyJobPrivacyDispatchGateway,
} from '../../src/services/symmy-job-privacy-dispatch-gateway.service.ts';
import type { SymmyJobPrivacyDispatchGatewayService } from '../../src/services/symmy-job-privacy-dispatch-gateway.service.ts';
import { fingerprintSymmyJobPrivacyHandoff } from '../../src/services/symmy-job-privacy-fingerprint.ts';
import { handleSymmyJobPrivacyDispatch } from '../../src/workers/symmy-job-privacy-dispatch.worker.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const jobId = '10000000-0000-4000-8000-000000000002';
const resource = `integration.symmy.job:${jobId}`;
const handoff = Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({
  contentScopeRefs: [`${resource}#integration.symmy.job-intent`],
  controllerObligationRef: null,
  dispositionDecision: 'DELETE',
  expectedEvidenceRefs: [],
  idempotencyKey: 'internal-dispatch',
  kind: 'DELETE',
  measureId: 'internal-measure',
  owningCapability: 'integration.symmy',
  preconditionRefs: [],
  requestedAt: '2026-11-07T00:00:00.000Z',
  requestedResult: 'Erase the exact operational payload',
  resourceRefs: [resource],
  right: 'ERASURE',
  sourceDecisionRef: 'internal-decision',
  sourceDecisionRevision: 1,
  subjectRef: 'internal-subject',
  taskId: 'internal-task',
  tenantId,
});
const raw: OutboxWorkerHandlerContext = {
  actorPrincipalId: '10000000-0000-4000-8000-000000000003',
  attemptNumber: 1,
  claimId: 'worker:claim',
  compositionRevision: 'a'.repeat(64),
  consumerModuleKey: 'integration.symmy',
  deliveryId: '10000000-0000-4000-8000-000000000004',
  domainEventId: '10000000-0000-4000-8000-000000000005',
  legalEntityScope: 'required',
  messageId: '10000000-0000-4000-8000-000000000006',
  originatorInvocationId: '10000000-0000-4000-8000-000000000007',
  producerModuleKey: 'privacy.core',
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'privacy.measure.dispatched',
  workerKey: 'integration.symmy.symmy-job-privacy-dispatch',
};
const context = attestOutboxWorkerHandlerContext(raw);
const outcome = (status: 'SUCCEEDED' | 'BLOCKED', attempt = 1): OwnerExecutionOutcome =>
  Schema.decodeUnknownSync(OwnerExecutionOutcomeSchema)({
    attempt,
    evidenceRefs: ['integration.symmy.privacy-measure-execution:10000000-0000-4000-8000-000000000008'],
    idempotencyKey: handoff.idempotencyKey,
    includedResourceRefs: status === 'SUCCEEDED' ? [resource] : [],
    measureId: handoff.measureId,
    occurredAt: '2026-11-07T00:00:00.000Z',
    outcomeId: '10000000-0000-4000-8000-000000000008',
    owningCapability: 'integration.symmy',
    reason: 'Internal lifecycle outcome',
    recordedAt: '2026-11-07T00:00:00.000Z',
    remainingResourceRefs: status === 'SUCCEEDED' ? [] : [resource],
    sourceDecisionRef: handoff.sourceDecisionRef,
    sourceDecisionRevision: handoff.sourceDecisionRevision,
    status,
    taskId: handoff.taskId,
  });
const replayedReport = RecordOwnerExecutionOutcomeActionAlreadyCommittedProblemSchema.make({
  code: 'action_already_committed',
  detail: 'This Action is already committed. Refresh governed reads.',
  invocationId: '10000000-0000-4000-8000-000000000009',
  resolution: 'REFRESH_GOVERNED_READS',
  retryCommand: false,
  status: 409,
  title: 'Action already committed',
  type: 'https://ontos.dev/problems/action-already-committed',
});
const declaredReportProblem = Schema.Union([
  RecordOwnerExecutionOutcomeActionAlreadyCommittedProblemSchema,
  RecordOwnerExecutionOutcomeActionConflictProblemSchema,
  RecordOwnerExecutionOutcomeActionCommitIndeterminateProblemSchema,
]);
// INTERNAL transport-codec proof: the credential has no authority and the HTTP seam never contacts a live issuer.
const reportThroughDeclaredHttp = (problem: typeof declaredReportProblem.Type, recorded: OwnerExecutionOutcome) =>
  Effect.gen(function* generatedReportClient() {
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(declaredReportProblem))(problem);
    return yield* executeRecordOwnerExecutionOutcomeWithAuthorization(
      {
        request: {
          attempt: recorded.attempt,
          measureId: recorded.measureId,
          taskId: recorded.taskId,
        },
      },
      'Bearer INTERNAL_CODEC_NON_AUTHORITY',
      'internal-report-codec',
      {
        baseUrl: 'https://privacy.internal.test/privacy-api',
        compositionRevision: 'a'.repeat(64),
        idempotencyKey: 'internal-codec-report',
      },
    ).pipe(
      Effect.asVoid,
      Effect.catchIf(symmyJobPrivacyOutcomeAlreadyRecorded, () => Effect.void),
      Effect.provide(
        FetchHttpClient.layer.pipe(
          Layer.provide(
            Layer.succeed(
              FetchHttpClient.Fetch,
              async () =>
                new Response(body, { headers: { 'content-type': 'application/problem+json' }, status: problem.status }),
            ),
          ),
        ),
      ),
    );
  });

const harness = Effect.gen(function* fixture() {
  // INTERNAL component proof; Core's public test attestation seam does not prove HTTP authorization.
  const fingerprint = yield* fingerprintSymmyJobPrivacyHandoff(handoff);
  let receipt = Option.none<SymmyJobPrivacyExecutionReceipt>();
  let next = outcome('SUCCEEDED');
  let failReport = false;
  let replayReport = false;
  const events: string[] = [];
  const reports: OwnerExecutionOutcome[] = [];
  const gateway: SymmyJobPrivacyDispatchGatewayService = {
    execute: (input, claimed) =>
      Effect.sync(() => {
        expect(input).toBe(handoff);
        expect(claimed.originatorInvocationId).toBe(raw.originatorInvocationId);
        events.push('execute');
        receipt = Option.some(
          Schema.decodeUnknownSync(SymmyJobPrivacyExecutionReceiptSchema)({
            actionInvocationId: jobId,
            handoffFingerprint: fingerprint,
            outcome: next,
          }),
        );
        return next;
      }),
    load: () =>
      Effect.sync(() => {
        events.push('load');
        return receipt;
      }),
    report: (recorded) =>
      Effect.gen(function* report() {
        events.push('report');
        reports.push(recorded);
        if (failReport) {
          return yield* new SymmyJobPrivacyDispatchError({
            code: 'privacy_dispatch_gateway_unavailable',
            reason: 'Internal lost acknowledgement',
            retryable: true,
          });
        }
        if (replayReport && recorded.status === 'BLOCKED') {
          yield* reportThroughDeclaredHttp(replayedReport, recorded).pipe(Effect.orDie);
        }
        return yield* Effect.void;
      }),
  };
  return {
    events,
    reports,
    run: (claimed: OutboxWorkerHandlerContext = context) =>
      handleSymmyJobPrivacyDispatch({ handoff }, claimed).pipe(
        Effect.provideService(SymmyJobPrivacyDispatchGateway, gateway),
      ),
    setFailure: (value: boolean) => {
      failReport = value;
    },
    setNext: (value: OwnerExecutionOutcome) => {
      next = value;
    },
    setReceipt: (value: typeof SymmyJobPrivacyExecutionReceiptSchema.Encoded) => {
      receipt = Option.some(Schema.decodeUnknownSync(SymmyJobPrivacyExecutionReceiptSchema)(value));
    },
    setReplay: (value: boolean) => {
      replayReport = value;
    },
  };
});

it.effect('executes a missing receipt once and reports the authoritative outcome', () =>
  Effect.gen(function* firstDelivery() {
    const state = yield* harness;
    yield* state.run();
    expect(state.events).toEqual(['load', 'execute', 'report']);
    expect(state.reports).toEqual([outcome('SUCCEEDED')]);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect('reconciles a lost report acknowledgement without another owner mutation', () =>
  Effect.gen(function* restart() {
    const state = yield* harness;
    state.setFailure(true);
    expect(yield* state.run().pipe(Effect.flip)).toMatchObject({ code: 'privacy_dispatch_gateway_unavailable' });
    state.setFailure(false);
    yield* state.run(attestOutboxWorkerHandlerContext({ ...raw, attemptNumber: 2 }));
    expect(state.events).toEqual(['load', 'execute', 'report', 'load', 'report']);
    expect(state.reports).toEqual([outcome('SUCCEEDED'), outcome('SUCCEEDED')]);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect('rechecks a blocked receipt on a new redrive claim even when its attempt budget resets', () =>
  Effect.gen(function* holdThenRetry() {
    const state = yield* harness;
    state.setNext(outcome('BLOCKED'));
    expect(yield* state.run().pipe(Effect.flip)).toMatchObject({ code: 'privacy_dispatch_work_unresolved' });
    state.setReplay(true);
    state.setNext(outcome('SUCCEEDED', 2));
    yield* state.run(attestOutboxWorkerHandlerContext({ ...raw, claimId: 'worker:redriven-claim' }));
    expect(state.events).toEqual(['load', 'execute', 'report', 'load', 'report', 'execute', 'report']);
    expect(state.reports.map(({ status }) => status)).toEqual(['BLOCKED', 'BLOCKED', 'SUCCEEDED']);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect('refuses a changed immutable handoff fingerprint before reporting or execution', () =>
  Effect.gen(function* changedReceipt() {
    const state = yield* harness;
    state.setReceipt({ actionInvocationId: jobId, handoffFingerprint: 'b'.repeat(64), outcome: outcome('SUCCEEDED') });
    expect(yield* state.run().pipe(Effect.flip)).toMatchObject({ code: 'privacy_dispatch_receipt_conflict' });
    expect(state.events).toEqual(['load']);
    expect(state.reports).toEqual([]);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect('refuses a spoofed decision or resource partition before reporting', () =>
  Effect.gen(function* badOutcome() {
    const state = yield* harness;
    state.setNext({ ...outcome('SUCCEEDED'), sourceDecisionRef: 'different-decision' });
    expect(yield* state.run().pipe(Effect.flip)).toMatchObject({ code: 'privacy_dispatch_receipt_conflict' });
    expect(state.reports).toEqual([]);
    const other = yield* harness;
    other.setNext({ ...outcome('SUCCEEDED'), includedResourceRefs: [resource], remainingResourceRefs: [resource] });
    expect(yield* other.run().pipe(Effect.flip)).toMatchObject({ code: 'privacy_dispatch_receipt_conflict' });
    expect(other.reports).toEqual([]);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect('requires an exact native claim and ignores another owner subscriber', () =>
  Effect.gen(function* contextBoundary() {
    const state = yield* harness;
    expect(yield* state.run(raw).pipe(Effect.flip)).toMatchObject({ code: 'privacy_dispatch_context_invalid' });
    expect(
      yield* state
        .run(attestOutboxWorkerHandlerContext({ ...raw, producerModuleKey: 'party.registry' }))
        .pipe(Effect.flip),
    ).toMatchObject({ code: 'privacy_dispatch_context_invalid' });
    expect(state.events).toEqual([]);
    const ignored: SymmyJobPrivacyDispatchGatewayService = {
      execute: () => Effect.die('Foreign owner must not execute'),
      load: () => Effect.die('Foreign owner must not load'),
      report: () => Effect.die('Foreign owner must not report'),
    };
    yield* handleSymmyJobPrivacyDispatch({ handoff: { ...handoff, owningCapability: 'party.registry' } }, raw).pipe(
      Effect.provideService(SymmyJobPrivacyDispatchGateway, ignored),
    );
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect('keeps one native claim key stable and gives a redrive a fresh opaque execution key', () =>
  Effect.gen(function* claimIdentity() {
    const first = yield* symmyJobPrivacyDispatchCommandKey(handoff, context);
    const repeated = yield* symmyJobPrivacyDispatchCommandKey(handoff, context);
    const redriven = yield* symmyJobPrivacyDispatchCommandKey(
      handoff,
      attestOutboxWorkerHandlerContext({ ...raw, claimId: 'worker:redriven-claim' }),
    );
    expect(first).toBe(repeated);
    expect(redriven).not.toBe(first);
    expect(first.length).toBeLessThan(200);
    expect(first).not.toContain(handoff.idempotencyKey);
    expect(first).not.toContain(raw.claimId);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect('acknowledges only the exact generated already-committed report and preserves conflict uncertainty', () =>
  Effect.gen(function* exactCommittedReport() {
    yield* reportThroughDeclaredHttp(replayedReport, outcome('BLOCKED'));
    const hashConflict = RecordOwnerExecutionOutcomeActionConflictProblemSchema.make({
      code: 'action_request_hash_conflict',
      detail: 'The request hash differs.',
      status: 409,
      title: 'Action conflict',
      type: 'https://ontos.dev/problems/action-conflict',
    });
    const conflict = yield* reportThroughDeclaredHttp(hashConflict, outcome('BLOCKED')).pipe(Effect.flip);
    expect(Schema.is(RecordOwnerExecutionOutcomeActionConflictProblemSchema)(conflict)).toBe(true);
    const indeterminate = RecordOwnerExecutionOutcomeActionCommitIndeterminateProblemSchema.make({
      detail: 'Resolve the original commit.',
      invocationId: replayedReport.invocationId,
      resolution: 'RESOLVE_COMMIT',
      retryCommand: false,
      status: 503,
      title: 'Commit unresolved',
      type: 'https://ontos.dev/problems/action-commit-indeterminate',
    });
    const uncertain = yield* reportThroughDeclaredHttp(indeterminate, outcome('BLOCKED')).pipe(Effect.flip);
    expect(Schema.is(RecordOwnerExecutionOutcomeActionCommitIndeterminateProblemSchema)(uncertain)).toBe(true);
    expect(symmyJobPrivacyOutcomeAlreadyRecorded({ code: 'action_already_committed', status: 409 })).toBe(false);
  }),
);
