// Platform-built "before -> after" lines for agent commands the platform understands. The approval page shows these
// instead of the agent's own description, so a person approves exactly what the stored command will do. `before` is
// the wire JSON of the target entity read live (undefined for create commands or when it could not be read).
import type { AgentCommand, AgentDiffLine } from './agent-proposals.ts';

type Rec = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The entry of `list` (wire array) whose `id` is `id`. */
const entryWithId = (list: unknown, id: string): Rec | undefined => {
  const entries: readonly unknown[] = Array.isArray(list) ? list : [];
  const found = entries.find((entry) => isRecord(entry) && entry['id'] === id);
  return isRecord(found) ? found : undefined;
};

const czk = new Intl.NumberFormat('cs-CZ', { currency: 'CZK', style: 'currency' });
const number = new Intl.NumberFormat('cs-CZ');

/** 349000 -> „3 490,00 Kč“. */
export const formatAgentMoneyMinor = (minor: number): string => czk.format(minor / 100);

const TASK_STATES: Readonly<Record<string, string>> = {
  CANCELLED: 'Zrušeno',
  DONE: 'Hotovo',
  IN_PROGRESS: 'Rozpracováno',
  NEW: 'Nový',
  WAITING: 'Čeká',
};
const TASK_PRIORITIES: Readonly<Record<string, string>> = { HIGH: 'Vysoká', LOW: 'Nízká', NORMAL: 'Běžná' };

const TASK_LABELS: Readonly<Record<string, string>> = {
  archived: 'Archivováno',
  assigneeEmployeeId: 'Zaměstnanec',
  contextRefs: 'Souvislosti',
  description: 'Popis',
  dueDate: 'Termín',
  opportunityId: 'Obchodní případ',
  ownerPrincipalRef: 'Řešitel',
  partyId: 'Zákazník',
  plannedHours: 'Plánované hodiny',
  priority: 'Priorita',
  projectId: 'Projekt',
  state: 'Stav',
  title: 'Název úkolu',
};

const PRODUCT_LABELS: Readonly<Record<string, string>> = {
  active: 'Aktivní v nabídce',
  category: 'Kategorie',
  description: 'Popis',
  lowStockThreshold: 'Hranice nízké zásoby',
  name: 'Název',
  priceMinor: 'Cena bez DPH',
  sku: 'Kód (SKU)',
  unit: 'Jednotka',
  vatRate: 'Sazba DPH',
};

const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** Readable Czech text of one wire value; undefined for empty values. */
const show = (field: string, value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (field === 'state' && typeof value === 'string') {
    return TASK_STATES[value] ?? value;
  }
  if (field === 'priority' && typeof value === 'string') {
    return TASK_PRIORITIES[value] ?? value;
  }
  if (typeof value === 'boolean') {
    return value ? 'Ano' : 'Ne';
  }
  if (typeof value === 'number') {
    return field.endsWith('PriceMinor') || field === 'priceMinor' ? formatAgentMoneyMinor(value) : number.format(value);
  }
  if (typeof value === 'string') {
    const date = isoDate.exec(value);
    return date === null ? value : `${Number(date[3])}. ${Number(date[2])}. ${date[1]}`;
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? undefined : `${value.length} položek`;
  }
  if (isRecord(value) && typeof value['resourceId'] === 'string') {
    return `záznam ${value['resourceId'].slice(0, 8)}…`;
  }
  return JSON.stringify(value);
};

const line = (field: string, label: string, before: unknown, after: unknown): AgentDiffLine => {
  const beforeText = show(field, before);
  const afterText = show(field, after);
  return {
    field,
    label,
    ...(beforeText === undefined ? {} : { before: beforeText }),
    ...(afterText === undefined ? {} : { after: afterText }),
  };
};

const fieldLines = (
  fields: Rec,
  labels: Readonly<Record<string, string>>,
  before: Rec | undefined,
  skip: ReadonlySet<string>,
): AgentDiffLine[] =>
  Object.entries(fields)
    .filter(([key]) => !skip.has(key) && key !== '_tag')
    .map(([key, value]) => line(key, labels[key] ?? key, before?.[key], value));

const TASK_SKIP: ReadonlySet<string> = new Set(['taskRef']);

const taskDiff = (command: AgentCommand, before: Rec | undefined): AgentDiffLine[] | undefined => {
  switch (command['_tag']) {
    case 'CreateTask': {
      return fieldLines(command, TASK_LABELS, undefined, TASK_SKIP);
    }
    case 'UpdateTask':
    case 'ChangeTaskState':
    case 'AssignTask':
    case 'SetTaskArchived': {
      return fieldLines(command, TASK_LABELS, before, TASK_SKIP);
    }
    default: {
      return undefined;
    }
  }
};

const merchandiseDiff = (command: AgentCommand, before: Rec | undefined): AgentDiffLine[] | undefined => {
  switch (command['_tag']) {
    case 'ChangePrice': {
      const { variantId } = command;
      if (typeof variantId === 'string') {
        const variant = entryWithId(before?.['variants'], variantId);
        return [line('priceMinor', 'Cena varianty bez DPH', variant?.['priceMinor'], command['priceMinor'])];
      }
      return [line('priceMinor', 'Cena bez DPH', before?.['currentPriceMinor'], command['priceMinor'])];
    }
    case 'UpdateProduct': {
      const { patch } = command;
      return isRecord(patch) ? fieldLines(patch, PRODUCT_LABELS, before, new Set()) : undefined;
    }
    case 'CreateProduct': {
      return fieldLines(command, PRODUCT_LABELS, undefined, new Set(['id']));
    }
    default: {
      return undefined;
    }
  }
};

/**
 * Lines built from the command itself (after) and the live entity (before). Undefined when the platform does not
 * understand the command; the page then shows the agent's own description with a warning.
 */
export const agentPlatformDiff = (
  appId: string,
  command: AgentCommand,
  before: Rec | undefined,
): readonly AgentDiffLine[] | undefined => {
  switch (appId) {
    case 'work-tasks': {
      return taskDiff(command, before);
    }
    case 'merchandise': {
      return merchandiseDiff(command, before);
    }
    default: {
      return undefined;
    }
  }
};

const COMMAND_SKIP: ReadonlySet<string> = new Set(['_tag', 'expectedRevision', 'idempotencyKey']);
const COMMAND_LABELS: Readonly<Record<string, string>> = {
  address: 'Adresa',
  amountMinor: 'Částka',
  assetId: 'Majetek',
  assignee: 'Řešitel',
  budgetCategory: 'Rozpočtová kategorie',
  category: 'Kategorie',
  city: 'Město',
  contractRef: 'Smlouva',
  costCenter: 'Nákladové středisko',
  currency: 'Měna',
  date: 'Datum',
  description: 'Popis',
  documentKind: 'Druh dokladu',
  documentRef: 'Dokument',
  dueDate: 'Termín',
  email: 'E-mail',
  endDate: 'Konec',
  eventId: 'Událost',
  expectedCloseDate: 'Předpokládané uzavření',
  groupRef: 'Skupina',
  handoff: 'Požadavek',
  invoiceRef: 'Faktura',
  issueDate: 'Datum vystavení',
  kind: 'Druh',
  lifecycleState: 'Stav',
  lines: 'Položky',
  membershipCriteria: 'Kritéria členství',
  meterId: 'Měřidlo',
  name: 'Název',
  note: 'Poznámka',
  partyId: 'Zákazník',
  phone: 'Telefon',
  priceMinor: 'Cena bez DPH',
  probability: 'Pravděpodobnost',
  propertyRef: 'Nemovitost',
  purpose: 'Účel',
  reason: 'Důvod',
  record: 'Záznam',
  responsible: 'Odpovědná osoba',
  serialNumber: 'Výrobní číslo',
  stage: 'Fáze',
  startDate: 'Začátek',
  state: 'Stav',
  status: 'Stav',
  street: 'Ulice',
  taskRef: 'Úkol',
  title: 'Název',
  toStage: 'Nová fáze',
  unitRef: 'Jednotka',
  value: 'Hodnota',
};
const MAX_COMMAND_TEXT = 200;
const isEmptyValue = (value: unknown): boolean =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

/**
 * Lines for modules without their own diff: one line per filled field of the stored command, `after` only. The
 * platform does not read these records, so there is no `before`. Empty when the command has no plain fields.
 */
export const agentCommandDiff = (command: AgentCommand): readonly AgentDiffLine[] =>
  Object.entries(command)
    .filter(([key, value]) => !COMMAND_SKIP.has(key) && !isEmptyValue(value))
    .slice(0, 60)
    .map(([key, value]) => {
      const text = show(key, value) ?? '';
      return {
        after: text.length > MAX_COMMAND_TEXT ? `${text.slice(0, MAX_COMMAND_TEXT - 1)}…` : text,
        field: key.slice(0, 300),
        label: (COMMAND_LABELS[key] ?? key).slice(0, 300),
      };
    });

/** Does `actual` still hold every value of `expected` (objects compared by the keys of `expected`)? */
const holds = (expected: unknown, actual: unknown): boolean => {
  if (expected === null || expected === undefined) {
    return actual === null || actual === undefined;
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => holds(item, actual[index]))
    );
  }
  if (isRecord(expected)) {
    return isRecord(actual) && Object.entries(expected).every(([key, value]) => holds(value, actual[key]));
  }
  return expected === actual;
};

/**
 * Before „Vrátit vše“: does the record still hold what the approved command set? `false` means someone changed it
 * since, so the undo would overwrite their edit. Undefined when there is nothing to compare (create commands).
 */
export const agentChangeStillInPlace = (
  appId: string,
  command: AgentCommand,
  current: Rec | undefined,
): boolean | undefined => {
  const tag = command['_tag'];
  if (appId === 'merchandise' && tag === 'ChangePrice') {
    if (current === undefined) {
      return false;
    }
    const { variantId } = command;
    if (typeof variantId === 'string') {
      const variant = entryWithId(current['variants'], variantId);
      return variant !== undefined && variant['priceMinor'] === command['priceMinor'];
    }
    return current['currentPriceMinor'] === command['priceMinor'];
  }
  if (appId === 'merchandise' && tag === 'UpdateProduct') {
    return current !== undefined && holds(command['patch'], current);
  }
  if (appId === 'work-tasks' && (tag === 'UpdateTask' || tag === 'ChangeTaskState' || tag === 'AssignTask')) {
    if (current === undefined) {
      return false;
    }
    const { _tag: _ignored, taskRef: _ref, ...fields } = command;
    return Object.entries(fields).every(([key, value]) => holds(value, current[key]));
  }
  if (appId === 'property-leasing' && tag === 'SetRentTerms') {
    return current !== undefined && holds(command['rentTerms'], current['rentTerms']);
  }
  if (appId === 'property-leasing' && tag === 'UpdateDraft') {
    return current !== undefined && current['startDate'] === command['startDate'];
  }
  return undefined;
};
