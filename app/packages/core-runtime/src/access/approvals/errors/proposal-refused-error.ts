import { Schema } from 'effect';

export const PROPOSAL_REFUSAL_CODES = [
  'agent_cannot_propose',
  'authority_witness_mismatch',
  'capability_not_proposable',
  'ephemeral_not_proposable',
  'proposal_not_withdrawable',
  'requester_authority_missing',
  'requester_not_v2_subject',
  'withdrawal_by_agent_forbidden',
  'withdrawal_not_permitted',
] as const;
export type ProposalRefusalCode = (typeof PROPOSAL_REFUSAL_CODES)[number];

/**
 * A proposal is never created for a command that cannot wait for a person (O22) or for an actor that
 * may not propose it (D2, P4), and only its own holder withdraws it — anybody else needs the O61
 * eligibility that rejecting needs, resolved by Core rather than claimed by the caller (O64).
 */
export class ProposalRefusedError extends Schema.TaggedError<ProposalRefusedError>()('ProposalRefusedError', {
  code: Schema.Literals(PROPOSAL_REFUSAL_CODES),
  reason: Schema.String,
}) {}
