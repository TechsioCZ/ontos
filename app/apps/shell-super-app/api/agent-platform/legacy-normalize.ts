import {
  AgentActionInvocationIdSchema,
  AgentActivityIdSchema,
  AgentBatchIdSchema,
  AgentPrincipalIdSchema,
  AgentResourceIdSchema,
  AgentResourceTypeSchema,
  AgentActivityEntrySchema,
  AgentCommandValueSchema,
  AgentBatchKeySchema,
  AgentItemKeySchema,
  AgentModuleKeySchema,
  AgentProposalReferenceSchema,
  AgentQueueBatchSchema,
  AgentQueueItemSchema,
  AgentRecordReferenceSchema,
} from '@app/shared-contracts/agent-proposals';
import type {
  AgentActivityEntry,
  AgentDiffLine,
  AgentItemStatus,
  AgentQueueBatch,
  AgentQueueItem,
  AgentRisk,
} from '@app/shared-contracts/agent-proposals';

import { DateTime, Option, Predicate, Schema } from 'effect';

import { parseLegacyKey } from '../../shared/proposal-key.ts';

import type { McpModule } from '../mcp/catalog.ts';

type Rec = Schema.JsonObject;

/** A composed module that keeps its own AI change engine (`aiChanges` in its records read). */
export interface LegacyEngineModule {
  readonly appId: string;
  /** Module page that shows these batches too; the queue links each batch there. */
  readonly approvalsPage?: AgentQueueBatch['modulePage'];
  readonly label: string;
  readonly moduleKey: string;
}

const isRecord = Schema.is(Schema.JsonObject);
const isValueArray = Schema.is(Schema.Array(AgentCommandValueSchema));

const text = (value: Schema.Json | undefined): string | undefined =>
  Schema.is(Schema.String)(value) ? value : undefined;

const legacyStatuses: readonly AgentItemStatus[] = ['pending', 'applied', 'rejected', 'failed', 'reverted'];
const legacyRisks: readonly AgentRisk[] = ['low', 'medium', 'high'];
const unknownUser = 'Neznámý uživatel';

const CONTACT_FIELDS = [
  ['name', 'Jméno'],
  ['email', 'E-mail'],
  ['phone', 'Telefon'],
  ['role', 'Role'],
  ['primary', 'Hlavní kontakt'],
  ['note', 'Poznámka'],
] as const;

export const legacyBatchKey = (appId: string, batchId: string) =>
  AgentBatchKeySchema.make(`legacy:${appId}:${batchId}`);

export const legacyItemKey = (appId: string, changeId: string) =>
  AgentItemKeySchema.make(`legacy:${appId}:${changeId}`);

/** Finds the `aiChanges` slice in a records response: top-level (sales, merchandise) or under `state` (CRM). */
export const sliceFromRecords = (body: Schema.Json | undefined): Schema.Json | undefined => {
  if (!isRecord(body)) {
    return undefined;
  }
  if (body['aiChanges'] !== undefined) {
    return body['aiChanges'];
  }
  return isRecord(body['state']) ? body['state']['aiChanges'] : undefined;
};

const diffLinesOf = (raw: Schema.Json | undefined): AgentDiffLine[] => {
  if (!isValueArray(raw)) {
    return [];
  }
  return raw.flatMap((line): AgentDiffLine[] => {
    if (!isRecord(line)) {
      return [];
    }
    const field = text(line['field']);
    const label = text(line['label']);
    if (field === undefined || label === undefined) {
      return [];
    }
    const before = text(line['before']);
    const after = text(line['after']);
    let result: AgentDiffLine = { field, label };
    if (before !== undefined) {
      result = { ...result, before };
    }
    if (after !== undefined) {
      result = { ...result, after };
    }
    return [result];
  });
};

/** Copy of the CRM `newClientContactsDiff` so CreateClient proposals read per contact. */
const createClientContactLines = (contacts: readonly Schema.Json[]): AgentDiffLine[] => {
  const firstPrimary = contacts.findIndex((contact) => isRecord(contact) && contact['primary'] === true);
  return contacts.flatMap((contact, index): AgentDiffLine[] => {
    const record: Rec = isRecord(contact) ? contact : {};
    return CONTACT_FIELDS.flatMap(([field, label]): AgentDiffLine[] => {
      const raw = record[field];
      let value = raw;
      if (field === 'primary') {
        value = index === firstPrimary ? 'ano' : 'ne';
      }
      return !Schema.is(Schema.String)(value) || value === ''
        ? []
        : [{ after: value, field: `contacts.${index}.${field}`, label: `Kontakt ${index + 1} · ${label}` }];
    });
  });
};

const diffOfChange = (change: Rec): AgentDiffLine[] => {
  const diff = diffLinesOf(change['diff']);
  const { operation } = change;
  const contacts = isRecord(operation) ? operation['contacts'] : undefined;
  if (!isRecord(operation) || !Predicate.isTagged(operation, 'CreateClient') || !isValueArray(contacts)) {
    return diff;
  }
  if (diff.some((line) => line.field.startsWith('contacts.'))) {
    return diff;
  }
  return [...diff.filter((line) => line.field !== 'contacts'), ...createClientContactLines(contacts)];
};

const itemOf = (
  module: LegacyEngineModule,
  change: Rec,
  options: { readonly canDecide: boolean; readonly names: ReadonlyMap<string, string> },
): AgentQueueItem | undefined => {
  const id = text(change['id']);
  const summary = text(change['summary']);
  const { target } = change;
  const targetLabel = isRecord(target) ? text(target['label']) : undefined;
  const proposedAt = text(change['proposedAt']);
  if (id === undefined || summary === undefined || targetLabel === undefined || proposedAt === undefined) {
    return undefined;
  }
  const status = legacyStatuses.find((entry) => entry === change['status']) ?? 'failed';
  const risk = legacyRisks.find((entry) => entry === change['risk']) ?? 'medium';
  const decidedAt = text(change['decidedAt']);
  const decidedBy = text(change['decidedBy']);
  const decisionNote = text(change['decisionNote']);
  const failure = text(change['failure']);
  let item: typeof AgentQueueItemSchema.Encoded = {
    appId: module.appId,
    canDecide: options.canDecide,
    diff: diffOfChange(change),
    key: legacyItemKey(module.appId, id),
    moduleKey: module.moduleKey,
    moduleLabel: module.label,
    proposedAt,
    reason: text(change['reason']) ?? '',
    risk,
    status,
    summary,
    targetLabel,
  };
  if (decidedAt !== undefined) {
    item = { ...item, decidedAt };
  }
  if (decidedBy !== undefined) {
    item = { ...item, decidedByName: options.names.get(decidedBy) ?? unknownUser };
  }
  if (decisionNote !== undefined) {
    item = { ...item, decisionNote };
  }
  if (failure !== undefined) {
    item = { ...item, failure };
  }
  return Option.getOrUndefined(Schema.decodeOption(AgentQueueItemSchema)(item));
};

/** Turns one module's legacy `aiChanges` slice into queue batches. Malformed entries are skipped. */
export const normalizeLegacySlice = (
  module: LegacyEngineModule,
  slice: Schema.Json | undefined,
  options: { readonly canDecide: boolean; readonly names: ReadonlyMap<string, string> },
): AgentQueueBatch[] => {
  if (!isRecord(slice)) {
    return [];
  }
  const rawBatches: readonly Schema.Json[] = isValueArray(slice['batches']) ? slice['batches'] : [];
  const rawChanges: readonly Schema.Json[] = isValueArray(slice['changes']) ? slice['changes'] : [];
  const changes = rawChanges.filter(isRecord);
  const batches = rawBatches.flatMap((raw): AgentQueueBatch[] => {
    if (!isRecord(raw)) {
      return [];
    }
    const id = text(raw['id']);
    const agentLabel = text(raw['agentLabel']);
    const agentPrincipalId = text(raw['agentPrincipalId']);
    const createdAt = Option.getOrUndefined(DateTime.make(text(raw['createdAt']) ?? ''));
    const instruction = text(raw['instruction']);
    if (
      id === undefined ||
      agentLabel === undefined ||
      agentPrincipalId === undefined ||
      createdAt === undefined ||
      instruction === undefined
    ) {
      return [];
    }
    const items = changes.flatMap((change): AgentQueueItem[] => {
      if (change['batchId'] !== id) {
        return [];
      }
      const item = itemOf(module, change, options);
      return item === undefined ? [] : [item];
    });
    const revertedAt = text(raw['revertedAt']);
    const revertedBy = text(raw['revertedBy']);
    const revertNote = text(raw['revertNote']);
    let batch = AgentQueueBatchSchema.make({
      agentLabel,
      agentPrincipalId: AgentPrincipalIdSchema.make(agentPrincipalId),
      batchId: AgentBatchIdSchema.make(id),
      canRevertAll: revertedAt === undefined && options.canDecide && items.some((item) => item.status === 'applied'),
      createdAt,
      instruction,
      items,
      key: legacyBatchKey(module.appId, id),
      moduleLabels: [module.label],
      source: 'legacy',
    });
    if (module.approvalsPage !== undefined) {
      batch = { ...batch, modulePage: module.approvalsPage };
    }
    if (revertedAt !== undefined) {
      const instant = Option.getOrUndefined(DateTime.make(revertedAt));
      if (instant === undefined) {
        return [];
      }
      batch = { ...batch, revertedAt: instant };
    }
    if (revertedBy !== undefined) {
      batch = { ...batch, revertedByName: options.names.get(revertedBy) ?? unknownUser };
    }
    if (revertNote !== undefined) {
      batch = { ...batch, revertNote };
    }
    return [batch];
  });
  return batches.toSorted(
    (left, right) => DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt),
  );
};

/** Actual module-owned proposal records, not a guessed correlation with a generic audit action. */
export const moduleActivityFromRecords = (
  module: LegacyEngineModule,
  body: Schema.Json | undefined,
  options: { readonly names: ReadonlyMap<string, string>; readonly recordLinks: McpModule['recordLinks'] },
): AgentActivityEntry[] => {
  const slice = sliceFromRecords(body);
  if (!isRecord(slice)) {
    return [];
  }
  const changes = isValueArray(slice['changes']) ? slice['changes'].filter(isRecord) : [];
  const logs = isValueArray(slice['log']) ? slice['log'].filter(isRecord) : [];
  return normalizeLegacySlice(module, slice, { canDecide: false, names: options.names }).flatMap((batch) =>
    batch.items.flatMap((item): AgentActivityEntry[] => {
      const changeId = parseLegacyKey(item.key)?.id;
      const change =
        changes.find((candidate) => candidate['id'] === changeId && candidate['batchId'] === batch.batchId) ?? {};
      const { target } = change;
      const kind = isRecord(target) ? text(target['kind']) : undefined;
      const resourceId = isRecord(target) ? text(target['id']) : undefined;
      const link = options.recordLinks?.find(
        (candidate) => candidate.proposalTargetKind !== undefined && candidate.proposalTargetKind === kind,
      );
      const proposedLog = logs.find(
        (log) => log['changeId'] === changeId && log['batchId'] === batch.batchId && log['action'] === 'proposed',
      );
      const actionInvocationId = proposedLog === undefined ? undefined : text(proposedLog['invocationId']);
      let base: Pick<
        AgentActivityEntry,
        'agentName' | 'agentPrincipalId' | 'moduleKey' | 'moduleLabel' | 'proposal' | 'recordReference'
      > = {
        agentName: batch.agentLabel,
        agentPrincipalId: batch.agentPrincipalId,
        moduleKey: Option.some(AgentModuleKeySchema.make(module.moduleKey)),
        moduleLabel: module.label,
        proposal: AgentProposalReferenceSchema.make({ batchKey: batch.key, itemKey: item.key }),
      };
      if (resourceId !== undefined && link !== undefined) {
        base = {
          ...base,
          recordReference: AgentRecordReferenceSchema.make({
            resourceId: AgentResourceIdSchema.make(resourceId),
            resourceType: AgentResourceTypeSchema.make(link.resourceType),
          }),
        };
      }
      let proposed = AgentActivityEntrySchema.make({
        ...base,
        actionLabel: `Návrh: ${item.summary}`,
        detail: item.targetLabel,
        id: AgentActivityIdSchema.make(`proposal:${item.key}`),
        kind: 'proposal',
        occurredAt: item.proposedAt,
        outcomeCode: 'proposed',
      });
      if (actionInvocationId !== undefined) {
        proposed = { ...proposed, actionInvocationId: AgentActionInvocationIdSchema.make(actionInvocationId) };
      }
      const entries: AgentActivityEntry[] = [proposed];
      if (item.decidedAt !== undefined && item.status !== 'pending') {
        const decider = item.decidedByName ?? unknownUser;
        let actionLabel = `Schváleno: ${decider}`;
        if (item.status === 'rejected') {
          actionLabel = `Zamítnuto: ${decider}`;
        } else if (item.status === 'failed') {
          actionLabel = `Schváleno, ale nešlo provést: ${decider}`;
        }
        entries.push(
          AgentActivityEntrySchema.make({
            ...base,
            actionLabel,
            detail: item.summary,
            id: AgentActivityIdSchema.make(`decision:${item.key}`),
            kind: 'decision',
            occurredAt: item.decidedAt,
            outcomeCode: item.status,
          }),
        );
      }
      const revertedAt = Option.getOrUndefined(DateTime.make(text(change['revertedAt']) ?? ''));
      if (revertedAt !== undefined) {
        const revertedBy = text(change['revertedBy']);
        entries.push(
          AgentActivityEntrySchema.make({
            ...base,
            actionLabel: `Vráceno: ${options.names.get(revertedBy ?? '') ?? unknownUser}`,
            detail: item.summary,
            id: AgentActivityIdSchema.make(`revert:${item.key}`),
            kind: 'decision',
            occurredAt: revertedAt,
            outcomeCode: 'reverted',
          }),
        );
      }
      return entries;
    }),
  );
};
