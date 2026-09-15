import { randomUUID } from 'node:crypto';

import { OperationContextUnavailable } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import type { OwnerExecutionOutcome, PrivacyMeasureHandoff } from '@app/privacy/domain/privacy-measure-handoff';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Option } from 'effect';

import { ExecutePrivacyMeasureRejected } from '../../shared/actions/execute-privacy-measure.ts';
import { privacyMeasureExecutions } from '../db/schema.ts';
import type { PartyTransaction } from '../db/types.ts';
import { fingerprintPrivacyMeasureHandoff, parseOwnerResourceRef } from '../privacy-measure-handoff.ts';

const OWNER = 'party.registry';

export interface PrivacyMeasureExecutionReceipt {
  readonly actionInvocationId: string;
  readonly handoffFingerprint: string;
  readonly outcome: OwnerExecutionOutcome;
}

// oxlint-disable-next-line effect-native/require-context-service-for-service-interface -- The scoped Action/Read factory constructs and injects this owner-local transaction service; it has no independent Context lifetime. expires: 2027-03-31.
export interface PrivacyMeasureExecutionService {
  readonly execute: (
    handoff: PrivacyMeasureHandoff,
    actionInvocationId: string,
  ) => Effect.Effect<OwnerExecutionOutcome, ExecutePrivacyMeasureRejected>;
  readonly load: (
    idempotencyKey: string,
  ) => Effect.Effect<Option.Option<PrivacyMeasureExecutionReceipt>, ExecutePrivacyMeasureRejected>;
}

const rejected = (code: ExecutePrivacyMeasureRejected['code'], reason: string, retryable: boolean, cause?: unknown) => {
  const error = new ExecutePrivacyMeasureRejected({ code, reason, retryable });
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  }
  return error;
};

const persistenceUnavailable = (cause: unknown) =>
  rejected(
    'PRIVACY_MEASURE_PERSISTENCE_UNAVAILABLE',
    'Party Registry could not durably execute or reconcile the Privacy Measure',
    true,
    cause,
  );

interface MakeOutcomeInput {
  readonly handoff: PrivacyMeasureHandoff;
  readonly now: Date;
  readonly reason: string;
}

const makeOutcome = ({ handoff, now, reason }: MakeOutcomeInput): OwnerExecutionOutcome => {
  const outcomeId = randomUUID();
  const instant = DateTime.formatIso(DateTime.makeUnsafe(now));
  return {
    attempt: 1,
    evidenceRefs: [`party.registry.privacy-measure-execution:${outcomeId}`],
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

export const privacyMeasureExecutionService = (
  transaction: Pick<PartyTransaction, 'insert' | 'select'>,
  scope: OperationalScope,
): Effect.Effect<PrivacyMeasureExecutionService, OperationContextUnavailable> => {
  if (scope.legalEntityId === undefined) {
    return Effect.fail(
      new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Privacy Measure execution requires a trusted Legal Entity scope',
      }),
    );
  }
  const { legalEntityId } = scope;
  const load: PrivacyMeasureExecutionService['load'] = (idempotencyKey) =>
    transaction
      .select({
        actionInvocationId: privacyMeasureExecutions.actionInvocationId,
        handoffFingerprint: privacyMeasureExecutions.handoffFingerprint,
        outcome: privacyMeasureExecutions.outcome,
      })
      .from(privacyMeasureExecutions)
      .where(
        and(
          eq(privacyMeasureExecutions.tenantId, scope.tenantId),
          eq(privacyMeasureExecutions.legalEntityId, legalEntityId),
          eq(privacyMeasureExecutions.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1)
      .pipe(
        Effect.map((rows) => Option.fromUndefinedOr(rows[0])),
        Effect.mapError(persistenceUnavailable),
      );

  const execute: PrivacyMeasureExecutionService['execute'] = Effect.fn('PartyPrivacyMeasureExecution.execute')(
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
          'The handoff does not belong to the trusted Party Registry Tenant and Legal Entity scope',
          false,
        );
      }

      const now = yield* DateTime.nowAsDate;
      const outcome = makeOutcome({
        handoff,
        now,
        reason:
          'Party Registry has no approved owner semantic contract for this Privacy Measure; canonical owner data was not changed',
      });

      yield* transaction
        .insert(privacyMeasureExecutions)
        .values({
          actionInvocationId,
          actorPrincipalId: scope.principalId,
          handoff,
          handoffFingerprint: fingerprint,
          idempotencyKey: handoff.idempotencyKey,
          legalEntityId,
          measureId: handoff.measureId,
          occurredAt: now,
          outcome,
          outcomeId: outcome.outcomeId,
          owningCapability: OWNER,
          sourceDecisionRef: handoff.sourceDecisionRef,
          sourceDecisionRevision: handoff.sourceDecisionRevision,
          taskId: handoff.taskId,
          tenantId: scope.tenantId,
        })
        .pipe(Effect.mapError(persistenceUnavailable));
      return outcome;
    },
  );
  return Effect.succeed({ execute, load });
};
