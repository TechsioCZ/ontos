import { DateTime, Effect } from 'effect';

import type { CommercePortalAuthAuditEventType, CommercePortalAuthAuditOutcome } from './audit-contracts.ts';
import type { CommercePortalAuthAuditRecorder } from './audit.ts';

/**
 * What every portal row of one admitted storefront write carries. Its authorization committed in Core's audit under
 * `actionInvocationId`; the portal rows of the routine that authorization admitted carry the same id, so the two are
 * read together. Never a password, a hash of one, a token or a provider message: the shape has no field for them.
 */
export interface OwnPortalAuditSubject {
  readonly actionInvocationId: string;
  readonly operation: string;
  readonly providerSubjectId: string;
  readonly sessionRef: string;
}

/** One portal row of an admitted write, at the current instant. */
export const recordOwnPortalRow = (
  recorder: CommercePortalAuthAuditRecorder,
  subject: OwnPortalAuditSubject,
  row: {
    readonly correlationDigest?: string;
    readonly eventType: CommercePortalAuthAuditEventType;
    readonly outcome: CommercePortalAuthAuditOutcome;
  },
) => DateTime.nowAsDate.pipe(Effect.flatMap((occurredAt) => recorder.record({ ...subject, ...row, occurredAt })));

/**
 * The final row of a change that was applied, written as well as the audit store allows. What is guaranteed is the
 * `requested` row, not this one: the caller records that row before the first native command and refuses the change
 * if it cannot be written, so no change is ever applied without a row saying it was asked for.
 *
 * This row is best effort, because the change has already happened and must not become a refusal. Three outcomes:
 * the success row is written; or that write fails and an `outcome_unknown` row is written in its place, after one
 * logged warning; or the store is unavailable for both, and then the applied change keeps only its `requested` row
 * and that one warning. In every case the buyer gets the change, never a 503 for a change that was applied.
 */
export const recordAppliedOutcome = (
  recorder: CommercePortalAuthAuditRecorder,
  subject: OwnPortalAuditSubject,
  events: { readonly success: CommercePortalAuthAuditEventType; readonly unknown: CommercePortalAuthAuditEventType },
) =>
  recordOwnPortalRow(recorder, subject, { eventType: events.success, outcome: 'success' }).pipe(
    Effect.matchEffect({
      onFailure: (failure) =>
        Effect.logWarning('Applied portal change without its success row; recording outcome_unknown').pipe(
          Effect.annotateLogs({ failure: failure._tag, operation: subject.operation }),
          Effect.andThen(
            recordOwnPortalRow(recorder, subject, { eventType: events.unknown, outcome: 'outcome_unknown' }),
          ),
          Effect.ignore,
        ),
      onSuccess: () => Effect.void,
    }),
  );

/** The class of a refused routine: a conflict the owner reported (409) is `state_conflict`, anything else `unavailable`. */
export const refusalOutcomeOf = (failure: {
  readonly status: number;
}): Extract<CommercePortalAuthAuditOutcome, 'state_conflict' | 'unavailable'> =>
  failure.status === 409 ? 'state_conflict' : 'unavailable';
