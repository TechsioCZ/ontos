// Generic "before -> after" lines for agent commands. A module builds the lines of its own commands with these
// helpers in its agent review read (see agent-review.ts); the platform only uses `agentCommandDiff` for modules
// that do not describe their commands themselves, with the field names from the module's MCP contribution.
import { Result, Schema } from 'effect';

import {
  AgentCommandSchema,
  AgentCommandSourceSchema,
  AgentCommandSourceValueSchema,
  agentCommandOf,
  isAgentCommandSourceNumber,
} from './agent-proposals.ts';
import type { AgentCommandSource, AgentCommandSourceValue, AgentDiffLine } from './agent-proposals.ts';

const isRecord = Schema.is(AgentCommandSourceSchema);
const isValues = Schema.is(Schema.Array(AgentCommandSourceValueSchema));
const isString = Schema.is(Schema.String);
const isBoolean = Schema.is(Schema.Boolean);
const CommandJsonSchema = Schema.fromJsonString(AgentCommandSchema);

/** The entry of `list` (wire array) whose `id` is `id`. */
export const agentEntryWithId = (list: AgentCommandSourceValue, id: string): AgentCommandSource | undefined => {
  const entries = isValues(list) ? list : [];
  const found = entries.find((entry) => isRecord(entry) && entry['id'] === id);
  return isRecord(found) ? found : undefined;
};

const czk = new Intl.NumberFormat('cs-CZ', { currency: 'CZK', style: 'currency' });
const number = new Intl.NumberFormat('cs-CZ');

/** 349000 -> „3 490,00 Kč“. */
export const formatAgentMoneyMinor = (minor: number): string => czk.format(minor / 100);

/** How a module shows its own field values: Czech names of enum values and which numbers are money. */
export interface AgentDiffValueOptions {
  /** Fields whose number is an amount in minor units (haléře). */
  readonly moneyFields?: ReadonlySet<string>;
  /** Czech text per wire value, by field, e.g. `{ state: { DONE: 'Hotovo' } }`. */
  readonly valueLabels?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const isoDate = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const recordReferenceText = (resourceId: string): string => `záznam ${resourceId.slice(0, 8)}…`;
type DiffLineDraft = { -readonly [Key in keyof AgentDiffLine]: AgentDiffLine[Key] };

const agentStringDiffValue = (field: string, value: string, options: AgentDiffValueOptions): string => {
  const label = options.valueLabels?.[field]?.[value];
  if (label !== undefined) {
    return label;
  }
  if (uuid.test(value)) {
    // A bare reference id says nothing to a person; the card title names the record.
    return recordReferenceText(value);
  }
  const date = isoDate.exec(value)?.groups;
  return date === undefined ? value : `${Number(date['day'])}. ${Number(date['month'])}. ${date['year']}`;
};

/** Readable Czech text of one wire value; undefined for empty values. */
export const agentDiffValue = (
  field: string,
  value: AgentCommandSourceValue,
  options: AgentDiffValueOptions = {},
): string | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (isString(value)) {
    return agentStringDiffValue(field, value, options);
  }
  if (isBoolean(value)) {
    return value === true ? 'Ano' : 'Ne';
  }
  if (isAgentCommandSourceNumber(value)) {
    return options.moneyFields?.has(field) === true ? formatAgentMoneyMinor(value) : number.format(value);
  }
  if (isValues(value)) {
    return value.length === 0 ? undefined : `${value.length} položek`;
  }
  if (isRecord(value) && isString(value['resourceId'])) {
    return recordReferenceText(value['resourceId']);
  }
  // Command-source normalization makes the encoded JSON total for this declared value domain.
  return isRecord(value) ? Result.getOrThrow(Schema.encodeResult(CommandJsonSchema)(agentCommandOf(value))) : undefined;
};

/** One line; empty values are left out (absent before = new value, absent after = cleared). */
export const agentDiffLine = (
  field: string,
  label: string,
  before: AgentCommandSourceValue,
  after: AgentCommandSourceValue,
  options: AgentDiffValueOptions = {},
): AgentDiffLine => {
  const beforeText = agentDiffValue(field, before, options);
  const afterText = agentDiffValue(field, after, options);
  const line: DiffLineDraft = { field, label };
  if (beforeText !== undefined) {
    line.before = beforeText;
  }
  if (afterText !== undefined) {
    line.after = afterText;
  }
  return line;
};

/** One line per field of `fields` (except `skip` and `_tag`), `before` taken from the same key of the record. */
export const agentFieldLines = (
  fields: AgentCommandSource,
  labels: Readonly<Record<string, string>>,
  before: AgentCommandSource | undefined,
  skip: ReadonlySet<string>,
  options: AgentDiffValueOptions = {},
): AgentDiffLine[] =>
  Object.entries(fields).flatMap(([key, value]) =>
    skip.has(key) || key === '_tag' ? [] : [agentDiffLine(key, labels[key] ?? key, before?.[key], value, options)],
  );

/** Does `actual` still hold every value of `expected` (objects compared by the keys of `expected`)? */
export const agentRecordHolds = (expected: AgentCommandSourceValue, actual: AgentCommandSourceValue): boolean => {
  if (expected === null || expected === undefined) {
    return actual === null || actual === undefined;
  }
  if (isValues(expected)) {
    return (
      isValues(actual) &&
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
const isMoneyField = (key: string): boolean => key === 'priceMinor' || key.endsWith('PriceMinor');
const MAX_COMMAND_TEXT = 200;
const isEmptyValue = (value: AgentCommandSourceValue): boolean =>
  value === undefined || value === null || value === '' || (isValues(value) && value.length === 0);

/**
 * Lines for modules that do not describe their commands: one line per filled field of the stored command, `after`
 * only, labelled with the module's own field names (`labels`, from its MCP contribution). The platform does not read
 * these records, so there is no `before`. Empty when the command has no plain fields.
 */
export const agentCommandDiff = (
  command: AgentCommandSource,
  labels: Readonly<Record<string, string>>,
): readonly AgentDiffLine[] =>
  Object.entries(command)
    .flatMap(([key, value]) => {
      const entries: (readonly [string, AgentCommandSourceValue])[] =
        COMMAND_FLATTEN.has(key) && isRecord(value) ? Object.entries(value) : [[key, value]];
      return entries.filter(([entryKey, entryValue]) => !COMMAND_SKIP.has(entryKey) && !isEmptyValue(entryValue));
    })
    .slice(0, 60)
    .map(([key, value]) => {
      const text = agentDiffValue(key, value, isMoneyField(key) ? { moneyFields: new Set([key]) } : {}) ?? '';
      return {
        after: text.length > MAX_COMMAND_TEXT ? `${text.slice(0, MAX_COMMAND_TEXT - 1)}…` : text,
        field: key.slice(0, 300),
        label: (labels[key] ?? key).slice(0, 300),
      };
    });
