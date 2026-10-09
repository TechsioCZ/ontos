import { Effect, Schema } from 'effect';

import {
  EnrollmentEvidenceReferenceSchema,
  EnrollmentKeySchema,
  EnrollmentResourceIdSchema,
} from '../../shared/enrollment-contracts.ts';
import type { EnrollmentPrincipalIdSchema } from '../../shared/enrollment-contracts.ts';
import {
  CommerceEnrollmentOwnerEffectIndeterminate,
  CommerceEnrollmentOwnerEffectRejected,
} from '../../src/enrollment/orchestration/owner-transition-errors.ts';
import type { CommerceEnrollmentOwnerEffectError } from '../../src/enrollment/orchestration/owner-transition-errors.ts';
import type {
  CommerceEnrollmentOwnerEffect,
  CommerceEnrollmentOwnerEffectOutcome,
  CommerceEnrollmentOwnerTransition,
} from '../../src/enrollment/orchestration/owner-transition-driver.ts';

/**
 * The scripted far side of the owner-transition dispatch seam: owner answers are data, every
 * durable consequence is produced by the real driver, Attempt service and PostgreSQL.
 */

/** What the scripted owner answers when the driver dispatches one transition. */
export type EnrollmentAcceptanceOwnerAnswer =
  /** The owner committed and named its exact result. */
  | { readonly kind: 'SUCCEEDED'; readonly outcomeCode: string; readonly resultReference?: string }
  /**
   * The owner committed nothing and says so: a recorded, durable owner failure. Whether that is a
   * journey rejection or a reconciliation halt is decided by the outcome code, never here.
   */
  | { readonly failureCode: string; readonly kind: 'FAILED'; readonly outcomeCode: string }
  /** The owner refused the request outright with its own rejection code. */
  | { readonly code: string; readonly kind: 'REJECTED'; readonly reason: string }
  /** The owner never answered: it may or may not have committed. */
  | { readonly kind: 'TIMED_OUT' };

/** What the owner's authoritative read of the original invocation later finds. */
export interface EnrollmentAcceptanceOwnerResolution {
  readonly outcomeCode: string;
  readonly reconciliationRef: string;
  readonly resultReference?: string;
  readonly status: 'FAILED' | 'SUCCEEDED';
}

interface EnrollmentAcceptanceOwnerScript {
  readonly actorPrincipalId: typeof EnrollmentPrincipalIdSchema.Type;
  /** Answer for one dispatch, by transition key. */
  readonly answers: Readonly<Record<string, EnrollmentAcceptanceOwnerAnswer>>;
  /** Authoritative resolution for one reconciliation, by transition key. */
  readonly resolutions?: Readonly<Record<string, EnrollmentAcceptanceOwnerResolution>>;
}

interface EnrollmentAcceptanceOwnerLog {
  readonly dispatched: readonly string[];
  readonly reconciled: readonly string[];
}

export interface EnrollmentAcceptanceScriptedOwner {
  readonly effect: CommerceEnrollmentOwnerEffect;
  /** Transition keys dispatched so far, in order; a replay must not add an entry. */
  readonly log: EnrollmentAcceptanceOwnerLog;
}

const key = (value: string) => Schema.decodeSync(EnrollmentKeySchema)(value);
const resource = (value: string) => Schema.decodeSync(EnrollmentResourceIdSchema)(value);
const evidence = (value: string) => Schema.decodeSync(EnrollmentEvidenceReferenceSchema)(value);

const missingAnswer = (transition: CommerceEnrollmentOwnerTransition) =>
  new CommerceEnrollmentOwnerEffectRejected({
    code: 'owner_answer_unscripted',
    reason: `The acceptance script has no answer for ${transition.transitionKey}`,
  });

export const enrollmentAcceptanceScriptedOwner = (
  script: EnrollmentAcceptanceOwnerScript,
): EnrollmentAcceptanceScriptedOwner => {
  const dispatched: string[] = [];
  const reconciled: string[] = [];

  const dispatch: CommerceEnrollmentOwnerEffect['dispatch'] = (transition) =>
    Effect.suspend((): Effect.Effect<CommerceEnrollmentOwnerEffectOutcome, CommerceEnrollmentOwnerEffectError> => {
      dispatched.push(transition.transitionKey);
      const answer = script.answers[transition.transitionKey];
      if (answer === undefined) {
        return Effect.fail(missingAnswer(transition));
      }
      if (answer.kind === 'TIMED_OUT') {
        return Effect.fail(
          new CommerceEnrollmentOwnerEffectIndeterminate({
            code: 'owner_timeout',
            reason: 'The owner did not answer before the request deadline',
          }),
        );
      }
      if (answer.kind === 'REJECTED') {
        return Effect.fail(new CommerceEnrollmentOwnerEffectRejected({ code: answer.code, reason: answer.reason }));
      }
      if (answer.kind === 'FAILED') {
        return Effect.succeed({
          failureCode: key(answer.failureCode),
          failureReason: 'The owner recorded a durable failure for this transition',
          outcomeCode: key(answer.outcomeCode),
          status: 'FAILED' as const,
        });
      }
      return Effect.succeed(
        answer.resultReference === undefined
          ? { outcomeCode: key(answer.outcomeCode), status: 'SUCCEEDED' as const }
          : {
              outcomeCode: key(answer.outcomeCode),
              resultReference: resource(answer.resultReference),
              status: 'SUCCEEDED' as const,
            },
      );
    });

  const reconcile: CommerceEnrollmentOwnerEffect['reconcile'] = (input) =>
    Effect.suspend(() => {
      reconciled.push(input.transitionKey);
      const resolution = script.resolutions?.[input.transitionKey];
      if (resolution === undefined) {
        return Effect.fail(
          new CommerceEnrollmentOwnerEffectRejected({
            code: 'owner_resolution_unscripted',
            reason: `The acceptance script has no authoritative resolution for ${input.transitionKey}`,
          }),
        );
      }
      const base = {
        actorPrincipalId: script.actorPrincipalId,
        outcomeCode: key(resolution.outcomeCode),
        reconciliationRef: evidence(resolution.reconciliationRef),
        status: resolution.status,
      };
      return Effect.succeed(
        resolution.resultReference === undefined
          ? base
          : { ...base, resultReference: resource(resolution.resultReference) },
      );
    });

  return { effect: { dispatch, reconcile }, log: { dispatched, reconciled } };
};
