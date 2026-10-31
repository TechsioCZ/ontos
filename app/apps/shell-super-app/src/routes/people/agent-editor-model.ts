import { Option, Schema } from 'effect';
/** Pure draft model of the agent editor side panel: module choices, role presets, validation and request bodies. */
import type {
  AgentEntity,
  AgentModuleGrant,
  AgentModuleOption,
  AgentRolePreset,
  AgentWritePolicy,
  ManageAgentEntityRequest,
  PrincipalRef,
} from '@app/shared-contracts/agent-access';
import { AgentPrincipalIdSchema } from '@app/shared-contracts/agent-proposals';
import { AGENT_DESCRIPTION_MAX, AGENT_NAME_MAX } from '@app/shared-contracts/agent-access';

export const ModuleChoiceSchema = Schema.Literals(['none', 'read', 'write']);
export type ModuleChoice = typeof ModuleChoiceSchema.Type;

export interface AgentDraft {
  readonly description: string;
  readonly displayName: string;
  readonly modules: Readonly<Record<string, ModuleChoice>>;
  readonly operatorPrincipalIds: readonly string[];
  readonly ownerPrincipalId: string | null;
  readonly writePolicy: AgentWritePolicy;
}

export const emptyAgentDraft: AgentDraft = {
  description: '',
  displayName: '',
  modules: {},
  operatorPrincipalIds: [],
  ownerPrincipalId: null,
  writePolicy: 'approval',
};

export const draftFromAgent = (agent: AgentEntity): AgentDraft => ({
  description: Option.getOrElse(agent.description, () => ''),
  displayName: agent.displayName,
  modules: Object.fromEntries(agent.modules.map((module) => [module.moduleId, module.access])),
  operatorPrincipalIds: agent.operators.map((person) => person.principalId),
  ownerPrincipalId: Option.getOrNull(Option.map((owner: PrincipalRef) => owner.principalId)(agent.owner)),
  writePolicy: agent.hasProfile ? agent.writePolicy : emptyAgentDraft.writePolicy,
});

const capped = (choice: ModuleChoice, option: AgentModuleOption): ModuleChoice =>
  choice === 'write' && option.maxAccess !== 'write' ? 'read' : choice;

export const withModuleChoice = (draft: AgentDraft, moduleId: string, choice: ModuleChoice): AgentDraft => ({
  ...draft,
  modules: { ...draft.modules, [moduleId]: choice },
});

export const withPreset = (
  draft: AgentDraft,
  preset: AgentRolePreset,
  options: readonly AgentModuleOption[],
): AgentDraft => ({
  ...draft,
  modules: Object.fromEntries(
    preset.modules.flatMap((module) => {
      const option = options.find((candidate) => candidate.moduleId === module.moduleId);
      return option === undefined ? [] : [[module.moduleId, capped(module.access, option)]];
    }),
  ),
});

/** Chosen modules in option order, write capped to what some role of the company has. */
export const draftModules = (draft: AgentDraft, options: readonly AgentModuleOption[]): readonly AgentModuleGrant[] =>
  options.flatMap((option) => {
    const choice = capped(draft.modules[option.moduleId] ?? 'none', option);
    return choice === 'none' ? [] : [{ access: choice, moduleId: option.moduleId }];
  });

const AgentDraftErrorSchema = Schema.Literals([
  'descriptionTooLong',
  'modulesRequired',
  'nameRequired',
  'nameTooLong',
  'ownerRequired',
]);
export type AgentDraftError = typeof AgentDraftErrorSchema.Type;

/** In this order: name, description, owner, modules. */
export const draftErrors = (draft: AgentDraft, options: readonly AgentModuleOption[]): readonly AgentDraftError[] => {
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
  if (draftModules(draft, options).length === 0) {
    errors.push('modulesRequired');
  }
  return errors;
};

export const writeIgnored = (draft: AgentDraft): boolean =>
  draft.writePolicy === 'read_only' && Object.values(draft.modules).includes('write');

const descriptionOf = (draft: AgentDraft): string | null =>
  draft.description.trim() === '' ? null : draft.description.trim();

export const createRequest = (draft: AgentDraft, options: readonly AgentModuleOption[]): ManageAgentEntityRequest => ({
  description: Option.fromNullOr(descriptionOf(draft)),
  displayName: draft.displayName.trim(),
  modules: [...draftModules(draft, options)],
  operation: 'create',
  operatorPrincipalIds: draft.operatorPrincipalIds.map((id) => AgentPrincipalIdSchema.make(id)),
  ownerPrincipalId: AgentPrincipalIdSchema.make(draft.ownerPrincipalId ?? ''),
  writePolicy: draft.writePolicy,
});

export const configureRequest = (
  draft: AgentDraft,
  options: readonly AgentModuleOption[],
  principalId: string,
): ManageAgentEntityRequest => ({
  description: Option.fromNullOr(descriptionOf(draft)),
  displayName: draft.displayName.trim(),
  modules: [...draftModules(draft, options)],
  operation: 'configure',
  ownerPrincipalId: AgentPrincipalIdSchema.make(draft.ownerPrincipalId ?? ''),
  principalId: AgentPrincipalIdSchema.make(principalId),
  writePolicy: draft.writePolicy,
});
