// Siampark provoz — per-record change history and per-record conflict detection (S00, S12, S15).
// Owned by ops-scaffold. Every agenda command is diffed generically on the ENCODED (JSON) state: the records the
// command touched (its `entityIds`) are found by `id` anywhere in the state tree and their scalar fields compared.
// Entries live in one extra `agenda_states` row (`agenda = 'change-log'`) per company, appended in the same
// transaction as the change itself, so history can never disagree with the stored data.
import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { Schema } from 'effect';
import { AgendaIdSchema } from './common.ts';

/** Row key of the change log in demo_siampark_ops.agenda_states (not an agenda; never decoded as one). */
export const CHANGE_LOG_ROW = 'change-log';
/** Oldest entries are dropped beyond this many per company. */
export const MAX_CHANGE_LOG_ENTRIES = 4000;
/** Longest stored before/after display value. */
const MAX_VALUE = 300;

export const FieldChangeSchema = Schema.Struct({
  /** Dotted path of the changed field, e.g. `contract.validTo`, `acquisitionValueMinor`, `lines` (array → count). */
  field: Schema.String,
  /** Display value before (absent = field was empty). Arrays are stored as `#<count>`. */
  before: Schema.optionalKey(Schema.String),
  after: Schema.optionalKey(Schema.String),
});
export type FieldChange = typeof FieldChangeSchema.Type;

export const ChangeEntrySchema = Schema.Struct({
  agenda: AgendaIdSchema,
  entityId: Schema.String,
  /** Command tag that made the change, e.g. `DocumentUpdate`. */
  command: Schema.String,
  /** `created` = record did not exist before; `changed` = scalar fields differ; `removed` = record disappeared. */
  kind: Schema.Literals(['created', 'changed', 'removed']),
  at: Schema.DateTimeUtcFromString,
  by: PrincipalRefSchema,
  changes: Schema.Array(FieldChangeSchema),
});
export type ChangeEntry = typeof ChangeEntrySchema.Type;
export type ChangeEntryEncoded = typeof ChangeEntrySchema.Encoded;

export const ChangeLogStateSchema = Schema.Struct({ entries: Schema.Array(ChangeEntrySchema) });

/** Audit and bookkeeping fields that every edit changes; they are shown separately, never as a "change". */
const ignoredFields = new Set(['createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'history', 'versions', 'edits']);

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
const isObject = (value: unknown): value is Readonly<Record<string, Json>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Finds the record with `id === id` in an encoded state tree: breadth-first, so a top-level record wins over a
 * nested reference to it (e.g. a document link `{ id, kind, label }` inside another document), and among equally
 * deep matches an audited record (`updatedAt` / `createdAt`) wins.
 */
export const findRecord = (state: unknown, id: string): Readonly<Record<string, Json>> | undefined => {
  let level: unknown[] = [state];
  while (level.length > 0) {
    const next: unknown[] = [];
    let fallback: Readonly<Record<string, Json>> | undefined;
    for (const value of level) {
      if (Array.isArray(value)) {
        next.push(...value);
      } else if (isObject(value)) {
        if (value['id'] === id) {
          if ('updatedAt' in value || 'createdAt' in value) {
            return value;
          }
          fallback ??= value;
        }
        next.push(...Object.values(value));
      }
    }
    if (fallback !== undefined) {
      return fallback;
    }
    level = next;
  }
  return undefined;
};

const display = (value: Json | undefined): string | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (Array.isArray(value)) {
    const scalars = value.every((entry) => typeof entry !== 'object' || entry === null);
    const text = scalars ? value.map(String).join(', ') : `#${value.length}`;
    return text.slice(0, MAX_VALUE);
  }
  if (isObject(value)) {
    const label = value['label'] ?? value['name'] ?? value['number'] ?? value['id'];
    return typeof label === 'string' ? label.slice(0, MAX_VALUE) : undefined;
  }
  return String(value).slice(0, MAX_VALUE);
};

/** Flattens nested plain objects (not references with a `label`) into dotted scalar fields, two levels deep. */
const flatten = (record: Readonly<Record<string, Json>>, prefix = '', depth = 0): Map<string, string | undefined> => {
  const fields = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(record)) {
    if (depth === 0 && (ignoredFields.has(key) || key === 'id')) {
      continue;
    }
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (isObject(value) && !('label' in value) && !('id' in value) && depth < 2) {
      for (const [nested, text] of flatten(value, path, depth + 1)) {
        fields.set(nested, text);
      }
    } else {
      fields.set(path, display(value));
    }
  }
  return fields;
};

/** Field-level difference of two encoded records (either may be absent). */
export const diffRecords = (
  before: Readonly<Record<string, Json>> | undefined,
  after: Readonly<Record<string, Json>> | undefined,
): readonly FieldChange[] => {
  const left = before === undefined ? new Map<string, string | undefined>() : flatten(before);
  const right = after === undefined ? new Map<string, string | undefined>() : flatten(after);
  const changes: FieldChange[] = [];
  for (const field of new Set([...left.keys(), ...right.keys()])) {
    const previous = left.get(field);
    const next = right.get(field);
    if (previous !== next) {
      changes.push({
        field,
        ...(previous === undefined ? {} : { before: previous }),
        ...(next === undefined ? {} : { after: next }),
      });
    }
  }
  return changes.slice(0, 40);
};

/**
 * Per-record optimistic concurrency: a command built from data loaded at `baseUpdatedAt` conflicts only when one of
 * the records it changes was itself changed after that instant (unrelated edits in the same agenda do not conflict).
 */
export const touchedSince = (
  currentEncoded: unknown,
  entityIds: readonly string[],
  baseUpdatedAt: string,
): boolean => {
  const base = Date.parse(baseUpdatedAt);
  if (Number.isNaN(base)) {
    return true;
  }
  return entityIds.some((id) => {
    const record = findRecord(currentEncoded, id);
    const updatedAt = record?.['updatedAt'];
    return typeof updatedAt === 'string' && Date.parse(updatedAt) > base;
  });
};

/** Change entries for the records a command touched (records with no field change are skipped). */
export const changeEntries = (input: {
  readonly agenda: ChangeEntryEncoded['agenda'];
  readonly command: string;
  readonly entityIds: readonly string[];
  readonly before: unknown;
  readonly after: unknown;
  readonly at: string;
  readonly by: ChangeEntryEncoded['by'];
}): readonly ChangeEntryEncoded[] =>
  [...new Set(input.entityIds)].flatMap((entityId) => {
    const previous = findRecord(input.before, entityId);
    const next = findRecord(input.after, entityId);
    if (previous === undefined && next === undefined) {
      return [];
    }
    const kind = previous === undefined ? 'created' : next === undefined ? 'removed' : 'changed';
    const changes = kind === 'created' ? [] : diffRecords(previous, next);
    if (kind === 'changed' && changes.length === 0) {
      return [];
    }
    return [{ agenda: input.agenda, at: input.at, by: input.by, changes, command: input.command, entityId, kind }];
  });
