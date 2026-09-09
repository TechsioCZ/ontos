import { Schema } from 'effect';

export class CounterpartyAccessContractViolation extends Schema.TaggedError<CounterpartyAccessContractViolation>()(
  'CounterpartyAccessContractViolation',
  {
    code: Schema.Literals([
      'counterparty_scope_mismatch',
      'administrative_scope_exceeded',
      'grantor_not_authorized',
      'bootstrap_required',
      'principal_scope_mismatch',
      'principal_not_eligible',
      'permission_not_delegable',
      'permission_scope_not_allowed',
      'reason_required',
      'invitation_invalid',
      'invitation_expired',
      'invitation_revision_conflict',
      'invitation_claimant_mismatch',
      'invitation_rate_limited',
      'invitation_claim_proof_invalid',
      'invitation_claim_proof_consumed',
      'inviter_authority_denied',
    ]),
    reason: Schema.String,
  },
) {}
