// fallow-ignore-file code-duplication -- Owner-local protocol code intentionally mirrors its peer owner while preserving separate deployment and persistence authority.
/* jscpd:ignore-start -- Owner-local protocol code intentionally mirrors its peer owner while preserving separate deployment and persistence authority. */
import { OperationContextUnavailable, defineScopedRoutine } from '@app/core-runtime';
import type { OperationalScope, ScopedRoutineInvocationError } from '@app/core-runtime';
import { OwnerExecutionOutcomeSchema } from '@app/privacy/domain/privacy-measure-handoff';
import type { OwnerExecutionOutcome, PrivacyMeasureHandoff } from '@app/privacy/domain/privacy-measure-handoff';
import { Context, Crypto, DateTime, Effect, Option, Schema } from 'effect';

import { ExecutePrivacyMeasureRejected } from '../../shared/actions/execute-privacy-measure.ts';
import type { ProfileScopedRoutineInvoker } from '../persistence/profile-persistence.ts';
import { fingerprintPrivacyMeasureHandoff, parseOwnerResourceRef } from '../privacy-measure-handoff.ts';

const OWNER = 'commerce.customer-context';
const scopeParameters = [
  { source: 'tenantId', type: 'uuid' },
  { source: 'legalEntityId', type: 'uuid' },
] as const;

const ReceiptRowSchema = Schema.Struct({
  action_invocation_id: Schema.String,
  handoff_fingerprint: Schema.String,
  outcome: OwnerExecutionOutcomeSchema,
});

const loadReceiptRoutine = defineScopedRoutine({
  name: 'read_privacy_measure_execution',
  ownerModuleKey: OWNER,
  parameters: [...scopeParameters, { source: 'input', type: 'text' }],
  resultSchema: ReceiptRowSchema,
  routineKey: 'privacy-measure.read-execution',
  schema: 'commerce_customer_context',
});
const recordReceiptRoutine = defineScopedRoutine({
  name: 'record_privacy_measure_execution',
  ownerModuleKey: OWNER,
  parameters: [
    ...scopeParameters,
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'jsonb' },
    { source: 'input', type: 'jsonb' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'timestamptz' },
  ],
  resultSchema: ReceiptRowSchema,
  routineKey: 'privacy-measure.record-execution',
  schema: 'commerce_customer_context',
});

export interface PrivacyMeasureExecutionReceipt {
  readonly actionInvocationId: string;
  readonly handoffFingerprint: string;
  readonly outcome: OwnerExecutionOutcome;
}
export interface PrivacyMeasureExecutionService {
  readonly execute: (
    handoff: PrivacyMeasureHandoff,
    actionInvocationId: string,
  ) => Effect.Effect<OwnerExecutionOutcome, ExecutePrivacyMeasureRejected>;
  readonly load: (
    idempotencyKey: string,
  ) => Effect.Effect<Option.Option<PrivacyMeasureExecutionReceipt>, ExecutePrivacyMeasureRejected>;
}

/** Owner-local service contract; scope is supplied by its transaction factory. */
export class PrivacyMeasureExecution extends Context.Service<PrivacyMeasureExecution, PrivacyMeasureExecutionService>()(
  '@app/commerce-customer-context/services/privacy-measure-execution.service/PrivacyMeasureExecution',
) {}

const rejected = (code: ExecutePrivacyMeasureRejected['code'], reason: string, retryable: boolean, cause?: unknown) => {
  const error = new ExecutePrivacyMeasureRejected({ code, reason, retryable });
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  }
  return error;
};
const unavailable = (cause: ScopedRoutineInvocationError) =>
  rejected(
    'PRIVACY_MEASURE_PERSISTENCE_UNAVAILABLE',
    'Commerce Customer Context could not durably execute or reconcile the Privacy Measure',
    true,
    cause,
  );
interface MakeOutcomeInput {
  readonly handoff: PrivacyMeasureHandoff;
  readonly now: Date;
  readonly outcomeId: string;
  readonly reason: string;
}

const makeOutcome = ({ handoff, now, outcomeId, reason }: MakeOutcomeInput): OwnerExecutionOutcome => {
  const instant = DateTime.formatIso(DateTime.makeUnsafe(now));
  return {
    attempt: 1,
    evidenceRefs: [`commerce.customer-context.privacy-measure-execution:${outcomeId}`],
    idempotencyKey: handoff.idempotencyKey,
    includedResourceRefs: [],
    measureId: handoff.measureId,
    occurredAt: instant,
    outcomeId,
    owningCapability: OWNER,
    reason,
    recordedAt: instant,
    remainingResourceRefs: [...handoff.resourceRefs],
    sourceDecisionRef: handoff.sourceDecisionRef,
    sourceDecisionRevision: handoff.sourceDecisionRevision,
    status: 'BUSINESS_REJECTED',
    taskId: handoff.taskId,
  };
};

export const privacyMeasureExecutionService = Effect.fn('CommercePrivacyMeasureExecution.make')(
  function* makePrivacyMeasureExecution(
    transaction: ProfileScopedRoutineInvoker,
    scope: OperationalScope,
  ): Effect.fn.Return<PrivacyMeasureExecutionService, OperationContextUnavailable, Crypto.Crypto> {
    if (scope.legalEntityId === undefined) {
      return yield* new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Privacy Measure execution requires a trusted Legal Entity scope',
      });
    }
    const { legalEntityId } = scope;
    const crypto = yield* Crypto.Crypto;
    const load: PrivacyMeasureExecutionService['load'] = (idempotencyKey) =>
      transaction.invoke(loadReceiptRoutine, [idempotencyKey]).pipe(
        Effect.mapError(unavailable),
        Effect.map(([row]) =>
          Option.fromUndefinedOr(
            row === undefined
              ? undefined
              : {
                  actionInvocationId: row.action_invocation_id,
                  handoffFingerprint: row.handoff_fingerprint,
                  outcome: row.outcome,
                },
          ),
        ),
      );

    const execute: PrivacyMeasureExecutionService['execute'] = Effect.fn('CommercePrivacyMeasureExecution.execute')(
      // fallow-ignore-next-line complexity -- Owner execution must reconcile durable replay, exact scope, fail-closed outcome, and receipt persistence atomically.
      function* executePrivacyMeasure(handoff, actionInvocationId) {
        const fingerprint = fingerprintPrivacyMeasureHandoff(handoff);
        const prior = yield* load(handoff.idempotencyKey);
        if (Option.isSome(prior)) {
          if (prior.value.handoffFingerprint !== fingerprint) {
            return yield* rejected(
              'PRIVACY_MEASURE_IDEMPOTENCY_CONFLICT',
              'The idempotency identity is already bound to a different Privacy Measure handoff',
              false,
            );
          }
          return prior.value.outcome;
        }
        const refs = handoff.resourceRefs.map(parseOwnerResourceRef);
        if (
          handoff.tenantId !== scope.tenantId ||
          handoff.owningCapability !== OWNER ||
          refs.some((ref) => ref === undefined || ref.legalEntityId !== legalEntityId || ref.moduleId !== OWNER)
        ) {
          return yield* rejected(
            'PRIVACY_MEASURE_SCOPE_MISMATCH',
            'The handoff does not belong to the trusted Commerce Customer Context scope',
            false,
          );
        }
        const now = yield* DateTime.nowAsDate;
        const outcomeId = yield* crypto
          .randomUUIDv4()
          .pipe(
            Effect.mapError((cause) =>
              rejected(
                'PRIVACY_MEASURE_PERSISTENCE_UNAVAILABLE',
                'Commerce Customer Context could not allocate a Privacy Measure outcome identity',
                true,
                cause,
              ),
            ),
          );
        const outcome = makeOutcome({
          handoff,
          now,
          outcomeId,
          reason:
            'Commerce Customer Context has no approved owner semantic contract for this Privacy Measure; canonical owner data was not changed',
        });
        const [receipt] = yield* transaction
          .invoke(recordReceiptRoutine, [
            outcome.outcomeId,
            handoff.measureId,
            handoff.taskId,
            OWNER,
            handoff.idempotencyKey,
            handoff.sourceDecisionRef,
            handoff.sourceDecisionRevision,
            fingerprint,
            handoff,
            outcome,
            actionInvocationId,
            scope.principalId,
            now,
          ])
          .pipe(Effect.mapError(unavailable));
        if (receipt === undefined || receipt.handoff_fingerprint !== fingerprint) {
          return yield* rejected(
            'PRIVACY_MEASURE_PERSISTENCE_UNAVAILABLE',
            'Commerce Customer Context did not return the authoritative immutable execution receipt',
            true,
          );
        }
        return receipt.outcome;
      },
    );
    return PrivacyMeasureExecution.of({ execute, load });
  },
);
/* jscpd:ignore-end */
