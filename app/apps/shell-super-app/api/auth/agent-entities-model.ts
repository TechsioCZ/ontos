// Agent entities, pure part (lane agent-entities): module choices, role presets and the draft rules the company
// administrator sees as Czech reasons. No database or Effect imports.
import type { AgentModuleGrant, AgentModuleOption, AgentRolePreset } from '@app/shared-contracts/agent-access';

/** Module choices for agents of a company: highest access any role has, sorted by Czech label. */
export const agentModuleOptions = (
  access: readonly AgentModuleGrant[],
  labelOf: (moduleId: string) => string,
): readonly AgentModuleOption[] =>
  access
    .map(({ access: maxAccess, moduleId }) => ({ label: labelOf(moduleId), maxAccess, moduleId }))
    .toSorted((left, right) => left.label.localeCompare(right.label, 'cs'));

export const agentRolePreset = (
  role: { readonly key: string; readonly label: string },
  modules: readonly AgentModuleGrant[],
): AgentRolePreset => ({ key: role.key, label: role.label, modules });

export interface AgentDraftInput {
  readonly displayName: string;
  readonly existingNames: readonly string[];
  /** Czech label of a module key (from the composed modules). */
  readonly labelOf: (moduleId: string) => string;
  readonly memberIds: readonly string[];
  readonly modules: readonly AgentModuleGrant[];
  readonly operatorPrincipalIds: readonly string[];
  readonly options: readonly AgentModuleOption[];
  readonly ownerPrincipalId: string;
}

const sameName = (left: string, right: string) =>
  left.trim().toLocaleLowerCase('cs') === right.trim().toLocaleLowerCase('cs');

/** Czech reason why the agent cannot be saved, or null. First failing rule wins. */
export const agentDraftProblem = (input: AgentDraftInput): string | null => {
  if (input.displayName.trim() === '') {
    return 'Vyplňte název agenta.';
  }
  if (input.existingNames.some((name) => sameName(name, input.displayName))) {
    return 'Agent s tímto názvem už ve firmě je.';
  }
  if (input.modules.length === 0) {
    return 'Vyberte aspoň jeden modul.';
  }
  const moduleIds = new Set(input.modules.map((module) => module.moduleId));
  if (moduleIds.size !== input.modules.length) {
    return 'Každý modul vyberte jen jednou.';
  }
  for (const module of input.modules) {
    const option = input.options.find((candidate) => candidate.moduleId === module.moduleId);
    if (option === undefined) {
      return `Modul ${input.labelOf(module.moduleId)} tato firma nemá.`;
    }
    if (module.access === 'write' && option.maxAccess !== 'write') {
      return `${option.label}: zápis tu nemá žádná role, agent ho dostat nemůže.`;
    }
  }
  if (!input.memberIds.includes(input.ownerPrincipalId)) {
    return 'Za agenta může odpovídat jen aktivní člověk z firmy.';
  }
  if (input.operatorPrincipalIds.some((id) => !input.memberIds.includes(id))) {
    return 'Agenta mohou připojit jen aktivní lidé z firmy.';
  }
  return null;
};
