/**
 * Pure mappers from core.agent_proposals rows and audit/access rows to the platform queue and activity wire shapes.
 * No database imports: the proposal store feeds these functions.
 */
import {
  AGENT_REVERT_UNAVAILABLE,
  agentModuleLabel,
  type AgentActivityEntry,
  type AgentActivityKind,
  type AgentActivityRequest,
  type AgentActivityResponse,
  type AgentDiffLine,
  type AgentItemStatus,
  type AgentQueueBatch,
  type AgentQueueItem,
  type AgentRevertPlan,
  type AgentRisk,
} from '@app/shared-contracts/agent-proposals';

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
  readonly command: Readonly<Record<string, unknown>>;
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
}

export const nameOf = (names: ReadonlyMap<string, string>, principalId: string | null): string =>
  principalId === null ? 'Neznámý uživatel' : (names.get(principalId) ?? 'Neznámý uživatel');

const toItem = (
  row: AgentProposalRow,
  options: { readonly canDecide: (moduleKey: string) => boolean; readonly names: ReadonlyMap<string, string> },
): AgentQueueItem => {
  const revertUnavailableReason =
    row.revert === null ? AGENT_REVERT_UNAVAILABLE : row.revert.kind === 'none' ? row.revert.reason : undefined;
  return {
    appId: row.appId,
    canDecide: options.canDecide(row.moduleKey),
    diff: row.diff,
    key: `core:${row.proposalId}`,
    moduleKey: row.moduleKey,
    moduleLabel: agentModuleLabel(row.moduleKey),
    proposedAt: row.createdAt.toISOString(),
    reason: row.reason,
    risk: row.risk,
    status: row.status,
    summary: row.summary,
    targetLabel: row.targetLabel,
    ...(row.decidedAt === null ? {} : { decidedAt: row.decidedAt.toISOString() }),
    ...(row.decidedByPrincipalId === null
      ? {}
      : { decidedByName: nameOf(options.names, row.decidedByPrincipalId) }),
    ...(row.decisionNote === null ? {} : { decisionNote: row.decisionNote }),
    ...(row.failure === null ? {} : { failure: row.failure }),
    ...(revertUnavailableReason === undefined ? {} : { revertUnavailableReason }),
  };
};

export const rowsToQueueBatches = (
  rows: readonly AgentProposalRow[],
  options: { readonly canDecide: (moduleKey: string) => boolean; readonly names: ReadonlyMap<string, string> },
): AgentQueueBatch[] => {
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
    const createdAt = new Date(Math.min(...batchRows.map((row) => row.createdAt.getTime()))).toISOString();
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

export const auditRowToEntry = (row: AuditActivityRow): AgentActivityEntry => {
  const kind: AgentActivityKind = row.outcome === 'succeeded' ? 'write' : row.outcome === 'denied' ? 'denied' : 'failed';
  const actionLabel =
    kind === 'write' ? 'Zápis změny' : kind === 'denied' ? 'Pokus o zápis odmítnut' : 'Zápis selhal';
  const moduleKey = moduleKeyOfAction(row.actionKey);
  return {
    actionLabel,
    agentName: row.displayName,
    agentPrincipalId: row.principalId,
    id: `audit:${row.auditEventId}`,
    kind,
    moduleKey,
    moduleLabel: agentModuleLabel(moduleKey),
    occurredAt: row.occurredAt.toISOString(),
    outcomeCode: row.outcomeCode,
    ...(row.actionKey === null ? {} : { detail: row.actionKey }),
  };
};

const READ_LABELS: Readonly<Record<string, string>> = {
  download: 'Stažení souboru',
  export: 'Export dat',
  list: 'Čtení seznamu',
  read: 'Čtení záznamu',
  search: 'Vyhledávání',
};

export const accessRowToEntry = (row: AccessActivityRow): AgentActivityEntry => {
  const allowed = row.outcome === 'allowed';
  const kind: AgentActivityKind = allowed ? 'read' : 'denied';
  const actionLabel = allowed ? (READ_LABELS[row.accessKind] ?? 'Čtení') : 'Čtení odmítnuto oprávněním';
  return {
    actionLabel,
    agentName: row.displayName,
    agentPrincipalId: row.principalId,
    id: `read:${row.dataAccessEventId}`,
    kind,
    moduleKey: row.servingModuleKey,
    moduleLabel: agentModuleLabel(row.servingModuleKey),
    occurredAt: row.occurredAt.toISOString(),
    outcomeCode: row.outcomeCode,
    ...(row.targetResourceType === null ? {} : { detail: row.targetResourceType }),
  };
};

export const proposalRowToEntries = (
  row: AgentProposalRow,
  names: ReadonlyMap<string, string>,
): AgentActivityEntry[] => {
  const base = {
    agentName: row.agentLabel,
    agentPrincipalId: row.agentPrincipalId,
    moduleKey: row.moduleKey,
    moduleLabel: agentModuleLabel(row.moduleKey),
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
  if (row.decidedAt !== null) {
    const decider = nameOf(names, row.decidedByPrincipalId);
    entries.push({
      ...base,
      actionLabel: row.status === 'rejected' ? `Zamítnuto: ${decider}` : `Schváleno: ${decider}`,
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
