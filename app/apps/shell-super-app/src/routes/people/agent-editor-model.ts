import { Option, Schema } from 'effect';
/** Pure draft model of the agent editor side panel: validation and request bodies. Rights come from roles only. */
import type {
  AgentEntity,
  AgentWritePolicy,
  ManageAgentEntityRequest,
  PrincipalRef,
} from '@app/shared-contracts/agent-access';
import { AgentPrincipalIdSchema } from '@app/shared-contracts/agent-proposals';
import { AGENT_DESCRIPTION_MAX, AGENT_NAME_MAX } from '@app/shared-contracts/agent-access';

export interface AgentDraft {
  readonly description: string;
  readonly displayName: string;
  readonly operatorPrincipalIds: readonly string[];
  readonly ownerPrincipalId: string | null;
  readonly writePolicy: AgentWritePolicy;
}

export const emptyAgentDraft: AgentDraft = {
  description: '',
  displayName: '',
  operatorPrincipalIds: [],
  ownerPrincipalId: null,
  writePolicy: 'approval',
};

export const draftFromAgent = (agent: AgentEntity): AgentDraft => ({
  description: Option.getOrElse(agent.description, () => ''),
  displayName: agent.displayName,
  operatorPrincipalIds: agent.operators.map((person) => person.principalId),
  ownerPrincipalId: Option.getOrNull(Option.map((owner: PrincipalRef) => owner.principalId)(agent.owner)),
  writePolicy: agent.hasProfile ? agent.writePolicy : emptyAgentDraft.writePolicy,
});

const AgentDraftErrorSchema = Schema.Literals(['descriptionTooLong', 'nameRequired', 'nameTooLong', 'ownerRequired']);
export type AgentDraftError = typeof AgentDraftErrorSchema.Type;

/** In this order: name, description, owner. */
export const draftErrors = (draft: AgentDraft): readonly AgentDraftError[] => {
  const name = draft.displayName.trim();
  const errors: AgentDraftError[] = [];
  if (name === '') {
    errors.push('nameRequired');
  } else if (name.length > AGENT_NAME_MAX) {
    errors.push('nameTooLong');
  }
  if (draft.description.trim().length > AGENT_DESCRIPTION_MAX) {
    errors.push('descriptionTooLong');
  }
  if (draft.ownerPrincipalId === null) {
    errors.push('ownerRequired');
  }
  return errors;
};

const descriptionOf = (draft: AgentDraft): string | null =>
  draft.description.trim() === '' ? null : draft.description.trim();

export const createRequest = (draft: AgentDraft): ManageAgentEntityRequest => ({
  description: Option.fromNullOr(descriptionOf(draft)),
  displayName: draft.displayName.trim(),
  operation: 'create',
  operatorPrincipalIds: draft.operatorPrincipalIds.map((id) => AgentPrincipalIdSchema.make(id)),
  ownerPrincipalId: AgentPrincipalIdSchema.make(draft.ownerPrincipalId ?? ''),
  writePolicy: draft.writePolicy,
});

export const configureRequest = (draft: AgentDraft, principalId: string): ManageAgentEntityRequest => ({
  description: Option.fromNullOr(descriptionOf(draft)),
  displayName: draft.displayName.trim(),
  operation: 'configure',
  ownerPrincipalId: AgentPrincipalIdSchema.make(draft.ownerPrincipalId ?? ''),
  principalId: AgentPrincipalIdSchema.make(principalId),
  writePolicy: draft.writePolicy,
});
