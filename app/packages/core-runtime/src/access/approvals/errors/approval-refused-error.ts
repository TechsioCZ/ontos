import { Schema } from 'effect';

export const APPROVAL_REFUSAL_CODES = [
  'approval_authority_missing',
  'approver_not_human',
  'authority_witness_mismatch',
  'capability_not_approvable',
  'execution_authority_missing',
  'identity_bound_action',
  'independent_approver_required',
  'parent_record_read_missing',
  'parent_record_read_unexpected',
  'proposal_expired',
  'proposal_not_found',
  'proposal_not_pending',
  'rejection_not_permitted',
  'requester_authority_lost',
  'requester_cannot_reject',
  'self_approval_forbidden',
] as const;
export type ApprovalRefusalCode = (typeof APPROVAL_REFUSAL_CODES)[number];

/**
 * Only people approve or reject (D2), only declarations that support approval (O14), never a command
 * that raises the requester's own authority (P6), and only an eligible decider rejects a pending
 * proposal — the requester withdraws instead (O61).
 */
export class ApprovalRefusedError extends Schema.TaggedError<ApprovalRefusedError>()('ApprovalRefusedError', {
  code: Schema.Literals(APPROVAL_REFUSAL_CODES),
  reason: Schema.String,
}) {}
