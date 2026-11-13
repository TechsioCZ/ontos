import { Schema } from 'effect';

import type { DecisionCapabilityPolicy } from '../decision/contract.ts';
import { agentTier } from '../decision/engine.ts';
import type { AccessScopeId, AgentId } from '../ids.ts';
import type { Assignment, CatalogSnapshotEntry, Cell, ConsentCeiling, Role, RoleRevision } from '../model.ts';
import { sameHolder } from '../model.ts';
import { assignmentIsLive } from './people-commands.ts';

/*
 * What an agent can actually use of its roles. An agent's rights come only from the roles assigned to it, like
 * anybody's, but the engine admits from an agent's cells only what an agent may do at all (`agentTier`): never
 * administration, never approval, never a sensitive read, and a non-routine run only as a proposal. This module SHOWS
 * that set — on the Agents page, in the consent offer and in the consent ceiling — with the engine's own rule, so
 * nobody reads an administrative cell of a role as something the agent was given. It decides nothing: every request
 * is still decided by the gate, as the agent, on both sides.
 */

/** `direct`: the agent runs it itself. `approval`: the agent only proposes it and a person decides. */
export const AgentCellUseSchema = Schema.Literals(['approval', 'direct']);
export type AgentCellUse = typeof AgentCellUseSchema.Type;

export interface AgentUsableCapability {
  readonly entry: CatalogSnapshotEntry;
  readonly use: AgentCellUse;
}

const policyOf = (entry: CatalogSnapshotEntry): DecisionCapabilityPolicy => {
  const policy: DecisionCapabilityPolicy = {
    capabilityKey: entry.key,
    kind: entry.kind,
    modes: entry.modes,
    risk: entry.risk,
    selectors: entry.selectors,
  };
  return entry.ephemeral === true ? { ...policy, ephemeral: true } : policy;
};

/**
 * How an agent may use one cell, by the engine's agent tier. A run cell is usable only where the run needs no
 * approval (a non-routine run is decided on the PROPOSE cells instead); a propose cell is a proposal; an approve
 * cell and every administrative capability are nothing.
 */
export const agentUseOfCell = (cell: Cell, entry: CatalogSnapshotEntry): AgentCellUse | undefined => {
  if (cell.mode === 'approve') {
    return undefined;
  }
  const tier = agentTier(policyOf(entry), cell.mode);
  if ('reason' in tier) {
    return undefined;
  }
  if (cell.mode === 'propose') {
    return 'approval';
  }
  return tier.approvalRequired ? undefined : 'direct';
};

/** The cells of the agent's live assignments in one scope, at the revisions those assignments pin. */
export const agentRoleCells = (input: {
  readonly agentId: AgentId;
  readonly assignments: readonly Assignment[];
  readonly at: Date;
  readonly roles: readonly { readonly revision: RoleRevision; readonly role: Role }[];
  readonly scopeId: AccessScopeId;
}): readonly Cell[] => {
  const holder = { _tag: 'Agent' as const, agentId: input.agentId };
  const revisions = new Map(input.roles.map(({ revision }) => [revision.id, revision] as const));
  return input.assignments.flatMap((assignment) =>
    assignment.scopeId === input.scopeId &&
    sameHolder(assignment.holder, holder) &&
    assignmentIsLive(assignment, input.at)
      ? (revisions.get(assignment.roleRevisionId)?.cells ?? [])
      : [],
  );
};

/**
 * The capabilities an agent can use of the given cells, one entry per capability with its best use (`direct` wins
 * over `approval`). A cell the release does not declare is no capability at all.
 */
export const agentUsableCapabilities = (
  cells: readonly Cell[],
  catalog: readonly CatalogSnapshotEntry[],
): readonly AgentUsableCapability[] => {
  const entries = new Map(catalog.map((entry) => [entry.key, entry] as const));
  const best = new Map<string, AgentUsableCapability>();
  for (const cell of cells) {
    const entry = entries.get(cell.capabilityKey);
    const use = entry === undefined ? undefined : agentUseOfCell(cell, entry);
    if (entry !== undefined && use !== undefined && best.get(entry.key)?.use !== 'direct') {
      best.set(entry.key, { entry, use });
    }
  }
  return [...best.values()].toSorted((left, right) => left.entry.key.localeCompare(right.entry.key));
};

const READ_KINDS: ReadonlySet<CatalogSnapshotEntry['kind']> = new Set(['export', 'field_read', 'read']);

/** The module access an operator consents to: everything, or per module read or read and write. */
export type ConsentedModules = 'all' | readonly { readonly access: 'read' | 'write'; readonly moduleId: string }[];

/**
 * The consent ceiling of a connection: the slots (capability and mode) of the agent's usable cells inside the modules
 * the operator consented to — a module consented for reading only keeps its reading capabilities. The selector is the
 * scope-wide one, so the ceiling narrows by capability and mode and never by record: what records the agent reaches is
 * still its own cells' selector. The engine intersects this ceiling with the agent's cells on every decision.
 */
export const consentCeilingOf = (input: {
  readonly catalog: readonly CatalogSnapshotEntry[];
  readonly cells: readonly Cell[];
  readonly modules: ConsentedModules;
}): ConsentCeiling => {
  const entries = new Map(input.catalog.map((entry) => [entry.key, entry] as const));
  const access = (moduleKey: string): 'read' | 'write' | undefined =>
    input.modules === 'all' ? 'write' : input.modules.find((module) => module.moduleId === moduleKey)?.access;
  const consentedCell = (cell: Cell): boolean => {
    const entry = entries.get(cell.capabilityKey);
    const consented = entry === undefined ? undefined : access(entry.moduleKey);
    return (
      entry !== undefined &&
      agentUseOfCell(cell, entry) !== undefined &&
      consented !== undefined &&
      (consented === 'write' || READ_KINDS.has(entry.kind))
    );
  };
  const slots = new Map<string, Cell>();
  for (const cell of input.cells.filter(consentedCell)) {
    slots.set(`${cell.capabilityKey} ${cell.mode}`, {
      capabilityKey: cell.capabilityKey,
      mode: cell.mode,
      selector: { _tag: 'all' },
    });
  }
  return { cells: [...slots.values()] };
};
