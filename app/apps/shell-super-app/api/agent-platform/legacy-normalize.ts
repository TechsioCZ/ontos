import type {
  AgentApprovalModule,
  AgentDiffLine,
  AgentItemStatus,
  AgentQueueBatch,
  AgentQueueItem,
  AgentRisk,
} from '@app/shared-contracts/agent-proposals';

type Rec = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const legacyStatuses: readonly AgentItemStatus[] = ['pending', 'applied', 'rejected', 'failed', 'reverted'];
const legacyRisks: readonly AgentRisk[] = ['low', 'medium', 'high'];

const CONTACT_FIELDS = [
  ['name', 'Jméno'],
  ['email', 'E-mail'],
  ['phone', 'Telefon'],
  ['role', 'Role'],
  ['primary', 'Hlavní kontakt'],
  ['note', 'Poznámka'],
] as const;

export const legacyBatchKey = (appId: string, batchId: string) => `legacy:${appId}:${batchId}`;

export const legacyItemKey = (appId: string, changeId: string) => `legacy:${appId}:${changeId}`;

/** Splits `legacy:<appId>:<id>`; the id may itself contain colons. */
export const parseLegacyKey = (key: string): { readonly appId: string; readonly id: string } | undefined => {
  if (!key.startsWith('legacy:')) return undefined;
  const rest = key.slice('legacy:'.length);
  const separator = rest.indexOf(':');
  if (separator <= 0) return undefined;
  const id = rest.slice(separator + 1);
  return id === '' ? undefined : { appId: rest.slice(0, separator), id };
};

/** Finds the `aiChanges` slice in a records response: top-level (sales, merchandise) or under `state` (CRM). */
export const sliceFromRecords = (body: unknown): unknown => {
  if (!isRecord(body)) return undefined;
  if (body['aiChanges'] !== undefined) return body['aiChanges'];
  return isRecord(body['state']) ? body['state']['aiChanges'] : undefined;
};

const diffLinesOf = (raw: unknown): AgentDiffLine[] => {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((line): AgentDiffLine[] => {
    if (!isRecord(line)) return [];
    const field = text(line['field']);
    const label = text(line['label']);
    if (field === undefined || label === undefined) return [];
    const before = text(line['before']);
    const after = text(line['after']);
    return [
      {
        field,
        label,
        ...(before === undefined ? {} : { before }),
        ...(after === undefined ? {} : { after }),
      },
    ];
  });
};

/** Copy of the CRM `newClientContactsDiff` so CreateClient proposals read per contact. */
const createClientContactLines = (contacts: readonly unknown[]): AgentDiffLine[] => {
  const firstPrimary = contacts.findIndex((contact) => isRecord(contact) && contact['primary'] === true);
  return contacts.flatMap((contact, index): AgentDiffLine[] => {
    const record: Rec = isRecord(contact) ? contact : {};
    return CONTACT_FIELDS.flatMap(([field, label]): AgentDiffLine[] => {
      const raw = record[field];
      const value = field === 'primary' ? (index === firstPrimary ? 'ano' : 'ne') : raw;
      return typeof value !== 'string' || value === ''
        ? []
        : [{ after: value, field: `contacts.${index}.${field}`, label: `Kontakt ${index + 1} · ${label}` }];
    });
  });
};

const diffOfChange = (change: Rec): AgentDiffLine[] => {
  const diff = diffLinesOf(change['diff']);
  const operation = change['operation'];
  const contacts = isRecord(operation) ? operation['contacts'] : undefined;
  if (!isRecord(operation) || operation['_tag'] !== 'CreateClient' || !Array.isArray(contacts)) return diff;
  if (diff.some((line) => line.field.startsWith('contacts.'))) return diff;
  return [
    ...diff.filter((line) => line.field !== 'contacts'),
    ...createClientContactLines(contacts as readonly unknown[]),
  ];
};

const itemOf = (
  module: AgentApprovalModule,
  change: Rec,
  options: { readonly canDecide: boolean; readonly names: ReadonlyMap<string, string> },
): AgentQueueItem | undefined => {
  const id = text(change['id']);
  const summary = text(change['summary']);
  const target = change['target'];
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
  return {
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
    ...(decidedAt === undefined ? {} : { decidedAt }),
    ...(decidedBy === undefined ? {} : { decidedByName: options.names.get(decidedBy) ?? 'Neznámý uživatel' }),
    ...(decisionNote === undefined ? {} : { decisionNote }),
    ...(failure === undefined ? {} : { failure }),
  };
};

/** Turns one module's legacy `aiChanges` slice into queue batches. Malformed entries are skipped. */
export const normalizeLegacySlice = (
  module: AgentApprovalModule,
  slice: unknown,
  options: { readonly canDecide: boolean; readonly names: ReadonlyMap<string, string> },
): AgentQueueBatch[] => {
  if (!isRecord(slice)) return [];
  const rawBatches: readonly unknown[] = Array.isArray(slice['batches']) ? slice['batches'] : [];
  const rawChanges: readonly unknown[] = Array.isArray(slice['changes']) ? slice['changes'] : [];
  const changes = rawChanges.filter(isRecord);
  const batches = rawBatches.flatMap((raw): AgentQueueBatch[] => {
    if (!isRecord(raw)) return [];
    const id = text(raw['id']);
    const agentLabel = text(raw['agentLabel']);
    const agentPrincipalId = text(raw['agentPrincipalId']);
    const createdAt = text(raw['createdAt']);
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
    const items = changes
      .filter((change) => change['batchId'] === id)
      .flatMap((change): AgentQueueItem[] => {
        const item = itemOf(module, change, options);
        return item === undefined ? [] : [item];
      });
    const revertedAt = text(raw['revertedAt']);
    const revertedBy = text(raw['revertedBy']);
    const revertNote = text(raw['revertNote']);
    return [
      {
        agentLabel,
        agentPrincipalId,
        batchId: id,
        canRevertAll:
          revertedAt === undefined && options.canDecide && items.some((item) => item.status === 'applied'),
        createdAt,
        instruction,
        items,
        key: legacyBatchKey(module.appId, id),
        moduleLabels: [module.label],
        source: 'legacy',
        ...(revertedAt === undefined ? {} : { revertedAt }),
        ...(revertedBy === undefined ? {} : { revertedByName: options.names.get(revertedBy) ?? 'Neznámý uživatel' }),
        ...(revertNote === undefined ? {} : { revertNote }),
      },
    ];
  });
  return batches.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
};
