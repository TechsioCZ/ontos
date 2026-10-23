/**
 * Pure mappers from core.agent_proposals rows and audit/access rows to the platform queue and activity wire shapes.
 * No database imports: the proposal store feeds these functions.
 */
import {
  AGENT_REVERT_UNAVAILABLE,
  type AgentActivityEntry,
  type AgentActivityKind,
  type AgentActivityRequest,
  type AgentActivityResponse,
  type AgentCommand,
  type AgentDiffLine,
  type AgentItemStatus,
  type AgentQueueBatch,
  type AgentQueueItem,
  type AgentRevertPlan,
  type AgentRisk,
} from '@app/shared-contracts/agent-proposals';
import { agentCommandDiff } from '@app/shared-contracts/agent-diff';
import type { AgentReviewItem } from '@app/shared-contracts/agent-review';
import { DateTime } from 'effect';

import { czechModuleFailure, isGenericProblemText } from './approval-logic.ts';

export interface AgentProposalRow {
  readonly proposalId: string;
  readonly tenantId: string;
  readonly legalEntityId: string;
  readonly batchId: string;
  readonly batchInstruction: string;
  readonly runId: string | null;
  readonly position: number;
  readonly agentPrincipalId: string;
  readonly agentLabel: string;
  readonly appId: string;
  readonly moduleKey: string;
  readonly actionSlug: string;
  readonly command: AgentCommand;
  readonly referenceAudiences: readonly string[];
  readonly summary: string;
  readonly targetLabel: string;
  readonly reason: string;
  readonly risk: AgentRisk;
  readonly diff: readonly AgentDiffLine[];
  readonly revert: AgentRevertPlan | null;
  readonly status: AgentItemStatus;
  readonly createdAt: Date;
  readonly decidedByPrincipalId: string | null;
  readonly decidedAt: Date | null;
  readonly decisionNote: string | null;
  readonly appliedAt: Date | null;
  readonly applyResult: unknown;
  readonly failure: string | null;
  readonly revertedByPrincipalId: string | null;
  readonly revertedAt: Date | null;
  readonly batchRevertedAt: Date | null;
  readonly batchRevertedByPrincipalId: string | null;
  readonly batchRevertNote: string | null;
}

export interface AuditActivityRow {
  readonly auditEventId: string;
  readonly occurredAt: Date;
  readonly principalId: string;
  readonly displayName: string;
  readonly outcome: string;
  readonly outcomeCode: string;
  readonly actionKey: string | null;
  readonly targetModuleKey?: string | null;
  readonly targetResourceId?: string | null;
  readonly targetResourceType?: string | null;
}

export interface AccessActivityRow {
  readonly dataAccessEventId: string;
  readonly occurredAt: Date;
  readonly principalId: string;
  readonly displayName: string;
  readonly outcome: string;
  readonly outcomeCode: string;
  readonly accessKind: string;
  readonly servingModuleKey: string;
  readonly targetResourceType: string | null;
  readonly targetResourceId?: string | null;
}

export const nameOf = (names: ReadonlyMap<string, string>, principalId: string | null): string =>
  principalId === null ? 'Neznámý uživatel' : (names.get(principalId) ?? 'Neznámý uživatel');

/** Whether the person may decide one pending proposal, with the Czech reason when not. */
export type QueueItemDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason?: string };

/** What the mappers need to know about composed modules (from their contributions). */
export interface ModuleTexts {
  /** Czech names of the module's command fields, from its MCP contribution (by deployment app id). */
  readonly commandFieldLabelsOf: (appId: string) => Readonly<Record<string, string>>;
  /** The module keeps its own AI change engine: its apply-command writes by proposal-only agents are proposals. */
  readonly hasOwnProposalEngine: (moduleKey: string) => boolean;
  readonly labelOf: (moduleKey: string | null | undefined) => string;
  readonly recordReferenceOf?: (moduleKey: string, command: AgentCommand) => AgentActivityEntry['recordReference'];
}

export interface QueueItemOptions {
  readonly canDecide: (row: AgentProposalRow) => QueueItemDecision;
  readonly modules: ModuleTexts;
  /** The module's review of a proposal, read as the person (undefined: the module has none or it did not answer). */
  readonly reviewOf?: (row: AgentProposalRow) => AgentReviewItem | undefined;
  readonly names: ReadonlyMap<string, string>;
}

/** Keeps the platform lines, taking `before` from the stored lines of the same field (stored at submit/approval). */
const withStoredBefore = (
  lines: readonly AgentDiffLine[],
  stored: readonly AgentDiffLine[],
): readonly AgentDiffLine[] =>
  lines.map((line) => {
    const before = line.before ?? stored.find((candidate) => candidate.field === line.field)?.before;
    return before === undefined ? line : { ...line, before };
  });

/**
 * The diff a person sees: the module's own lines whenever it describes the command (pending: before from the live
 * record; decided: before as stored at submission or approval), otherwise the platform lists the stored command.
 */
export const itemDiff = (
  row: AgentProposalRow,
  review: AgentReviewItem | undefined,
  commandFieldLabels: Readonly<Record<string, string>>,
): { readonly diff: readonly AgentDiffLine[]; readonly diffSource: 'agent' | 'command' | 'platform' } => {
  const lines = review?.diff;
  if (lines === undefined) {
    // Modules without their own lines: the platform lists the stored command itself (never the agent's text).
    const fromCommand = agentCommandDiff(row.command, commandFieldLabels);
    return fromCommand.length > 0
      ? { diff: fromCommand, diffSource: 'command' }
      : { diff: row.diff, diffSource: 'agent' };
  }
  return { diff: row.status === 'pending' ? lines : withStoredBefore(lines, row.diff), diffSource: 'platform' };
};

/** Failures stored before module problems were translated can be English framework texts; show them in Czech. */
export const storedFailureText = (failure: string): string =>
  failure === 'Modul odpověděl chybou HTTP 200.'
    ? 'Modul neuvedl aktuální revizi záznamu, změna se proto neprovedla.'
    : isGenericProblemText(failure)
      ? czechModuleFailure(failure)
      : failure;

const toItem = (row: AgentProposalRow, options: QueueItemOptions): AgentQueueItem => {
  const review = options.reviewOf?.(row);
  const revertUnavailableReason =
    row.status === 'pending'
      ? review === undefined
        ? AGENT_REVERT_UNAVAILABLE
        : review.revertUnavailableReason
      : row.revert === null
        ? AGENT_REVERT_UNAVAILABLE
        : row.revert.kind === 'none'
          ? row.revert.reason
          : undefined;
  const { diff, diffSource } = itemDiff(row, review, options.modules.commandFieldLabelsOf(row.appId));
  // A pending row with decided_at is only claimed by an approval in progress; it has no decision yet.
  const decided = row.status !== 'pending';
  const decision = options.canDecide(row);
  const liveName = row.status === 'pending' ? review?.targetName : undefined;
  // Agents often repeat the action name as the target; the record's own name says more.
  const targetLabel = row.targetLabel === row.summary && liveName !== undefined ? liveName : row.targetLabel;
  return {
    appId: row.appId,
    canDecide: decision.allowed,
    ...(decision.allowed || decision.reason === undefined || row.status !== 'pending'
      ? {}
      : { cannotDecideReason: decision.reason }),
    command: row.command,
    diff,
    diffSource,
    key: `core:${row.proposalId}`,
    moduleKey: row.moduleKey,
    moduleLabel: options.modules.labelOf(row.moduleKey),
    proposedAt: row.createdAt.toISOString(),
    reason: row.reason,
    risk: row.risk,
    status: row.status,
    summary: row.summary,
    targetLabel,
    ...(!decided || row.decidedAt === null ? {} : { decidedAt: row.decidedAt.toISOString() }),
    ...(!decided || row.decidedByPrincipalId === null
      ? {}
      : { decidedByName: nameOf(options.names, row.decidedByPrincipalId) }),
    ...(row.decisionNote === null ? {} : { decisionNote: row.decisionNote }),
    ...(row.failure === null ? {} : { failure: storedFailureText(row.failure) }),
    ...(revertUnavailableReason === undefined ? {} : { revertUnavailableReason }),
  };
};

export const rowsToQueueBatches = (rows: readonly AgentProposalRow[], options: QueueItemOptions): AgentQueueBatch[] => {
  const groups = new Map<string, { readonly head: AgentProposalRow; readonly rows: AgentProposalRow[] }>();
  for (const row of rows) {
    const group = groups.get(row.batchId);
    if (group === undefined) {
      groups.set(row.batchId, { head: row, rows: [row] });
    } else {
      group.rows.push(row);
    }
  }
  return [...groups.values()].map(({ head, rows: batchRows }) => {
    const items = [...batchRows].sort((a, b) => a.position - b.position).map((row) => toItem(row, options));
    const createdAt = DateTime.formatIso(
      DateTime.makeUnsafe(Math.min(...batchRows.map((row) => row.createdAt.getTime()))),
    );
    const canRevertAll =
      head.batchRevertedAt === null &&
      items.some((item) => item.status === 'applied' && item.revertUnavailableReason === undefined && item.canDecide);
    return {
      agentLabel: head.agentLabel,
      agentPrincipalId: head.agentPrincipalId,
      batchId: head.batchId,
      canRevertAll,
      createdAt,
      instruction: head.batchInstruction,
      items,
      key: `core:${head.batchId}`,
      moduleLabels: [...new Set(items.map((item) => item.moduleLabel))],
      source: 'core',
      ...(head.batchRevertedAt === null ? {} : { revertedAt: head.batchRevertedAt.toISOString() }),
      ...(head.batchRevertedByPrincipalId === null
        ? {}
        : { revertedByName: nameOf(options.names, head.batchRevertedByPrincipalId) }),
      ...(head.batchRevertNote === null ? {} : { revertNote: head.batchRevertNote }),
    };
  });
};

export const moduleKeyOfAction = (actionKey: string | null): string | null =>
  actionKey === null || !actionKey.includes('.') ? null : actionKey.slice(0, actionKey.lastIndexOf('.'));

/** Modules with their own AI change engine take agent proposals as a write of their own apply-command. */
export const auditRowToEntry = (
  row: AuditActivityRow,
  options: { readonly modules: ModuleTexts; readonly proposalOnly: boolean },
): AgentActivityEntry => {
  const moduleKey = row.targetModuleKey ?? moduleKeyOfAction(row.actionKey);
  const proposal =
    row.outcome === 'succeeded' &&
    options.proposalOnly &&
    moduleKey !== null &&
    options.modules.hasOwnProposalEngine(moduleKey);
  const kind: AgentActivityKind = proposal
    ? 'proposal'
    : row.outcome === 'succeeded'
      ? 'write'
      : row.outcome === 'denied'
        ? 'denied'
        : 'failed';
  const actionLabel = proposal
    ? 'Návrh ke schválení'
    : kind === 'write'
      ? 'Zápis změny'
      : kind === 'denied'
        ? 'Pokus o zápis odmítnut'
        : 'Zápis selhal';
  // `<module>.apply-command` says nothing beyond the module label; other action keys stay as detail.
  const detail =
    row.actionKey === null || row.actionKey.endsWith('.apply-command')
      ? proposal
        ? `Návrh do schvalovací fronty modulu ${options.modules.labelOf(moduleKey)}`
        : undefined
      : row.actionKey;
  return {
    actionLabel,
    agentName: row.displayName,
    agentPrincipalId: row.principalId,
    id: `audit:${row.auditEventId}`,
    ...(row.targetResourceId == null || row.targetResourceType == null
      ? {}
      : {
          recordReference: { resourceId: row.targetResourceId, resourceType: row.targetResourceType },
        }),
    kind,
    moduleKey,
    moduleLabel: options.modules.labelOf(moduleKey),
    occurredAt: row.occurredAt.toISOString(),
    outcomeCode: proposal ? 'proposed' : row.outcomeCode,
    ...(detail === undefined ? {} : { detail }),
  };
};

const READ_LABELS: Readonly<Record<string, string>> = {
  download: 'Stažení souboru',
  export: 'Export dat',
  list: 'Čtení seznamu',
  read: 'Čtení záznamu',
  search: 'Vyhledávání',
};

export const accessRowToEntry = (row: AccessActivityRow, modules: ModuleTexts): AgentActivityEntry => {
  const allowed = row.outcome === 'allowed';
  const kind: AgentActivityKind = allowed ? 'read' : 'denied';
  const actionLabel = allowed ? (READ_LABELS[row.accessKind] ?? 'Čtení') : 'Čtení odmítnuto oprávněním';
  return {
    actionLabel,
    agentName: row.displayName,
    agentPrincipalId: row.principalId,
    id: `read:${row.dataAccessEventId}`,
    ...(row.targetResourceId == null || row.targetResourceType === null
      ? {}
      : {
          recordReference: { resourceId: row.targetResourceId, resourceType: row.targetResourceType },
        }),
    kind,
    moduleKey: row.servingModuleKey,
    moduleLabel: modules.labelOf(row.servingModuleKey),
    occurredAt: row.occurredAt.toISOString(),
    outcomeCode: row.outcomeCode,
    ...(row.targetResourceType === null ? {} : { detail: row.targetResourceType }),
  };
};

export const proposalRowToEntries = (
  row: AgentProposalRow,
  names: ReadonlyMap<string, string>,
  modules: ModuleTexts,
): AgentActivityEntry[] => {
  const recordReference = modules.recordReferenceOf?.(row.moduleKey, row.command);
  const base = {
    ...(recordReference === undefined ? {} : { recordReference }),
    proposal: { batchKey: `core:${row.batchId}`, itemKey: `core:${row.proposalId}` },
    agentName: row.agentLabel,
    agentPrincipalId: row.agentPrincipalId,
    moduleKey: row.moduleKey,
    moduleLabel: modules.labelOf(row.moduleKey),
  };
  const entries: AgentActivityEntry[] = [
    {
      ...base,
      actionLabel: `Návrh: ${row.summary}`,
      detail: row.targetLabel,
      id: `proposal:${row.proposalId}`,
      kind: 'proposal',
      occurredAt: row.createdAt.toISOString(),
      outcomeCode: 'proposed',
    },
  ];
  if (row.decidedAt !== null && row.status !== 'pending') {
    const decider = nameOf(names, row.decidedByPrincipalId);
    entries.push({
      ...base,
      actionLabel:
        row.status === 'rejected'
          ? `Zamítnuto: ${decider}`
          : row.status === 'failed'
            ? `Schváleno, ale nešlo provést: ${decider}`
            : `Schváleno: ${decider}`,
      detail: row.summary,
      id: `decision:${row.proposalId}`,
      kind: 'decision',
      occurredAt: row.decidedAt.toISOString(),
      outcomeCode: row.status,
    });
  }
  if (row.revertedAt !== null) {
    entries.push({
      ...base,
      actionLabel: `Vráceno: ${nameOf(names, row.revertedByPrincipalId)}`,
      detail: row.summary,
      id: `revert:${row.proposalId}`,
      kind: 'decision',
      occurredAt: row.revertedAt.toISOString(),
      outcomeCode: 'reverted',
    });
  }
  return entries;
};

export const buildActivityResponse = (
  entries: readonly AgentActivityEntry[],
  request: AgentActivityRequest,
): AgentActivityResponse => {
  const sorted = [...entries].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));

  const agentNames = new Map<string, string>();
  for (const entry of sorted) {
    if (!agentNames.has(entry.agentPrincipalId)) {
      agentNames.set(entry.agentPrincipalId, entry.agentName);
    }
  }
  const agents = [...agentNames]
    .map(([principalId, name]) => ({ name, principalId }))
    .sort((a, b) => a.name.localeCompare(b.name, 'cs'));

  const moduleLabels = new Map<string, string>();
  for (const entry of sorted) {
    if (entry.moduleKey !== null && !moduleLabels.has(entry.moduleKey)) {
      moduleLabels.set(entry.moduleKey, entry.moduleLabel);
    }
  }
  const modules = [...moduleLabels]
    .map(([moduleKey, label]) => ({ label, moduleKey }))
    .sort((a, b) => a.label.localeCompare(b.label, 'cs'));

  const filtered = sorted.filter(
    (entry) =>
      (request.agentPrincipalId === undefined || entry.agentPrincipalId === request.agentPrincipalId) &&
      (request.moduleKey === undefined || entry.moduleKey === request.moduleKey) &&
      (request.kind === undefined || entry.kind === request.kind),
  );

  return { agents, entries: filtered.slice(0, request.limit ?? 150), modules };
};
