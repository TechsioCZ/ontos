import { Cause, Effect, Option } from 'effect';
import type { CommerceEnrollmentContinuationResult } from '../../../src/enrollment/continuation/enrollment-continuation.ts';

/**
 * Keep the bounded owner pass inside the HTTP request and its database/service scope. Workers
 * dispose request services after the response body, so neither a detached fiber nor waitUntil
 * alone can own this work. A later explicit resume uses the durable journal and existing leases.
 * An owner halt does not undo the provider account or Attempt this request already committed.
 */
export const advanceEnrollmentWithinRequest = <Failure>(
  advance: Effect.Effect<Option.Option<CommerceEnrollmentContinuationResult>, Failure>,
  portalEnrollmentAttemptId: string,
): Effect.Effect<void> =>
  advance.pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        Effect.annotateLogs(Effect.logWarning('The Commerce enrollment continuation did not advance this Attempt'), {
          cause: Cause.pretty(cause),
          portalEnrollmentAttemptId,
        }),
      onSuccess: (result) =>
        Option.isNone(result) || result.value.outcome === 'COMPLETE'
          ? Effect.void
          : Effect.annotateLogs(Effect.logInfo('The Commerce enrollment journey halted before completion'), {
              portalEnrollmentAttemptId,
              reason: result.value.halt.reason,
            }),
    }),
  );
