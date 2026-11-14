import { Schema } from 'effect';

/** Internal closed failure vocabulary; the HTTP adapter supplies only fixed safe Problem Details. */
export class OwnerActionApprovalError extends Schema.TaggedError<OwnerActionApprovalError>()(
  'OwnerActionApprovalError',
  {
    code: Schema.Literals(['authentication_required', 'approval_conflict', 'approval_refused', 'approval_unavailable']),
  },
) {}

/** Retain the original cause privately, without placing it in the transport's public error schema. */
export const ownerActionApprovalFailure = <Cause>(
  code: OwnerActionApprovalError['code'],
  cause?: Cause,
): OwnerActionApprovalError => Object.defineProperty(new OwnerActionApprovalError({ code }), 'cause', { value: cause });
