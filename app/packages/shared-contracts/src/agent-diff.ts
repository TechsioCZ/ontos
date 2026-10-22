// Generic "before -> after" lines for agent commands. A module builds the lines of its own commands with these
// helpers in its agent review read (see agent-review.ts); the platform only uses `agentCommandDiff` for modules
// that do not describe their commands themselves.
import type { AgentCommand, AgentDiffLine } from './agent-proposals.ts';

type Rec = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The entry of `list` (wire array) whose `id` is `id`. */
export const agentEntryWithId = (list: unknown, id: string): Rec | undefined => {
  const entries: readonly unknown[] = Array.isArray(list) ? list : [];
  const found = entries.find((entry) => isRecord(entry) && entry['id'] === id);
  return isRecord(found) ? found : undefined;
};

const czk = new Intl.NumberFormat('cs-CZ', { currency: 'CZK', style: 'currency' });
const number = new Intl.NumberFormat('cs-CZ');

/** 349000 -> „3 490,00 Kč“. */
export const formatAgentMoneyMinor = (minor: number): string => czk.format(minor / 100);

/** How a module shows its own field values: Czech names of enum values and which numbers are money. */
export interface AgentDiffValueOptions {
  /** Czech text per wire value, by field, e.g. `{ state: { DONE: 'Hotovo' } }`. */
  readonly valueLabels?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Fields whose number is an amount in minor units (haléře). */
  readonly moneyFields?: ReadonlySet<string>;
}

const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Readable Czech text of one wire value; undefined for empty values. */
export const agentDiffValue = (field: string, value: unknown, options: AgentDiffValueOptions = {}): string | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const labels = options.valueLabels?.[field];
  if (typeof value === 'string' && labels?.[value] !== undefined) {
    return labels[value];
  }
  if (typeof value === 'boolean') {
    return value ? 'Ano' : 'Ne';
  }
  if (typeof value === 'number') {
    return options.moneyFields?.has(field) === true ? formatAgentMoneyMinor(value) : number.format(value);
  }
  if (typeof value === 'string' && uuid.test(value)) {
    // A bare reference id says nothing to a person; the card title names the record.
    return `záznam ${value.slice(0, 8)}…`;
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

/** One line; empty values are left out (absent before = new value, absent after = cleared). */
export const agentDiffLine = (
  field: string,
  label: string,
  before: unknown,
  after: unknown,
  options: AgentDiffValueOptions = {},
): AgentDiffLine => {
  const beforeText = agentDiffValue(field, before, options);
  const afterText = agentDiffValue(field, after, options);
  return {
    field,
    label,
    ...(beforeText === undefined ? {} : { before: beforeText }),
    ...(afterText === undefined ? {} : { after: afterText }),
  };
};

/** One line per field of `fields` (except `skip` and `_tag`), `before` taken from the same key of the record. */
export const agentFieldLines = (
  fields: Rec,
  labels: Readonly<Record<string, string>>,
  before: Rec | undefined,
  skip: ReadonlySet<string>,
  options: AgentDiffValueOptions = {},
): AgentDiffLine[] =>
  Object.entries(fields)
    .filter(([key]) => !skip.has(key) && key !== '_tag')
    .map(([key, value]) => agentDiffLine(key, labels[key] ?? key, before?.[key], value, options));

/** Does `actual` still hold every value of `expected` (objects compared by the keys of `expected`)? */
export const agentRecordHolds = (expected: unknown, actual: unknown): boolean => {
  if (expected === null || expected === undefined) {
    return actual === null || actual === undefined;
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => agentRecordHolds(item, actual[index]))
    );
  }
  if (isRecord(expected)) {
    return isRecord(actual) && Object.entries(expected).every(([key, value]) => agentRecordHolds(value, actual[key]));
  }
  return expected === actual;
};

// `id` names the record the command changes; the card's title already says which record that is.
const COMMAND_SKIP: ReadonlySet<string> = new Set(['_tag', 'expectedRevision', 'id', 'idempotencyKey']);
/** Nested objects whose fields are the change itself (`UpdateX { id, patch: {...} }`), listed field by field. */
const COMMAND_FLATTEN: ReadonlySet<string> = new Set(['changes', 'fields', 'patch']);
/** Czech names of common command fields. */
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
  regNo: 'IČO',
  segment: 'Segment',
  vatNo: 'DIČ',
  website: 'Web',
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
const isMoneyField = (key: string): boolean => key === 'priceMinor' || key.endsWith('PriceMinor');
const MAX_COMMAND_TEXT = 200;
const isEmptyValue = (value: unknown): boolean =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

/**
 * Lines for modules that do not describe their commands: one line per filled field of the stored command, `after`
 * only. The platform does not read these records, so there is no `before`. Empty when the command has no plain fields.
 */
export const agentCommandDiff = (command: AgentCommand): readonly AgentDiffLine[] =>
  Object.entries(command)
    .flatMap(([key, value]): (readonly [string, unknown])[] =>
      COMMAND_FLATTEN.has(key) && isRecord(value) ? Object.entries(value) : [[key, value]],
    )
    .filter(([key, value]) => !COMMAND_SKIP.has(key) && !isEmptyValue(value))
    .slice(0, 60)
    .map(([key, value]) => {
      const text = agentDiffValue(key, value, isMoneyField(key) ? { moneyFields: new Set([key]) } : {}) ?? '';
      return {
        after: text.length > MAX_COMMAND_TEXT ? `${text.slice(0, MAX_COMMAND_TEXT - 1)}…` : text,
        field: key.slice(0, 300),
        label: (COMMAND_LABELS[key] ?? key).slice(0, 300),
      };
    });
