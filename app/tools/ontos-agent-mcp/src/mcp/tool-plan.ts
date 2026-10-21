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
/**
 * Modules whose changes the platform approval queue accepts (mirror of agentApprovalModules in
 * packages/shared-contracts/src/agent-proposals.ts; the shell refuses proposals for any other app with 403).
 */
export const APPROVAL_QUEUE_MODULES: ReadonlySet<string> = new Set([
  'demo.crm',
  'demo.sales-pipeline',
  'demo.merchandise',
  'work.tasks',
  'property.leasing',
  'demo.tagging',
  'crm.activities',
  'facility.operations',
  'legal.agreements',
  'party.registry',
  'commerce.customer-context',
  'property.portfolio',
  'finance.billing',
  'demo.workforce',
]);
export const acceptsProposals = (moduleId: string): boolean => APPROVAL_QUEUE_MODULES.has(moduleId);
/** The grant allows writing to the module (before the approval-queue check). */
export const grantAllowsWrite = (description: ConnectionDescription, moduleId: string): boolean =>
  description.writePolicy !== 'read_only' && grantedModule(description, moduleId)?.write === true;
/** Changes this connection can actually make: directly, or as proposals the approval queue accepts. */
export const canWrite = (description: ConnectionDescription, moduleId: string): boolean =>
  grantAllowsWrite(description, moduleId) && (description.writePolicy !== 'approval' || acceptsProposals(moduleId));
/** ontos_propose: a batch for human approval, also from direct connections. */
export const canPropose = (description: ConnectionDescription, moduleId: string): boolean =>
  grantAllowsWrite(description, moduleId) && acceptsProposals(moduleId);
/** AiProposeChanges / AiDecideChanges / AiRevertBatch are approval plumbing, never offered as tools. */
export const isAiMetaCommand = (entry: CatalogEntry): boolean =>
  entry.kind === 'action' && entry.commandTag !== undefined && /^Ai[A-Z]/u.test(entry.commandTag);

/** Demo maintenance (reset, remove demo orders) is never offered to connected apps. */
const DEMO_MAINTENANCE = /(reset[-_]?demo|demo[-_]?data|demo[-_]?order|demo[-_]?product|seed)/iu;
/**
 * Commands a module reserves for people working in the app (merchandise command-guard nonHumanForbiddenCommands):
 * a connection may only propose them for approval, never run them directly.
 */
export const HUMAN_ONLY_COMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  'demo.merchandise': new Set(['BulkUpdateProducts', 'ChangePrice', 'EditOrder', 'UpdateCategory']),
};
const humanOnly = (entry: CatalogEntry): boolean =>
  entry.kind === 'action' && entry.commandTag !== undefined && HUMAN_ONLY_COMMANDS[entry.moduleId]?.has(entry.commandTag) === true;

export type ActionAvailability = 'offered' | 'ai_meta' | 'demo_maintenance' | 'human_only';
/** Whether an action is offered to this connection at all (independent of the module grant). */
export const actionAvailability = (entry: CatalogEntry, policy: ConnectionDescription['writePolicy']): ActionAvailability => {
  if (isAiMetaCommand(entry)) {
    return 'ai_meta';
  }
  if (entry.kind === 'action' && DEMO_MAINTENANCE.test(entry.commandTag ?? entry.actionSlug)) {
    return 'demo_maintenance';
  }
  if (policy === 'direct' && humanOnly(entry)) {
    return 'human_only';
  }
  return 'offered';
};
export const isOffered = (entry: CatalogEntry, policy: ConnectionDescription['writePolicy']): boolean =>
  actionAvailability(entry, policy) === 'offered';

/** Deletes, cancels, voids, erases or otherwise removes data or access; clients should ask before calling. */
const DESTRUCTIVE =
  /(delete|remove|cancel|storno|void|archive|revoke|deactivate|reject|terminate|dispose|retract|erase|erasure|anonymi|privacy|purge|wipe|reset|suspend)/iu;

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
      const actions = module.actions.filter((action) => isOffered(action, description.writePolicy));
      // Approval: typed tools only for commands the module accepts as proposals; ontos_execute can propose any.
      (description.writePolicy === 'approval' ? actions.filter((action) => action.proposable) : actions).forEach(add);
    }
  }
  const over = candidates.length > TYPED_TOOL_CAP;
  return { generic, typed: over ? [] : candidates, typedCandidates: candidates.length, typedOverCap: over };
};
