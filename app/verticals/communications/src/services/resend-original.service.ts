import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { and, eq, sql } from 'drizzle-orm';
import { DateTime, Effect, Option } from 'effect';

import { CommunicationDecisionUnavailable } from '../../shared/communication-intake-errors.ts';
import {
  communicationRequests,
  messageIntents,
  deliveryAttempts,
  providerObservations,
  providerObservationConflicts,
  providerObservationConflictResolutions,
  intentRecoveryEvaluations,
  intentHandoffStops,
} from '../database/schema.ts';
import { awaitsFirstOutcome } from '../domain/history/awaits-outcome.ts';
import { effectBlockOf } from '../domain/history/unknown-effect.ts';
import { safeCauseOf } from '../domain/intake/safe-cause.ts';
import type { ResendOriginalPortContract } from '../domain/recovery/resend-admission.ts';
import { verifiedCallerModuleOf } from '../integrations/source-caller.ts';

const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new CommunicationDecisionUnavailable({
      code: 'communication_decision_unavailable',
      reason: 'The original Message Intent of a resend could not be read',
    }),
    'cause',
    // REPLACED by its safe kind: a failed statement carries its bound parameters
    { enumerable: false, value: cause === undefined ? undefined : safeCauseOf(cause) },
  );

/**
 * The original intent of an Explicit Resend, read inside the Action's own scoped Core transaction (#1403). Row-level security
 * confines the read to the installed Tenant, so an intent of another Tenant is simply not found. It carries the source owner of
 * the original's request, its type and what its append-only history says about the external effect: never a recipient address.
 */
export const postgresResendOriginalPort = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
): ResendOriginalPortContract => ({
  findOriginal: Effect.fn('CommunicationIntake.findResendOriginal')(function* find(originalIntentId, admission) {
    const caller = verifiedCallerModuleOf(scope);
    if (Option.isNone(caller) || caller.value !== admission.sourceModule) {
      return Option.none();
    }
    const { tenantId } = scope;
    const [original] = yield* transaction
      .select({
        scopeKey: communicationRequests.scopeKey,
        sourceModule: communicationRequests.sourceModule,
        status: messageIntents.status,
        typeId: messageIntents.typeId,
      })
      .from(messageIntents)
      .innerJoin(
        communicationRequests,
        and(
          eq(communicationRequests.tenantId, messageIntents.tenantId),
          eq(communicationRequests.requestId, messageIntents.requestId),
        ),
      )
      .where(
        and(
          eq(messageIntents.tenantId, tenantId),
          eq(messageIntents.intentId, originalIntentId),
          eq(communicationRequests.sourceModule, caller.value),
          eq(communicationRequests.scopeKey, admission.scopeKey),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    if (original === undefined) {
      return Option.none();
    }
    const identity = { scopeKey: original.scopeKey, sourceModule: original.sourceModule, typeId: original.typeId };
    // Type mismatch is decided before any history is read; its effect facts cannot admit a resend.
    if (original.typeId !== admission.typeId) {
      return Option.some({ ...identity, effectBlock: Option.none(), pendingWithoutOutcome: false });
    }
    // Admission needs only this intent's effect evidence, never request payloads, recipients, pins or siblings.
    const { attempts, conflicts, observations, recoveries, resolutions, stops } = yield* Effect.all(
      {
        attempts: transaction
          .select({
            attemptId: deliveryAttempts.attemptId,
            reason: sql<string | null>`${deliveryAttempts.evidence}->>'reason'`,
            state: deliveryAttempts.state,
          })
          .from(deliveryAttempts)
          .where(and(eq(deliveryAttempts.tenantId, tenantId), eq(deliveryAttempts.intentId, originalIntentId))),
        conflicts: transaction
          .select({ conflictId: providerObservationConflicts.conflictId })
          .from(providerObservationConflicts)
          .where(
            and(
              eq(providerObservationConflicts.tenantId, tenantId),
              eq(providerObservationConflicts.intentId, originalIntentId),
            ),
          ),
        observations: transaction
          .select({
            attemptId: providerObservations.attemptId,
            kind: providerObservations.kind,
            recordedAt: providerObservations.recordedAt,
          })
          .from(providerObservations)
          .where(and(eq(providerObservations.tenantId, tenantId), eq(providerObservations.intentId, originalIntentId))),
        recoveries: transaction
          .select({ outcome: intentRecoveryEvaluations.outcome, proven: intentRecoveryEvaluations.proven })
          .from(intentRecoveryEvaluations)
          .where(
            and(
              eq(intentRecoveryEvaluations.tenantId, tenantId),
              eq(intentRecoveryEvaluations.intentId, originalIntentId),
            ),
          ),
        resolutions: transaction
          .select({
            conflictId: providerObservationConflictResolutions.conflictId,
            resolvedAt: providerObservationConflictResolutions.resolvedAt,
          })
          .from(providerObservationConflictResolutions)
          .where(
            and(
              eq(providerObservationConflictResolutions.tenantId, tenantId),
              eq(providerObservationConflictResolutions.intentId, originalIntentId),
            ),
          ),
        stops: transaction
          .select({ proven: intentHandoffStops.proven })
          .from(intentHandoffStops)
          .where(and(eq(intentHandoffStops.tenantId, tenantId), eq(intentHandoffStops.intentId, originalIntentId))),
      },
      { concurrency: 1 },
    ).pipe(Effect.mapError(unavailable));
    const facts = {
      attempts: attempts.map((attempt) => ({ ...attempt, reason: attempt.reason ?? undefined })),
      conflicts: conflicts.map(({ conflictId }) => {
        const resolution = resolutions.find((row) => row.conflictId === conflictId);
        return { resolvedAt: resolution === undefined ? undefined : DateTime.fromDateUnsafe(resolution.resolvedAt) };
      }),
      intent: { status: original.status },
      observations: observations.map((observation) => ({
        ...observation,
        recordedAt: DateTime.fromDateUnsafe(observation.recordedAt),
      })),
      recoveries,
      stops,
    };
    return Option.some({
      ...identity,
      effectBlock: effectBlockOf(facts),
      pendingWithoutOutcome: awaitsFirstOutcome(facts),
    });
  }),
});
