/**
 * Which tools one connection gets: the composition's contributions filtered by the connection's live module rights,
 * its grant and its write policy. Everything module-specific comes from the contributions themselves.
 */
import type { ConnectionDescription } from '@app/shared-contracts/oauth-connections';

import type { McpCatalog, McpCatalogModule, McpCatalogTool } from './catalog.ts';
import type { ToolAnnotationsSpec } from './types.ts';

export const TYPED_TOOL_CAP = 40;
export const GENERIC_READ_TOOLS = ['ontos_whoami', 'ontos_capabilities', 'ontos_read', 'ontos_list_proposals'] as const;
export const GENERIC_WRITE_TOOLS = ['ontos_execute', 'ontos_propose'] as const;
export type GenericToolName = (typeof GENERIC_READ_TOOLS)[number] | (typeof GENERIC_WRITE_TOOLS)[number];

export interface ToolPlan {
  readonly generic: readonly GenericToolName[];
  /** Typed tools; empty when the candidates exceed TYPED_TOOL_CAP. */
  readonly typed: readonly McpCatalogTool[];
  readonly typedCandidates: number;
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

export const planTools = (catalog: McpCatalog, description: ConnectionDescription): ToolPlan => {
  const generic: GenericToolName[] = [...GENERIC_READ_TOOLS];
  if (description.writePolicy !== 'read_only') {
    generic.push(...GENERIC_WRITE_TOOLS);
  }
  const candidates: McpCatalogTool[] = [];
  for (const module of catalog.modules) {
    if (!canRead(description, module.moduleId)) {
      continue;
    }
    const writable = canWrite(description, module);
    for (const tool of module.tools) {
      if (tool.access === 'read' || (writable && isOffered(tool, description.writePolicy, description.acting.kind))) {
        candidates.push(tool);
      }
    }
  }
  const over = candidates.length > TYPED_TOOL_CAP;
  return { generic, typed: over ? [] : candidates, typedCandidates: candidates.length, typedOverCap: over };
};
