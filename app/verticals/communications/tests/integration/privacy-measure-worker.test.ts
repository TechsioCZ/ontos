import { OutboxWorkerTenantScope } from '@app/core-runtime/outbox/worker';
import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import type { OutboxWorkerTenantScopeView } from '@app/core-runtime/outbox/worker';
import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import { PrivacyMeasureHandoffSchema } from '@app/privacy/domain/privacy-measure-handoff';
import type { PrivacyMeasureHandoff } from '@app/privacy/domain/privacy-measure-handoff';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { scopePartRefs } from '../../shared/privacy-owner/inventory.ts';
import { privacyMeasureHandoffs } from '../../src/database/schema.ts';
import { PrivacyMeasureReportError } from '../../src/services/privacy-measure-report-error.ts';
import { PrivacyMeasureReporter } from '../../src/services/privacy-measure-reporter.ts';
import { handleReceivePrivacyMeasure } from '../../src/workers/receive-privacy-measure.worker.ts';
import { makeRuntimeDatabase, nativeServices, nextId } from '../support/persistence.fixture.ts';

/**
 * [#1410 PRIV-COM-12/17, AC-14] The worker that takes over a measure Privacy handed to Communications, on native PostgreSQL:
 * the exact claimed delivery, the append-only handoff record, the report to Privacy and its failure semantics. Privacy's side is
 * a labelled reporter double that records what it was asked; the Core Tenant scope is the real routine invoker of a real
 * runtime-role transaction.
 */
const subject = {
  _tag: 'SUBJECT_REFERENCE' as const,
  lookupRef: 'lookup-customer-1',
  moduleId: 'fixture.party',
  resourceId: 'customer-1',
  resourceType: 'fixture.recipient',
};
const handoffOf = (tenantId: string, overrides: Partial<typeof PrivacyMeasureHandoffSchema.Encoded> = {}) =>
  Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({
    contentScopeRefs: ['communications.core.history'],
    controllerObligationRef: null,
    dispositionDecision: 'RESTRICT',
    expectedEvidenceRefs: [],
    idempotencyKey: 'FICTIONAL-worker-idempotency-1',
    kind: 'RESTRICT',
    measureId: 'FICTIONAL-worker-measure-1',
    ownerScope: {
      controllerRef: 'FICTIONAL-controller',
      requestedScopePartRefs: [...scopePartRefs],
      requestedScopeRef: 'FICTIONAL-requested-scope',
      trustedLookups: [subject],
    },
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
    ...overrides,
  });
const contextOf = (
  tenantId: string,
  originatorInvocationId: string | null,
  overrides: Partial<OutboxWorkerHandlerContext> = {},
): OutboxWorkerHandlerContext => {
  const fields: OutboxWorkerHandlerContext = {
    attemptNumber: 1,
    claimId: 'claim-1',
    compositionRevision: 'a'.repeat(64),
    consumerModuleKey: 'communications.core',
    deliveryId: 'delivery-1',
    domainEventId: 'event-1',
    legalEntityScope: 'forbidden',
    messageId: 'message-1',
    producerModuleKey: 'privacy.core',
    tenantId,
    tenantSequenceNo: 1n,
    topic: 'privacy.measure.dispatched',
    workerKey: 'communications.core.receive-privacy-measure',
    ...overrides,
  };
  return attestOutboxWorkerHandlerContext(
    originatorInvocationId === null ? fields : { ...fields, originatorInvocationId },
  );
};

const harness = Effect.gen(function* harness() {
  const database = yield* makeRuntimeDatabase();
  const tenantId = yield* nextId;
  const originator = yield* nextId;
  const reports: { readonly attempt: number; readonly handoff: PrivacyMeasureHandoff }[] = [];
  let failure: PrivacyMeasureReportError | null = null;
  const reporter = {
    report: (handoff: PrivacyMeasureHandoff, attempt: number) =>
      Effect.suspend(() => {
        reports.push({ attempt, handoff });
        return failure === null ? Effect.void : Effect.fail(failure);
      }),
    // the take-over worker never reports a later human-recorded confirmation
    reportRecorded: () => Effect.die('The continuation belongs to the continuation worker'),
  };
  const tenantScope = {
    run: <Failure, Requirements>(
      context: OutboxWorkerHandlerContext,
      observe: (scope: OutboxWorkerTenantScopeView) => Effect.Effect<void, Failure, Requirements>,
    ) =>
      database
        .inTenant(context.tenantId, (transaction) =>
          observe({
            completionPublisher: { publish: () => Effect.die('Completion belongs to Core delivery') },
            readOriginalActionInvocation: () => Effect.succeed(Option.none()),
            readWorkloadPrincipalEligibility: () => Effect.die('Not used by this worker'),
            routineInvoker: transaction,
            tenantId: context.tenantId,
          }),
        )
        .pipe(Effect.orDie),
  };
  const handle = (handoff: PrivacyMeasureHandoff, context: OutboxWorkerHandlerContext) =>
    handleReceivePrivacyMeasure({ handoff }, context).pipe(
      Effect.provideService(OutboxWorkerTenantScope, tenantScope),
      Effect.provideService(PrivacyMeasureReporter, reporter),
    );
  const stored = () => database.inTenant(tenantId, (transaction) => transaction.select().from(privacyMeasureHandoffs));
  return {
    context: (overrides: Partial<OutboxWorkerHandlerContext> = {}) => contextOf(tenantId, originator, overrides),
    contextWithout: () => contextOf(tenantId, null),
    fail: (error: PrivacyMeasureReportError) => {
      failure = error;
    },
    handle,
    handoff: (overrides: Partial<typeof PrivacyMeasureHandoffSchema.Encoded> = {}) => handoffOf(tenantId, overrides),
    recover: () => {
      failure = null;
    },
    reports,
    stored,
    tenantId,
  };
});

describe('The Communications worker that takes over a Privacy Measure (AC-14, PRIV-COM-12)', () => {
  it.live('records the handoff once and reports that the owner took it over, again and again for a redelivery', () =>
    Effect.gen(function* takeOver() {
      const world = yield* harness;
      const handoff = world.handoff();
      yield* world.handle(handoff, world.context());
      yield* world.handle(handoff, world.context());
      expect(yield* world.stored()).toHaveLength(1);
      // a redelivery reports the same first attempt, which Privacy answers from its saved outcome by the same key
      expect(world.reports.map(({ attempt }) => attempt)).toEqual([1, 1]);
      expect(world.reports.every((report) => report.handoff.idempotencyKey === handoff.idempotencyKey)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('fails closed on a delivery that is not the exact native claim, recording and reporting nothing', () =>
    Effect.gen(function* inexactContext() {
      const world = yield* harness;
      const handoff = world.handoff();
      const contexts = [
        world.context({ workerKey: 'communications.core.another-worker' }),
        world.context({ producerModuleKey: 'someone.else' }),
        world.context({ topic: 'privacy.measure.other' }),
        world.context({ consumerModuleKey: 'integration.symmy' }),
        world.context({ legalEntityScope: 'required' }),
        world.context({ tenantId: yield* nextId }),
        world.context({ claimId: '' }),
        world.contextWithout(),
        // a caller-built object is never a Core claim, however exact its fields are
        { ...world.context() },
      ];
      for (const context of contexts) {
        const failed = yield* Effect.flip(world.handle(handoff, context));
        expect(failed).toMatchObject({ code: 'privacy_measure_context_invalid', retryable: false });
      }
      expect(yield* world.stored()).toHaveLength(0);
      expect(world.reports).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('leaves a handoff of another owner alone: nothing recorded, nothing reported', () =>
    Effect.gen(function* foreignOwner() {
      const world = yield* harness;
      const foreign = Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({
        ...Schema.encodeSync(PrivacyMeasureHandoffSchema)(world.handoff()),
        owningCapability: 'integration.symmy',
      });
      yield* world.handle(foreign, world.context());
      expect(yield* world.stored()).toHaveLength(0);
      expect(world.reports).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('fails explicitly, and reports nothing, when the same measure identity arrives as another handoff', () =>
    Effect.gen(function* conflicting() {
      const world = yield* harness;
      yield* world.handle(world.handoff(), world.context());
      const changed = world.handoff({ requestedResult: 'restrict something else' });
      const failed = yield* Effect.flip(world.handle(changed, world.context()));
      expect(failed).toMatchObject({ code: 'privacy_measure_handoff_conflict', retryable: false });
      expect(world.reports).toHaveLength(1);
      expect(yield* world.stored()).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('never swallows a failed report: the delivery fails retryably and the handoff stays recorded', () =>
    Effect.gen(function* reporterFailure() {
      const world = yield* harness;
      const handoff = world.handoff();
      world.fail(
        new PrivacyMeasureReportError({
          code: 'privacy_measure_report_unavailable',
          reason: 'The governed Privacy gateway is unavailable',
          retryable: true,
        }),
      );
      const failed = yield* Effect.flip(world.handle(handoff, world.context()));
      expect(failed).toMatchObject({ code: 'privacy_measure_report_unavailable', retryable: true });
      expect(yield* world.stored()).toHaveLength(1);
      // Core retries the same delivery: the owner stays idempotent and now reports successfully
      world.recover();
      yield* world.handle(handoff, world.context());
      expect(yield* world.stored()).toHaveLength(1);
      expect(world.reports).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
