import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import { PrivacyMeasureHandoffSchema } from '@app/privacy/domain/privacy-measure-handoff';
import { PrivacyDispatchContinuationPayloadSchema } from '@app/shared-contracts';
import { NodeCrypto } from '@effect/platform-node';
import { FetchHttpClient } from 'effect/http';
import { Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { privacyMeasureReporterService } from '../../src/services/privacy-measure-reporter.ts';

/**
 * [#1410 AC-14] The reporting transport of the Communications worker. Everything before Core's gateway is proved here: the claim
 * it needs and the failure it raises when the Composition does not provide the report operation. The gateway exchange itself
 * (a signed assertion minted by the Shell and verified by Privacy) needs the running Shell and is proved by the Shell's native
 * Privacy dispatch evidence, not by a double here.
 */
const tenantId = '00000000-0000-4000-8000-0000000000a1';
const handoff = Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({
  contentScopeRefs: ['communications.core.history'],
  controllerObligationRef: null,
  dispositionDecision: 'RESTRICT',
  expectedEvidenceRefs: [],
  idempotencyKey: 'FICTIONAL-idempotency-1',
  kind: 'RESTRICT',
  measureId: 'FICTIONAL-measure-1',
  owningCapability: 'communications.core',
  preconditionRefs: [],
  requestedAt: '2026-11-19T10:00:00.000Z',
  requestedResult: 'restrict message metadata',
  resourceRefs: ['communications.core.intent:FICTIONAL-intent-1'],
  right: 'ERASURE',
  sourceDecisionRef: 'FICTIONAL-decision-1',
  sourceDecisionRevision: 1,
  subjectRef: 'FICTIONAL-subject-1',
  taskId: 'FICTIONAL-task-1',
  tenantId,
});
const fields: OutboxWorkerHandlerContext = {
  attemptNumber: 1,
  claimId: 'claim-1',
  compositionRevision: 'a'.repeat(64),
  consumerModuleKey: 'communications.core',
  deliveryId: 'delivery-1',
  domainEventId: 'event-1',
  legalEntityScope: 'forbidden',
  messageId: 'message-1',
  originatorInvocationId: '00000000-0000-4000-8000-0000000000b1',
  producerModuleKey: 'privacy.core',
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'privacy.measure.dispatched',
  workerKey: 'communications.core.receive-privacy-measure',
};
const transport = Layer.mergeAll(NodeCrypto.layer, FetchHttpClient.layer);
const report = (context: OutboxWorkerHandlerContext) =>
  privacyMeasureReporterService().pipe(
    Effect.flatMap((service) => service.report(handoff, 1, context)),
    Effect.provide(transport),
  );

it.effect('refuses, without any call, a caller-built context and a delivery with no original dispatch invocation', () =>
  Effect.gen(function* refused() {
    const callerBuilt = yield* Effect.flip(report(fields));
    expect(callerBuilt).toMatchObject({ code: 'privacy_measure_context_invalid', retryable: false });
    const { originatorInvocationId: _originator, ...withoutOriginator } = fields;
    const orphan = yield* Effect.flip(report(attestOutboxWorkerHandlerContext(withoutOriginator)));
    expect(orphan).toMatchObject({ code: 'privacy_measure_context_invalid', retryable: false });
  }),
);

it.effect('fails retryably, never silently, when the Composition does not provide the report operation', () =>
  Effect.gen(function* unprovided() {
    // outside Core's execution lease the requirement cannot resolve: the delivery must fail and be retried, not complete
    const failed = yield* Effect.flip(report(attestOutboxWorkerHandlerContext(fields)));
    expect(failed).toMatchObject({ code: 'privacy_measure_report_unavailable', retryable: true });
  }),
);

const continuationFields: OutboxWorkerHandlerContext = {
  ...fields,
  claimId: 'continuation-claim-1',
  deliveryId: 'continuation-delivery-1',
  producerModuleKey: 'communications.core',
  topic: 'communications.core.owner-execution-evidence-recorded.v1',
  workerKey: 'communications.core.report-privacy-owner-outcome',
};
const continuationPayload = Schema.decodeUnknownSync(PrivacyDispatchContinuationPayloadSchema)({
  attempt: 2,
  dispatchInvocationId: '00000000-0000-4000-8000-0000000000b1',
  measureId: handoff.measureId,
  taskId: handoff.taskId,
});
const reportRecorded = (context: OutboxWorkerHandlerContext) =>
  privacyMeasureReporterService().pipe(
    Effect.flatMap((service) => service.reportRecorded(continuationPayload, context)),
    Effect.provide(transport),
  );

it.effect('reports a later human-recorded confirmation only from a native claimed continuation delivery', () =>
  Effect.gen(function* continuationReport() {
    // a caller-built context never reaches the gateway
    expect(yield* Effect.flip(reportRecorded(continuationFields))).toMatchObject({
      code: 'privacy_measure_context_invalid',
      retryable: false,
    });
    // outside Core's execution lease the continuation requirement cannot resolve: retried, never dropped or completed
    expect(yield* Effect.flip(reportRecorded(attestOutboxWorkerHandlerContext(continuationFields)))).toMatchObject({
      code: 'privacy_measure_report_unavailable',
      retryable: true,
    });
  }),
);
