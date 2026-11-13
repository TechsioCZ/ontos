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

/** The class of a refused routine: a conflict the owner reported (409) is `state_conflict`, anything else `unavailable`. */
export const refusalOutcomeOf = (failure: {
  readonly status: number;
}): Extract<CommercePortalAuthAuditOutcome, 'state_conflict' | 'unavailable'> =>
  failure.status === 409 ? 'state_conflict' : 'unavailable';
