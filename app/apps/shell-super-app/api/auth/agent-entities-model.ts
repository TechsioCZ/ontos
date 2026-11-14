// Agent entities, pure part (lane agent-entities): the draft rules the company administrator sees as Czech reasons and
// the per-module summary of what an agent can actually use. No database or Effect imports.
import type { AgentUsableModule } from '@app/shared-contracts/agent-access';
import { AgentModuleKeySchema } from '@app/shared-contracts/agent-proposals';

export interface AgentDraftInput {
  readonly displayName: string;
  readonly existingNames: readonly string[];
  readonly memberIds: readonly string[];
  readonly operatorPrincipalIds: readonly string[];
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
  const members = new Set(input.memberIds);
  if (!members.has(input.ownerPrincipalId)) {
    return 'Za agenta může odpovídat jen aktivní člověk z firmy.';
  }
  if (input.operatorPrincipalIds.some((id) => !members.has(id))) {
    return 'Agenta mohou připojit jen aktivní lidé z firmy.';
  }
  return null;
};

const READ_KINDS: ReadonlySet<string> = new Set(['export', 'field_read', 'read']);

/** One capability the agent can use: its module, its kind and whether it runs it itself or only proposes it. */
export interface AgentUsableCapabilityFact {
  readonly kind: string;
  readonly moduleKey: string;
  readonly use: 'approval' | 'direct';
}

/**
 * Per module of the installed composition: whether the agent reads there, and how it changes things there (direct
 * wins over approval). A module the composition does not carry is not shown; nothing technical is named.
 */
export const usableModulesOf = (
  facts: readonly AgentUsableCapabilityFact[],
  labelOf: (moduleId: string) => string,
  installed: ReadonlySet<string>,
): readonly AgentUsableModule[] => {
  const modules = new Map<string, { reads: boolean; writes: AgentUsableModule['writes'] }>();
  for (const fact of facts.filter(({ moduleKey }) => installed.has(moduleKey))) {
    const current = modules.get(fact.moduleKey) ?? { reads: false, writes: 'none' };
    if (READ_KINDS.has(fact.kind)) {
      modules.set(fact.moduleKey, { ...current, reads: true });
    } else {
      modules.set(fact.moduleKey, { ...current, writes: current.writes === 'direct' ? 'direct' : fact.use });
    }
  }
  return [...modules.entries()]
    .map(([moduleId, usage]) => ({ label: labelOf(moduleId), moduleId: AgentModuleKeySchema.make(moduleId), ...usage }))
    .toSorted((left, right) => left.label.localeCompare(right.label, 'cs'));
};
