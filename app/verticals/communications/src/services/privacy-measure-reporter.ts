import { isVerifiedOutboxWorkerHandlerContext, requireModuleOperation } from '@app/core-runtime';
import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import { executeRecordOwnerExecutionOutcomeWithAuthorization } from '@app/privacy/api/client';
import { RecordOwnerExecutionOutcomeActionAlreadyCommittedProblemSchema } from '@app/privacy/api/record-owner-execution-outcome-action';
import { OwnerExecutionOutcomeSchema } from '@app/privacy/domain/privacy-measure-handoff';
import type { PrivacyMeasureHandoff } from '@app/privacy/domain/privacy-measure-handoff';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import type { GatewayDelegationSubject } from '@app/shared-contracts/gateway-context-server';
import { Context, Crypto, Effect, Option, Schema } from 'effect';
import type { HttpClient } from 'effect/http';

import { sha256Hex } from '../../shared/privacy-owner/measure-handoff.ts';
import { PrivacyMeasureReportError } from './privacy-measure-report-error.ts';

/** The requirement the Communications manifest declares for reporting an owner outcome to Privacy. */
export const REPORT_OWNER_OUTCOME_REQUIREMENT = 'communications.core.requirement.privacy-report-owner-outcome';

export interface PrivacyMeasureReporterService {
  /** Reports that the owner took the measure over for this attempt; Privacy then asks the owner for the receipt itself. */
  readonly report: (
    handoff: PrivacyMeasureHandoff,
    attempt: number,
    context: OutboxWorkerHandlerContext,
  ) => Effect.Effect<void, PrivacyMeasureReportError>;
}

/** The same operation before the worker host binds its transport (Crypto and the HTTP client). */
export interface PrivacyMeasureReporterOperations {
  readonly report: (
    handoff: PrivacyMeasureHandoff,
    attempt: number,
    context: OutboxWorkerHandlerContext,
  ) => Effect.Effect<void, PrivacyMeasureReportError, Crypto.Crypto | HttpClient.HttpClient>;
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
  code: Schema.optionalKey(Schema.Literal('action_already_committed')),
  resolution: Schema.optionalKey(Schema.Literal('RESOLVE_COMMIT')),
});
const decodeGatewayFailure = Schema.decodeUnknownOption(gatewayFailureSchema);
const gatewayFailure = (cause: unknown) => {
  const parsed = decodeGatewayFailure(cause);
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

/**
 * The reporting transport: the finite human Privacy dispatch capability of the genuine claimed delivery, the way the other
 * consumers of the dispatch report. It sends only the measure identity and the attempt; the outcome itself is what Privacy
 * reads from this owner's own receipt.
 */
export const privacyMeasureReporterService = (): Effect.Effect<PrivacyMeasureReporterOperations> =>
  Effect.succeed({
    report: Effect.fn('CommunicationsPrivacyReporter.report')(function* report(handoff, attempt, context) {
      if (!isVerifiedOutboxWorkerHandlerContext(context) || context.originatorInvocationId === undefined) {
        return yield* new PrivacyMeasureReportError({
          code: 'privacy_measure_context_invalid',
          reason: 'A native claimed delivery and its original Privacy dispatch invocation are required',
          retryable: false,
        });
      }
      // The Composition must provide the operation that reports to Privacy: a deployment without it retries, never drops.
      yield* requireModuleOperation(REPORT_OWNER_OUTCOME_REQUIREMENT).pipe(Effect.mapError(requirementUnavailable));
      const source: PrivacyDispatchSubject['source'] = { _tag: 'Worker', context };
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
                operationRequirementKey: REPORT_OWNER_OUTCOME_REQUIREMENT,
                source,
              },
            },
            crypto,
          ).pipe(Effect.mapError(gatewayFailure)),
          sha256Hex(handoff.idempotencyKey).pipe(Effect.mapError(gatewayFailure)),
        ],
        { concurrency: 2 },
      );
      return yield* executeRecordOwnerExecutionOutcomeWithAuthorization(
        { request: { attempt, measureId: handoff.measureId, taskId: handoff.taskId } },
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
    }),
  });
