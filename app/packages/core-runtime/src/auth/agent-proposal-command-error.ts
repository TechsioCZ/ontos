import { Schema } from 'effect';

export class AgentProposalCommandError extends Schema.TaggedError<AgentProposalCommandError>()(
  'AgentProposalCommandError',
  {
    code: Schema.Literals(['agent_proposal_conflict', 'agent_proposal_invalid', 'agent_proposal_unavailable']),
    reason: Schema.String,
  },
) {}

export const proposalCommandConflict = (reason: string) =>
  new AgentProposalCommandError({ code: 'agent_proposal_conflict', reason });
export const proposalCommandInvalid = (reason: string) =>
  new AgentProposalCommandError({ code: 'agent_proposal_invalid', reason });
export const proposalCommandUnavailable = (cause?: unknown) =>
  Object.defineProperty(
    new AgentProposalCommandError({ code: 'agent_proposal_unavailable', reason: 'Proposal lifecycle is unavailable' }),
    'cause',
    { value: cause },
  );
