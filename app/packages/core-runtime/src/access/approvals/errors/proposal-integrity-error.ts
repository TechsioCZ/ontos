import { Schema } from 'effect';

import { PROPOSAL_INTEGRITY_CODES } from './proposal-integrity-codes.ts';

/**
 * A produced proposal record that the model forbids (R2-M5). It is a defect of the lane that
 * produced it, not a caller's mistake: the record was decoded through `ProposalSchema` and its
 * status move was checked against `canTransitionProposalStatus`, and one of the two refused it.
 */
export class ProposalIntegrityError extends Schema.TaggedError<ProposalIntegrityError>()('ProposalIntegrityError', {
  code: Schema.Literals(PROPOSAL_INTEGRITY_CODES),
  reason: Schema.String,
}) {}
