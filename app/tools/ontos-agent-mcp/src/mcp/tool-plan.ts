import type { Catalog, CatalogEntry } from '../capabilities/types.ts';
import type { ConnectionDescription } from '../oauth/types.ts';
import type { ToolAnnotationsSpec } from './types.ts';

export const TYPED_TOOL_CAP = 40;
export const GENERIC_READ_TOOLS = ['ontos_whoami', 'ontos_capabilities', 'ontos_read', 'ontos_list_proposals'] as const;
export const GENERIC_WRITE_TOOLS = ['ontos_execute', 'ontos_propose'] as const;
export type GenericToolName = (typeof GENERIC_READ_TOOLS)[number] | (typeof GENERIC_WRITE_TOOLS)[number];

export interface ToolPlan {
  readonly generic: readonly GenericToolName[];
  /** Typed tools; empty when the candidates exceed TYPED_TOOL_CAP (design §5.3). */
  readonly typed: readonly CatalogEntry[];
  readonly typedCandidates: number;
  readonly typedOverCap: boolean;
}

export const grantedModule = (description: ConnectionDescription, moduleId: string) =>
  description.modules.find((module) => module.moduleId === moduleId);
export const canRead = (description: ConnectionDescription, moduleId: string): boolean =>
  grantedModule(description, moduleId)?.read === true;
export const canWrite = (description: ConnectionDescription, moduleId: string): boolean =>
  description.writePolicy !== 'read_only' && grantedModule(description, moduleId)?.write === true;
/** AiProposeChanges / AiDecideChanges / AiRevertBatch are approval plumbing, never offered as tools. */
export const isAiMetaCommand = (entry: CatalogEntry): boolean =>
  entry.kind === 'action' && entry.commandTag !== undefined && /^Ai[A-Z]/u.test(entry.commandTag);
const DESTRUCTIVE = /(delete|remove|cancel|storno|archive|revoke|deactivate|reject)/iu;

export const annotationsFor = (entry: CatalogEntry): ToolAnnotationsSpec =>
  entry.kind === 'read'
    ? { openWorldHint: false, readOnlyHint: true }
    : {
        destructiveHint: DESTRUCTIVE.test(entry.commandTag ?? entry.actionSlug),
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
      };

export const planTools = (catalog: Catalog, description: ConnectionDescription): ToolPlan => {
  const generic: GenericToolName[] = [...GENERIC_READ_TOOLS];
  if (description.writePolicy !== 'read_only') {
    generic.push(...GENERIC_WRITE_TOOLS);
  }
  const seen = new Set<string>();
  const candidates: CatalogEntry[] = [];
  const add = (entry: CatalogEntry) => {
    if (!seen.has(entry.toolName)) {
      seen.add(entry.toolName);
      candidates.push(entry);
    }
  };
  for (const module of catalog.modules) {
    if (!module.typedTools || !canRead(description, module.moduleId)) {
      continue;
    }
    module.reads.forEach(add);
    if (canWrite(description, module.moduleId)) {
      const actions = module.actions.filter((action) => !isAiMetaCommand(action));
      // Approval: typed tools only for commands the module accepts as proposals; ontos_execute can propose any.
      (description.writePolicy === 'approval' ? actions.filter((action) => action.proposable) : actions).forEach(add);
    }
  }
  const over = candidates.length > TYPED_TOOL_CAP;
  return { generic, typed: over ? [] : candidates, typedCandidates: candidates.length, typedOverCap: over };
};
