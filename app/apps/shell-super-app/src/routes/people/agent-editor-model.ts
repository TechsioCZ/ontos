import { Option, Schema } from 'effect';
/** Pure draft model of the agent editor side panel: its checks and request bodies. Rights come from roles only. */
import type { AgentEntity, ManageAgentEntityRequest, PrincipalRef } from '@app/shared-contracts/agent-access';
import { AgentPrincipalIdSchema } from '@app/shared-contracts/agent-proposals';
import { AGENT_DESCRIPTION_MAX, AGENT_NAME_MAX, AgentWritePolicySchema } from '@app/shared-contracts/agent-access';

const errorKey = 'shell.agents.editor.errors';

/**
 * The editor's draft as the person types it, checked as Uložit sends it: the name and description trimmed, an owner
 * chosen (`""` is none). Every message is an i18n key.
 */
export const AgentDraftSchema = Schema.Struct({
  description: Schema.String.check(
    Schema.makeFilter((description: string) => description.trim().length <= AGENT_DESCRIPTION_MAX, {
      message: `${errorKey}.descriptionTooLong`,
    }),
  ),
  displayName: Schema.String.check(
    Schema.makeFilter((name: string) => name.trim() !== '', { message: `${errorKey}.nameRequired` }),
    Schema.makeFilter((name: string) => name.trim().length <= AGENT_NAME_MAX, { message: `${errorKey}.nameTooLong` }),
  ),
  operatorPrincipalIds: Schema.Array(AgentPrincipalIdSchema),
  ownerPrincipalId: AgentPrincipalIdSchema.check(
    Schema.makeFilter((owner: string) => owner !== '', { message: `${errorKey}.ownerRequired` }),
  ),
  writePolicy: AgentWritePolicySchema,
});
export type AgentDraft = typeof AgentDraftSchema.Type;
/** The draft as the editor holds it: ids as typed and picked, no owner as `""`. */
export type AgentDraftInput = typeof AgentDraftSchema.Encoded;

export const emptyAgentDraft: AgentDraftInput = {
  description: '',
  displayName: '',
  operatorPrincipalIds: [],
  ownerPrincipalId: '',
  writePolicy: 'approval',
};

export const draftFromAgent = (agent: AgentEntity): AgentDraftInput => ({
  description: Option.getOrElse(agent.description, () => ''),
  displayName: agent.displayName,
  operatorPrincipalIds: agent.operators.map((person) => person.principalId),
  ownerPrincipalId: Option.match(agent.owner, { onNone: () => '', onSome: (owner: PrincipalRef) => owner.principalId }),
  writePolicy: agent.hasProfile ? agent.writePolicy : emptyAgentDraft.writePolicy,
});

const descriptionOf = (draft: AgentDraft): string | null =>
  draft.description.trim() === '' ? null : draft.description.trim();

export const createRequest = (draft: AgentDraft): ManageAgentEntityRequest => ({
  description: Option.fromNullOr(descriptionOf(draft)),
  displayName: draft.displayName.trim(),
  operation: 'create',
  operatorPrincipalIds: draft.operatorPrincipalIds,
  ownerPrincipalId: draft.ownerPrincipalId,
  writePolicy: draft.writePolicy,
});

export const configureRequest = (draft: AgentDraft, principalId: string): ManageAgentEntityRequest => ({
  description: Option.fromNullOr(descriptionOf(draft)),
  displayName: draft.displayName.trim(),
  operation: 'configure',
  ownerPrincipalId: draft.ownerPrincipalId,
  principalId: AgentPrincipalIdSchema.make(principalId),
  writePolicy: draft.writePolicy,
});
