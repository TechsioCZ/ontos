import { Schema } from 'effect';
import { HttpApiSchema } from 'effect/http-api';

import { ProposalIdSchema } from '../access/ids.ts';

/** A parked owner command is a successful 202 result, never Problem Details or a domain result. */
export const ActionProposalAcceptedSchema = Schema.TaggedStruct('ActionProposalAccepted', {
  expiresAt: Schema.DateTimeUtcFromString,
  proposalId: ProposalIdSchema,
}).pipe(HttpApiSchema.status(202));

export type ActionProposalAccepted = typeof ActionProposalAcceptedSchema.Type;

/**
 * O85: the two success contracts a transport may declare. A parked proposal is a *successful* body, so
 * only `result-or-proposal` — the one transport shape whose declared success union names the 202 — may
 * receive one. Every other transport keeps the Action's own result type, which is why widening cannot
 * be the default: it would claim a 202 that the endpoint contract cannot answer.
 */
export const ActionSuccessContractSchema = Schema.Literals(['result', 'result-or-proposal']);
export type ActionSuccessContract = typeof ActionSuccessContractSchema.Type;

/** The proposal answer of a `result-or-proposal` transport, and nothing for a result-only one. */
export type ActionProposalSuccess<Contract extends ActionSuccessContract> = Contract extends 'result-or-proposal'
  ? ActionProposalAccepted
  : never;
