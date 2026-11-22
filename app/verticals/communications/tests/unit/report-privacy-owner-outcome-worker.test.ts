import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { PrivacyDispatchContinuationPayloadSchema } from '@app/shared-contracts';
import type { PrivacyDispatchContinuationPayload } from '@app/shared-contracts';
import { PrivacyMeasureReporter } from '../../src/services/privacy-measure-reporter.ts';
import {
  handleReportPrivacyOwnerOutcome,
  reportPrivacyOwnerOutcomeWorker,
} from '../../src/workers/report-privacy-owner-outcome.worker.ts';

/**
 * E19 (#1410): the continuation worker hands Privacy exactly the original dispatch identities and the attempt its own
 * message names, only from its own native claimed delivery, and never anything else. The gateway admission of the
 * continuation is proven by the Shell's native continuation test against real PostgreSQL and SpiceDB.
 */
const tenantId = '00000000-0000-4000-8000-0000000000a1';
const payload = Schema.decodeUnknownSync(PrivacyDispatchContinuationPayloadSchema)({
  attempt: 2,
  dispatchInvocationId: '00000000-0000-4000-8000-0000000000b1',
  measureId: 'FICTIONAL-measure-1',
  taskId: 'FICTIONAL-task-1',
});
const fields: OutboxWorkerHandlerContext = {
  attemptNumber: 1,
  claimId: 'continuation-claim-1',
  compositionRevision: 'a'.repeat(64),
  consumerModuleKey: 'communications.core',
  deliveryId: 'continuation-delivery-1',
  domainEventId: 'event-1',
  legalEntityScope: 'forbidden',
  messageId: 'message-1',
  originatorInvocationId: '00000000-0000-4000-8000-0000000000c1',
  producerModuleKey: 'communications.core',
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'communications.core.owner-execution-evidence-recorded.v1',
  workerKey: 'communications.core.report-privacy-owner-outcome',
};

const run = (context: OutboxWorkerHandlerContext) => {
  const reports: {
    readonly context: OutboxWorkerHandlerContext;
    readonly payload: PrivacyDispatchContinuationPayload;
  }[] = [];
  return handleReportPrivacyOwnerOutcome(payload, context).pipe(
    Effect.provideService(PrivacyMeasureReporter, {
      report: () => Effect.die('The continuation worker never makes a take-over report'),
      reportRecorded: (reported, reportedContext) =>
        Effect.sync(() => {
          reports.push({ context: reportedContext, payload: reported });
        }),
    }),
    Effect.result,
    Effect.map((result) => ({ reports, result })),
  );
};

it('is a Tenant-wide owner-local worker of the Communications continuation message only', () => {
  expect(reportPrivacyOwnerOutcomeWorker.descriptor).toMatchObject({
    consumerModuleKey: 'communications.core',
    entrypoint: { authorization: { kind: 'owner_local_background' }, entrypointKey: fields.workerKey },
    legalEntityScope: 'forbidden',
    producerModuleKey: 'communications.core',
    topic: 'communications.core.owner-execution-evidence-recorded.v1',
    workerKey: 'communications.core.report-privacy-owner-outcome',
  });
});

it.effect(
  'reports exactly its message from its own claimed delivery, and refuses any other context without a call',
  () =>
    Effect.gen(function* continuationWorker() {
      const context = attestOutboxWorkerHandlerContext(fields);
      const reported = yield* run(context);
      expect(reported.result._tag).toBe('Success');
      expect(reported.reports).toEqual([{ context, payload }]);
      for (const change of [
        { workerKey: 'communications.core.receive-privacy-measure' },
        { producerModuleKey: 'privacy.core' },
        { topic: 'privacy.measure.dispatched' },
        { consumerModuleKey: 'integration.symmy' },
        { legalEntityScope: 'required' as const },
      ]) {
        const refused = yield* run(attestOutboxWorkerHandlerContext({ ...fields, ...change }));
        expect(refused.result._tag).toBe('Failure');
        expect(refused.reports).toEqual([]);
      }
      // a caller-built context is not a native claimed delivery
      const callerBuilt = yield* run(fields);
      expect(callerBuilt.result._tag).toBe('Failure');
      expect(callerBuilt.reports).toEqual([]);
    }),
);
