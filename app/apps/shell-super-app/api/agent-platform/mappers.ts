/**
 * Pure mappers from core.agent_proposals rows and audit/access rows to the platform queue and activity domain values.
 * No database imports: the proposal store feeds these functions.
 */
import {
  AGENT_REVERT_UNAVAILABLE,
  AGENT_PAGE_SIZE,
  AgentAppIdSchema,
  AgentActivityIdSchema,
  AgentBatchIdSchema,
  AgentBatchKeySchema,
  AgentItemKeySchema,
  AgentResourceIdSchema,
  AgentResourceTypeSchema,
  AgentActionInvocationIdSchema,
  AgentActivityEntrySchema,
  AgentActivityResponseSchema,
  AgentModuleKeySchema,
  AgentPageCursorSchema,
  AgentPrincipalIdSchema,
  AgentProposalReferenceSchema,
  AgentQueueBatchSchema,
  AgentQueueItemSchema,
  AgentRecordReferenceSchema,
  compareAgentPage,
  afterAgentCursor,
} from '@app/shared-contracts/agent-proposals';
import type {
  AgentActivityEntry,
  AgentActivityKind,
  AgentActivityRequest,
  AgentActivityResponse,
  AgentCommand,
  AgentDiffLine,
  AgentItemStatus,
  AgentQueueBatch,
  AgentQueueItem,
  AgentRevertPlan,
  AgentRisk,
} from '@app/shared-contracts/agent-proposals';
import { agentCommandDiff } from '@app/shared-contracts/agent-diff';
import type { AgentReviewItem } from '@app/shared-contracts/agent-review';
import { DateTime, Option } from 'effect';
import type { Schema } from 'effect';

import { czechModuleFailure, isGenericProblemText } from './approval-logic.ts';

export interface AgentProposalRow {
  readonly actionSlug: string;
  readonly agentLabel: string;
  readonly agentPrincipalId: string;
  readonly appId: string;
  readonly appliedAt: Date | null;
  readonly applyResult: Schema.Json;
  readonly batchId: string;
  readonly batchInstruction: string;
  readonly batchRevertedAt: Date | null;
  readonly batchRevertedByPrincipalId: string | null;
  readonly batchRevertNote: string | null;
  readonly command: AgentCommand;
  readonly createdAt: Date;
  readonly decidedAt: Date | null;
  readonly decidedByPrincipalId: string | null;
  readonly decisionNote: string | null;
  readonly diff: readonly AgentDiffLine[];
  readonly failure: string | null;
  readonly legalEntityId: string;
  readonly moduleKey: string;
  readonly position: number;
  readonly proposalId: string;
  readonly reason: string;
  readonly referenceAudiences: readonly string[];
  readonly revert: AgentRevertPlan | null;
  readonly revertedAt: Date | null;
  readonly revertedByPrincipalId: string | null;
  readonly risk: AgentRisk;
  readonly runId: string | null;
  readonly status: AgentItemStatus;
  readonly summary: string;
  readonly targetLabel: string;
  readonly tenantId: string;
}

export interface AuditActivityRow {
  readonly actionInvocationId?: string | null;
  readonly actionKey: string | null;
  readonly auditEventId: string;
  readonly displayName: string;
  readonly occurredAt: Date;
  readonly outcome: string;
  readonly outcomeCode: string;
  readonly principalId: string;
  readonly targetModuleKey?: string | null;
  readonly targetResourceId?: string | null;
  readonly targetResourceType?: string | null;
}

export interface AccessActivityRow {
  readonly accessKind: string;
  readonly dataAccessEventId: string;
  readonly displayName: string;
  readonly occurredAt: Date;
  readonly outcome: string;
  readonly outcomeCode: string;
  readonly principalId: string;
  readonly servingModuleKey: string;
  readonly targetResourceId?: string | null;
  readonly targetResourceType: string | null;
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
  readonly names: ReadonlyMap<string, string>;
  /** The module's review of a proposal, read as the person (undefined: the module has none or it did not answer). */
  readonly reviewOf?: (row: AgentProposalRow) => AgentReviewItem | undefined;
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
interface ItemDiff {
  readonly diff: readonly AgentDiffLine[];
  readonly diffSource: 'agent' | 'command' | 'platform';
}

export const itemDiff = (
  row: AgentProposalRow,
  review: AgentReviewItem | undefined,
  commandFieldLabels: Readonly<Record<string, string>>,
): ItemDiff => {
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
export const storedFailureText = (failure: string): string => {
  if (failure === 'Modul odpověděl chybou HTTP 200.') {
    return 'Modul neuvedl aktuální revizi záznamu, změna se proto neprovedla.';
  }
  return isGenericProblemText(failure) ? czechModuleFailure(failure) : failure;
};

const revertReasonOf = (row: AgentProposalRow, review: AgentReviewItem | undefined): string | undefined => {
  if (row.status === 'pending') {
    return review === undefined ? AGENT_REVERT_UNAVAILABLE : review.revertUnavailableReason;
  }
  if (row.revert === null) {
    return AGENT_REVERT_UNAVAILABLE;
  }
  return row.revert.kind === 'none' ? row.revert.reason : undefined;
};

const toItem = (row: AgentProposalRow, options: QueueItemOptions): AgentQueueItem => {
  const review = options.reviewOf?.(row);
  const revertUnavailableReason = revertReasonOf(row, review);
  const { diff, diffSource } = itemDiff(row, review, options.modules.commandFieldLabelsOf(row.appId));
  // A pending row with decided_at is only claimed by an approval in progress; it has no decision yet.
  const decided = row.status !== 'pending';
  const decision = options.canDecide(row);
  const liveName = row.status === 'pending' ? review?.targetName : undefined;
  // Agents often repeat the action name as the target; the record's own name says more.
  const targetLabel = row.targetLabel === row.summary && liveName !== undefined ? liveName : row.targetLabel;
  let item = AgentQueueItemSchema.make({
    appId: AgentAppIdSchema.make(row.appId),
    canDecide: decision.allowed,
    command: row.command,
    diff,
    diffSource,
    key: AgentItemKeySchema.make(`core:${row.proposalId}`),
    moduleKey: AgentModuleKeySchema.make(row.moduleKey),
    moduleLabel: options.modules.labelOf(row.moduleKey),
    proposedAt: DateTime.makeUnsafe(row.createdAt),
    reason: row.reason,
    risk: row.risk,
    status: row.status,
    summary: row.summary,
    targetLabel,
  });
  if (!decision.allowed && decision.reason !== undefined && row.status === 'pending') {
    item = { ...item, cannotDecideReason: decision.reason };
  }
  if (decided && row.decidedAt !== null) {
    item = { ...item, decidedAt: DateTime.makeUnsafe(row.decidedAt) };
  }
  if (decided && row.decidedByPrincipalId !== null) {
    item = { ...item, decidedByName: nameOf(options.names, row.decidedByPrincipalId) };
  }
  if (row.decisionNote !== null) {
    item = { ...item, decisionNote: row.decisionNote };
  }
  if (row.failure !== null) {
    item = { ...item, failure: storedFailureText(row.failure) };
  }
  if (revertUnavailableReason !== undefined) {
    item = { ...item, revertUnavailableReason };
  }
  return item;
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
    const items = batchRows.toSorted((a, b) => a.position - b.position).map((row) => toItem(row, options));
    const createdAt = DateTime.makeUnsafe(
      Math.min(...batchRows.map((row) => DateTime.toEpochMillis(DateTime.makeUnsafe(row.createdAt)))),
    );
    const canRevertAll =
      head.batchRevertedAt === null &&
      items.some((item) => item.status === 'applied' && item.revertUnavailableReason === undefined && item.canDecide);
    let batch = AgentQueueBatchSchema.make({
      agentLabel: head.agentLabel,
      agentPrincipalId: AgentPrincipalIdSchema.make(head.agentPrincipalId),
      batchId: AgentBatchIdSchema.make(head.batchId),
      canRevertAll,
      createdAt,
      instruction: head.batchInstruction,
      items,
      key: AgentBatchKeySchema.make(`core:${head.batchId}`),
      moduleLabels: [...new Set(items.map((item) => item.moduleLabel))],
      source: 'core',
    });
    if (head.batchRevertedAt !== null) {
      batch = { ...batch, revertedAt: DateTime.makeUnsafe(head.batchRevertedAt) };
    }
    if (head.batchRevertedByPrincipalId !== null) {
      batch = { ...batch, revertedByName: nameOf(options.names, head.batchRevertedByPrincipalId) };
    }
    if (head.batchRevertNote !== null) {
      batch = { ...batch, revertNote: head.batchRevertNote };
    }
    return batch;
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
  let kind: AgentActivityKind = 'failed';
  if (proposal) {
    kind = 'proposal';
  } else if (row.outcome === 'succeeded') {
    kind = 'write';
  } else if (row.outcome === 'denied') {
    kind = 'denied';
  }
  const actionLabels = {
    denied: 'Pokus o zápis odmítnut',
    failed: 'Zápis selhal',
    proposal: 'Návrh ke schválení',
    write: 'Zápis změny',
  };
  const actionLabel = actionLabels[kind];
  let detail: string | undefined;
  if (row.actionKey !== null && !row.actionKey.endsWith('.apply-command')) {
    detail = row.actionKey;
  } else if (proposal) {
    detail = `Návrh do schvalovací fronty modulu ${options.modules.labelOf(moduleKey)}`;
  }
  let entry = AgentActivityEntrySchema.make({
    actionLabel,
    agentName: row.displayName,
    agentPrincipalId: AgentPrincipalIdSchema.make(row.principalId),
    id: AgentActivityIdSchema.make(`audit:${row.auditEventId}`),
    kind,
    moduleKey: Option.map(Option.fromNullOr(moduleKey), (value) => AgentModuleKeySchema.make(value)),
    moduleLabel: options.modules.labelOf(moduleKey),
    occurredAt: DateTime.makeUnsafe(row.occurredAt),
    outcomeCode: proposal ? 'proposed' : row.outcomeCode,
  });
  if (row.actionInvocationId !== null && row.actionInvocationId !== undefined) {
    entry = { ...entry, actionInvocationId: AgentActionInvocationIdSchema.make(row.actionInvocationId) };
  }
  if (
    row.targetResourceId !== null &&
    row.targetResourceId !== undefined &&
    row.targetResourceType !== null &&
    row.targetResourceType !== undefined
  ) {
    entry = {
      ...entry,
      recordReference: AgentRecordReferenceSchema.make({
        resourceId: AgentResourceIdSchema.make(row.targetResourceId),
        resourceType: AgentResourceTypeSchema.make(row.targetResourceType),
      }),
    };
  }
  if (detail !== undefined) {
    entry = { ...entry, detail };
  }
  return entry;
};

const READ_LABELS = new Map([
  ['download', 'Stažení souboru'],
  ['export', 'Export dat'],
  ['list', 'Čtení seznamu'],
  ['read', 'Čtení záznamu'],
  ['search', 'Vyhledávání'],
]);

export const accessRowToEntry = (row: AccessActivityRow, modules: ModuleTexts): AgentActivityEntry => {
  const allowed = row.outcome === 'allowed';
  const kind: AgentActivityKind = allowed ? 'read' : 'denied';
  const actionLabel = allowed ? (READ_LABELS.get(row.accessKind) ?? 'Čtení') : 'Čtení odmítnuto oprávněním';
  let entry = AgentActivityEntrySchema.make({
    actionLabel,
    agentName: row.displayName,
    agentPrincipalId: AgentPrincipalIdSchema.make(row.principalId),
    id: AgentActivityIdSchema.make(`read:${row.dataAccessEventId}`),
    kind,
    moduleKey: Option.some(AgentModuleKeySchema.make(row.servingModuleKey)),
    moduleLabel: modules.labelOf(row.servingModuleKey),
    occurredAt: DateTime.makeUnsafe(row.occurredAt),
    outcomeCode: row.outcomeCode,
  });
  if (row.targetResourceId !== null && row.targetResourceId !== undefined && row.targetResourceType !== null) {
    entry = {
      ...entry,
      recordReference: AgentRecordReferenceSchema.make({
        resourceId: AgentResourceIdSchema.make(row.targetResourceId),
        resourceType: AgentResourceTypeSchema.make(row.targetResourceType),
      }),
    };
  }
  if (row.targetResourceType !== null) {
    entry = { ...entry, detail: row.targetResourceType };
  }
  return entry;
};

export const proposalRowToEntries = (
  row: AgentProposalRow,
  names: ReadonlyMap<string, string>,
  modules: ModuleTexts,
): AgentActivityEntry[] => {
  const recordReference = modules.recordReferenceOf?.(row.moduleKey, row.command);
  let base: Pick<
    AgentActivityEntry,
    'agentName' | 'agentPrincipalId' | 'moduleKey' | 'moduleLabel' | 'proposal' | 'recordReference'
  > = {
    agentName: row.agentLabel,
    agentPrincipalId: AgentPrincipalIdSchema.make(row.agentPrincipalId),
    moduleKey: Option.some(AgentModuleKeySchema.make(row.moduleKey)),
    moduleLabel: modules.labelOf(row.moduleKey),
    proposal: AgentProposalReferenceSchema.make({
      batchKey: AgentBatchKeySchema.make(`core:${row.batchId}`),
      itemKey: AgentItemKeySchema.make(`core:${row.proposalId}`),
    }),
  };
  if (recordReference !== undefined) {
    base = { ...base, recordReference };
  }
  const entries: AgentActivityEntry[] = [
    AgentActivityEntrySchema.make({
      ...base,
      actionLabel: `Návrh: ${row.summary}`,
      detail: row.targetLabel,
      id: AgentActivityIdSchema.make(`proposal:${row.proposalId}`),
      kind: 'proposal',
      occurredAt: DateTime.makeUnsafe(row.createdAt),
      outcomeCode: 'proposed',
    }),
  ];
  if (row.decidedAt !== null && row.status !== 'pending') {
    const decider = nameOf(names, row.decidedByPrincipalId);
    let actionLabel = `Schváleno: ${decider}`;
    if (row.status === 'rejected') {
      actionLabel = `Zamítnuto: ${decider}`;
    } else if (row.status === 'failed') {
      actionLabel = `Schváleno, ale nešlo provést: ${decider}`;
    }
    entries.push(
      AgentActivityEntrySchema.make({
        ...base,
        actionLabel,
        detail: row.summary,
        id: AgentActivityIdSchema.make(`decision:${row.proposalId}`),
        kind: 'decision',
        occurredAt: DateTime.makeUnsafe(row.decidedAt),
        outcomeCode: row.status,
      }),
    );
  }
  if (row.revertedAt !== null) {
    entries.push(
      AgentActivityEntrySchema.make({
        ...base,
        actionLabel: `Vráceno: ${nameOf(names, row.revertedByPrincipalId)}`,
        detail: row.summary,
        id: AgentActivityIdSchema.make(`revert:${row.proposalId}`),
        kind: 'decision',
        occurredAt: DateTime.makeUnsafe(row.revertedAt),
        outcomeCode: 'reverted',
      }),
    );
  }
  return entries;
};

export const buildActivityResponse = (
  entries: readonly AgentActivityEntry[],
  request: AgentActivityRequest,
): AgentActivityResponse => {
  const sorted = entries.toSorted((a, b) =>
    compareAgentPage(
      AgentPageCursorSchema.make({
        at: AgentPageCursorSchema.fields.at.make(DateTime.formatIso(a.occurredAt)),
        id: AgentPageCursorSchema.fields.id.make(a.id),
      }),
      AgentPageCursorSchema.make({
        at: AgentPageCursorSchema.fields.at.make(DateTime.formatIso(b.occurredAt)),
        id: AgentPageCursorSchema.fields.id.make(b.id),
      }),
    ),
  );

  const agentNames = new Map<string, string>();
  for (const entry of sorted) {
    if (!agentNames.has(entry.agentPrincipalId)) {
      agentNames.set(entry.agentPrincipalId, entry.agentName);
    }
  }
  const agents = [...agentNames]
    .map(([principalId, name]) => ({ name, principalId: AgentPrincipalIdSchema.make(principalId) }))
    .toSorted((a, b) => a.name.localeCompare(b.name, 'cs'));

  const moduleLabels = new Map<string, string>();
  for (const entry of sorted) {
    if (Option.isSome(entry.moduleKey) && !moduleLabels.has(entry.moduleKey.value)) {
      moduleLabels.set(entry.moduleKey.value, entry.moduleLabel);
    }
  }
  const modules = [...moduleLabels]
    .map(([moduleKey, label]) => ({ label, moduleKey: AgentModuleKeySchema.make(moduleKey) }))
    .toSorted((a, b) => a.label.localeCompare(b.label, 'cs'));

  const filtered = sorted.filter(
    (entry) =>
      afterAgentCursor(
        AgentPageCursorSchema.make({
          at: AgentPageCursorSchema.fields.at.make(DateTime.formatIso(entry.occurredAt)),
          id: AgentPageCursorSchema.fields.id.make(entry.id),
        }),
        request.cursor,
      ) &&
      (request.agentPrincipalId === undefined || entry.agentPrincipalId === request.agentPrincipalId) &&
      (request.moduleKey === undefined || Option.contains(entry.moduleKey, request.moduleKey)) &&
      (request.kind === undefined || entry.kind === request.kind),
  );

  const limit = request.limit ?? AGENT_PAGE_SIZE;
  const page = filtered.slice(0, limit);
  const last = page.at(-1);
  const result = { agents, entries: page, modules };
  return AgentActivityResponseSchema.make(
    filtered.length > limit && last !== undefined
      ? {
          ...result,
          nextCursor: AgentPageCursorSchema.make({
            at: AgentPageCursorSchema.fields.at.make(DateTime.formatIso(last.occurredAt)),
            id: AgentPageCursorSchema.fields.id.make(last.id),
          }),
        }
      : result,
  );
};
