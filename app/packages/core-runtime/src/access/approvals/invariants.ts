import { Result, Schema } from 'effect';

import { ACCESS_MODEL_PARSE_OPTIONS, MandateSchema, ProposalSchema, canTransitionProposalStatus } from '../model.ts';
import type { Proposal, ProposalStatus } from '../model.ts';
import { ProposalIntegrityError } from './errors/proposal-integrity-error.ts';

const decodeProposal = Schema.decodeUnknownResult(ProposalSchema, ACCESS_MODEL_PARSE_OPTIONS);
const decodeMandate = Schema.decodeUnknownResult(MandateSchema, ACCESS_MODEL_PARSE_OPTIONS);

const invalid = (code: ProposalIntegrityError['code'], reason: string): Result.Result<never, ProposalIntegrityError> =>
  Result.fail(new ProposalIntegrityError({ code, reason }));

const decodeIssue = (proposal: Proposal): string | undefined => {
  const decoded =
    proposal.status === 'approved' || proposal.status === 'executed'
      ? decodeMandate(proposal)
      : decodeProposal(proposal);
  return Result.isFailure(decoded) ? decoded.failure.message : undefined;
};

/**
 * The last gate before a transition is returned or stored (R2-M5). Every produced record is decoded
 * through the model schema — so an approval, a mandate, a lapse or a rejection can never carry a
 * shape the model forbids — and every status move is checked against the model's monotonic table
 * instead of a second, hand-maintained copy of the terminal states.
 */
export const producedProposal = (input: {
  /** The status the record had before the transition; absent when the record is created. */
  readonly from?: ProposalStatus;
  readonly proposal: Proposal;
}): Result.Result<Proposal, ProposalIntegrityError> => {
  const { from, proposal } = input;
  if (from !== undefined && !canTransitionProposalStatus(from, proposal.status)) {
    return invalid('proposal_transition_invalid', `A proposal never moves from ${from} to ${proposal.status}`);
  }
  const issue = decodeIssue(proposal);
  return issue === undefined ? Result.succeed(proposal) : invalid('proposal_record_invalid', issue);
};
