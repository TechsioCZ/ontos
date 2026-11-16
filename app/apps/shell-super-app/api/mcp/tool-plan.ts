/**
 * Which tools one connection gets: the composition's contributions filtered by the connection's live module rights,
 * its grant and its write policy. Everything module-specific comes from the contributions themselves.
 */
import type { ConnectionDescription } from '@app/shared-contracts/oauth-connections';

import type { McpCatalog, McpCatalogModule, McpCatalogTool } from './catalog.ts';
import type { ToolAnnotationsSpec } from './types.ts';

export const TYPED_TOOL_CAP = 40;
export const GENERIC_READ_TOOLS = [
  'ontos_whoami',
  'ontos_capabilities',
  'ontos_read',
  'ontos_search',
  'ontos_list_proposals',
] as const;
export const GENERIC_WRITE_TOOLS = ['ontos_execute', 'ontos_propose'] as const;
export type GenericToolName = (typeof GENERIC_READ_TOOLS)[number] | (typeof GENERIC_WRITE_TOOLS)[number];

/** How one readable module's tools reach this connection. */
export interface ModuleToolPlan {
  /** Tools this connection may use in the module that could be typed tools (`genericOnly` entries excluded). */
  readonly candidates: number;
  /**
   * `typed`: every candidate is listed as its own tool. `generic_only`: the module did not fit the typed-tool budget;
   * all of it stays reachable through ontos_capabilities / ontos_read / ontos_execute / ontos_propose. `none`: the
   * module has no candidate (only generic access).
   */
  readonly mode: 'generic_only' | 'none' | 'typed';
  readonly moduleId: string;
}

export interface ToolPlan {
  readonly generic: readonly GenericToolName[];
  /** One entry per readable module of the catalog, in the order the budget was filled. */
  readonly modules: readonly ModuleToolPlan[];
  /** Typed tools of the modules that fit TYPED_TOOL_CAP, in the same module order. */
  readonly typed: readonly McpCatalogTool[];
  readonly typedCandidates: number;
  /** Some module stays generic-only because the typed tools would exceed TYPED_TOOL_CAP. */
  readonly typedOverCap: boolean;
}

export const grantedModule = (description: ConnectionDescription, moduleId: string) =>
  description.modules.find((module) => module.moduleId === moduleId);
export const canRead = (description: ConnectionDescription, moduleId: string): boolean =>
  grantedModule(description, moduleId)?.read === true;
/** The grant allows writing to the module (before the approval-queue check). */
export const grantAllowsWrite = (description: ConnectionDescription, moduleId: string): boolean =>
  description.writePolicy !== 'read_only' && grantedModule(description, moduleId)?.write === true;
/** Changes this connection can actually make: directly, or as proposals the module accepts. */
export const canWrite = (description: ConnectionDescription, module: McpCatalogModule | undefined): boolean =>
  module !== undefined &&
  grantAllowsWrite(description, module.moduleId) &&
  (description.writePolicy !== 'approval' || module.approvals);
/** ontos_propose: a batch for human approval, also from direct connections. */
export const canPropose = (description: ConnectionDescription, module: McpCatalogModule | undefined): boolean =>
  module !== undefined && grantAllowsWrite(description, module.moduleId) && module.approvals;

/** An agent acting on its own runs `agentProposalOnly` changes only as proposals. */
export const isOffered = (
  tool: McpCatalogTool,
  policy: ConnectionDescription['writePolicy'],
  actingKind: ConnectionDescription['acting']['kind'],
): boolean => !(tool.access === 'write' && tool.agentProposalOnly && policy === 'direct' && actingKind === 'agent');

export const annotationsFor = (tool: McpCatalogTool): ToolAnnotationsSpec =>
  tool.access === 'read'
    ? { openWorldHint: false, readOnlyHint: true }
    : { destructiveHint: tool.destructive, idempotentHint: false, openWorldHint: false, readOnlyHint: false };

/**
 * The connection's module order: its modules as `ConnectionDescription.modules` lists them (Czech label, the order
 * whoami and the consent screen show), ties by module id. It depends only on the granted modules and the composed
 * contributions' labels, never on load order, so the same connection always gets the same tools.
 */
const budgetOrder = (description: ConnectionDescription, catalog: McpCatalog): readonly McpCatalogModule[] => {
  const rank = new Map<string, number>(
    description.modules
      .toSorted(
        (left, right) => left.label.localeCompare(right.label, 'cs') || left.moduleId.localeCompare(right.moduleId),
      )
      .map((module, index) => [module.moduleId, index] as const),
  );
  return catalog.modules
    .filter((module) => rank.has(module.moduleId))
    .toSorted((left, right) => (rank.get(left.moduleId) ?? 0) - (rank.get(right.moduleId) ?? 0));
};

/**
 * Typed tools fill TYPED_TOOL_CAP by whole modules in the connection's module order (first fit: a module that does
 * not fit is skipped and later, smaller modules may still fit). A skipped module is generic-only, never partial, so
 * an agent sees either all of a module's tools or none. The plan only decides what is listed; every call is gated
 * the same way whether it arrives as a typed tool or through the generic tools.
 */
export const planTools = (catalog: McpCatalog, description: ConnectionDescription): ToolPlan => {
  const generic: GenericToolName[] = [...GENERIC_READ_TOOLS];
  if (description.writePolicy !== 'read_only') {
    generic.push(...GENERIC_WRITE_TOOLS);
  }
  const candidatesOf = (module: McpCatalogModule): readonly McpCatalogTool[] => {
    if (!canRead(description, module.moduleId)) {
      return [];
    }
    const writable = canWrite(description, module);
    return module.tools.filter(
      (tool) =>
        tool.genericOnly !== true &&
        (tool.access === 'read' || (writable && isOffered(tool, description.writePolicy, description.acting.kind))),
    );
  };
  const modules: ModuleToolPlan[] = [];
  const typed: McpCatalogTool[] = [];
  let typedCandidates = 0;
  for (const module of budgetOrder(description, catalog)) {
    const candidates = candidatesOf(module);
    typedCandidates += candidates.length;
    let mode: ModuleToolPlan['mode'] = 'none';
    if (candidates.length > 0 && typed.length + candidates.length <= TYPED_TOOL_CAP) {
      typed.push(...candidates);
      mode = 'typed';
    } else if (candidates.length > 0) {
      mode = 'generic_only';
    }
    modules.push({ candidates: candidates.length, mode, moduleId: module.moduleId });
  }
  return {
    generic,
    modules,
    typed,
    typedCandidates,
    typedOverCap: modules.some((module) => module.mode === 'generic_only'),
  };
};
