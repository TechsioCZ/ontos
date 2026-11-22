import { isVerifiedOutboxWorkerHandlerContext, requireModuleOperation } from '@app/core-runtime';
import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import { executeRecordOwnerExecutionOutcomeWithAuthorization } from '@app/privacy/api/client';
import { RecordOwnerExecutionOutcomeActionAlreadyCommittedProblemSchema } from '@app/privacy/api/record-owner-execution-outcome-action';
import { OwnerExecutionOutcomeSchema } from '@app/privacy/domain/privacy-measure-handoff';
import type { PrivacyMeasureHandoff } from '@app/privacy/domain/privacy-measure-handoff';
import type { PrivacyDispatchContinuationPayload } from '@app/shared-contracts';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import type { GatewayDelegationSubject } from '@app/shared-contracts/gateway-context-server';
import { Context, Crypto, Effect, Option, Schema } from 'effect';
import type { HttpClient } from 'effect/http';

import { sha256Hex } from '../../shared/privacy-owner/measure-handoff.ts';
import { PrivacyMeasureReportError } from './privacy-measure-report-error.ts';

/** The requirement the Communications manifest declares for reporting an owner outcome to Privacy. */
export const REPORT_OWNER_OUTCOME_REQUIREMENT = 'communications.core.requirement.privacy-report-owner-outcome';
/** The requirement the Communications manifest declares for the continuation worker's later outcome report. */
export const REPORT_RECORDED_OWNER_OUTCOME_REQUIREMENT =
  'communications.core.requirement.privacy-report-recorded-owner-outcome';

export interface PrivacyMeasureReporterService {
  /** Reports that the owner took the measure over for this attempt; Privacy then asks the owner for the receipt itself. */
  readonly report: (
    handoff: PrivacyMeasureHandoff,
    attempt: number,
    context: OutboxWorkerHandlerContext,
  ) => Effect.Effect<void, PrivacyMeasureReportError>;
  /**
   * Reports, from the owner's own claimed continuation delivery, that a human recorded evidence later: Privacy is asked to
   * read the named receipt attempt of the original dispatch, and the report itself carries no outcome.
   */
  readonly reportRecorded: (
    continuation: PrivacyDispatchContinuationPayload,
    context: OutboxWorkerHandlerContext,
  ) => Effect.Effect<void, PrivacyMeasureReportError>;
}

type ReporterTransport = Crypto.Crypto | HttpClient.HttpClient;

/** The same operations before the worker host binds their transport (Crypto and the HTTP client). */
export interface PrivacyMeasureReporterOperations {
  readonly report: (
    handoff: PrivacyMeasureHandoff,
    attempt: number,
    context: OutboxWorkerHandlerContext,
  ) => Effect.Effect<void, PrivacyMeasureReportError, ReporterTransport>;
  readonly reportRecorded: (
    continuation: PrivacyDispatchContinuationPayload,
    context: OutboxWorkerHandlerContext,
  ) => Effect.Effect<void, PrivacyMeasureReportError, ReporterTransport>;
}

export class PrivacyMeasureReporter extends Context.Service<PrivacyMeasureReporter, PrivacyMeasureReporterService>()(
  '@app/communications/services/privacy-measure-reporter/PrivacyMeasureReporter',
) {}

const requirementUnavailable = (cause: unknown) =>
  Object.defineProperty(
    new PrivacyMeasureReportError({
      code: 'privacy_measure_report_unavailable',
      reason: 'Privacy outcome reporting is unavailable in the current Composition',
      retryable: true,
    }),
    'cause',
    { value: cause },
  );

// Keep only recognized public failure metadata: transport and configuration causes can carry assertions or the handoff.
const gatewayFailureSchema = Schema.Struct({
  code: Schema.optionalKey(Schema.Literals(['action_already_committed', 'privacy_operation_conflict'])),
  resolution: Schema.optionalKey(Schema.Literal('RESOLVE_COMMIT')),
});
const decodeGatewayFailure = Schema.decodeUnknownOption(gatewayFailureSchema);

/**
 * The report failure of one gateway or Privacy answer. Privacy answers `privacy_operation_conflict` when its state for this
 * measure and attempt contradicts the report (it already holds ANOTHER receipt for the attempt; the same receipt is an
 * idempotent success there): repeating the same report cannot change that, so it is a non-retryable, honest failure that an
 * operator reconciles, never a retry storm. Everything else is an unavailable gateway, retried.
 */
export const gatewayFailure = (cause: unknown) => {
  const parsed = decodeGatewayFailure(cause);
  if (Option.isSome(parsed) && parsed.value.code === 'privacy_operation_conflict') {
    return Object.defineProperty(
      new PrivacyMeasureReportError({
        code: 'privacy_measure_report_conflict',
        reason: 'Privacy holds another receipt or state for this measure attempt; the same report cannot change it',
        retryable: false,
      }),
      'cause',
      { value: parsed.value },
    );
  }
  const indeterminate = Option.isSome(parsed) && parsed.value.resolution === 'RESOLVE_COMMIT';
  return Object.defineProperty(
    new PrivacyMeasureReportError({
      code: 'privacy_measure_report_unavailable',
      reason: indeterminate
        ? 'The Privacy outcome commit requires durable receipt reconciliation'
        : 'The governed Privacy gateway is unavailable',
      retryable: true,
    }),
    'cause',
    { value: Option.getOrElse(parsed, () => ({})) },
  );
};

/** Core checked the same scoped identity and input before it emits this exact reply: a replay normally gets the saved outcome. */
const alreadyRecorded = Schema.is(RecordOwnerExecutionOutcomeActionAlreadyCommittedProblemSchema);

type PrivacyDispatchSubject = Extract<GatewayDelegationSubject, { readonly _tag: 'PrivacyDispatch' }>;

interface OutcomeReport {
  readonly attempt: number;
  readonly context: OutboxWorkerHandlerContext;
  /** Stable for one report, so a redelivery replays the same Privacy commit. */
  readonly idempotencySeed: string;
  readonly measureId: string;
  readonly requirementKey: string;
  readonly source: PrivacyDispatchSubject['source'];
  readonly taskId: string;
}

/** One owner-outcome report over the finite Privacy dispatch capability: only the measure identity and the attempt. */
const sendOutcomeReport = Effect.fn('CommunicationsPrivacyReporter.send')(function* send(report: OutcomeReport) {
  const { attempt, context } = report;
  // The Composition must provide the operation that reports to Privacy: a deployment without it retries, never drops.
  yield* requireModuleOperation(report.requirementKey).pipe(Effect.mapError(requirementUnavailable));
  const crypto = yield* Crypto.Crypto;
  const [issued, digest] = yield* Effect.all(
    [
      acquireDelegatedGatewayContext(
        {
          audience: 'privacy',
          legalEntityScope: 'subject',
          requestCorrelation: context.correlationId ?? context.messageId,
          subject: {
            _tag: 'PrivacyDispatch',
            operation: { _tag: 'PrivacyOutcome', attempt },
            operationRequirementKey: report.requirementKey,
            source: report.source,
          },
        },
        crypto,
      ).pipe(Effect.mapError(gatewayFailure)),
      sha256Hex(report.idempotencySeed).pipe(Effect.mapError(gatewayFailure)),
    ],
    { concurrency: 2 },
  );
  return yield* executeRecordOwnerExecutionOutcomeWithAuthorization(
    { request: { attempt, measureId: report.measureId, taskId: report.taskId } },
    issued.authorization,
    context.correlationId ?? context.messageId,
    {
      baseUrl: issued.apiBaseUrl,
      compositionRevision: issued.compositionRevision,
      idempotencyKey: `privacy-owner-outcome:${digest}:${String(attempt)}`,
    },
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.toType(OwnerExecutionOutcomeSchema))),
    Effect.asVoid,
    Effect.catchIf(alreadyRecorded, () => Effect.void),
    Effect.mapError(gatewayFailure),
  );
});

const contextInvalid = (reason: string) =>
  new PrivacyMeasureReportError({ code: 'privacy_measure_context_invalid', reason, retryable: false });

/**
 * The reporting transport: the finite human Privacy dispatch capability of the genuine claimed delivery, the way the other
 * consumers of the dispatch report. It sends only the measure identity and the attempt; the outcome itself is what Privacy
 * reads from this owner's own receipt. A later human-recorded confirmation reports through the owner's own continuation
 * delivery instead, which Shell joins to the original dispatch from native evidence.
 */
export const privacyMeasureReporterService = (): Effect.Effect<PrivacyMeasureReporterOperations> =>
  Effect.succeed({
    report: Effect.fn('CommunicationsPrivacyReporter.report')(function* report(handoff, attempt, context) {
      if (!isVerifiedOutboxWorkerHandlerContext(context) || context.originatorInvocationId === undefined) {
        return yield* contextInvalid(
          'A native claimed delivery and its original Privacy dispatch invocation are required',
        );
      }
      return yield* sendOutcomeReport({
        attempt,
        context,
        idempotencySeed: handoff.idempotencyKey,
        measureId: handoff.measureId,
        requirementKey: REPORT_OWNER_OUTCOME_REQUIREMENT,
        source: { _tag: 'Worker', context },
        taskId: handoff.taskId,
      });
    }),
    reportRecorded: Effect.fn('CommunicationsPrivacyReporter.reportRecorded')(
      function* reportRecorded(continuation, context) {
        if (!isVerifiedOutboxWorkerHandlerContext(context)) {
          return yield* contextInvalid('A native claimed continuation delivery is required');
        }
        return yield* sendOutcomeReport({
          attempt: continuation.attempt,
          context,
          idempotencySeed: `${continuation.dispatchInvocationId}:${continuation.measureId}:${continuation.taskId}`,
          measureId: continuation.measureId,
          requirementKey: REPORT_RECORDED_OWNER_OUTCOME_REQUIREMENT,
          source: { _tag: 'Continuation', context },
          taskId: continuation.taskId,
        });
      },
    ),
  });
