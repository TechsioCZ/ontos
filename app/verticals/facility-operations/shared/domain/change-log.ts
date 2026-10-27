// Facility operations — per-record change history and per-record conflict detection (S00, S12, S15).
// Owned by ops-scaffold. Every agenda command is diffed generically on the ENCODED (JSON) state: the records the
// command touched (its `entityIds`) are found by `id` anywhere in the state tree and their scalar fields compared.
// Entries live in one extra `agenda_states` row (`agenda = 'change-log'`) per company, appended in the same
// transaction as the change itself, so history can never disagree with the stored data.
import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { Array as Arr, DateTime, Option, Schema } from 'effect';
import { AgendaIdSchema } from './common.ts';

/** Row key of the change log in facility_operations.agenda_states (not an agenda; never decoded as one). */
export const CHANGE_LOG_ROW = 'change-log';
/** Oldest entries are dropped beyond this many per company. */
export const MAX_CHANGE_LOG_ENTRIES = 4000;
/** Longest stored before/after display value. */
const MAX_VALUE = 300;

export const FieldChangeSchema = Schema.Struct({
  /** Dotted path of the changed field, e.g. `contract.validTo`, `acquisitionValueMinor`, `lines` (array → count). */
  field: Schema.String,
  /** Display value before (absent = field was empty). Arrays are stored as `#<count>`. */
  after: Schema.optionalKey(Schema.String),
  before: Schema.optionalKey(Schema.String),
});
export type FieldChange = typeof FieldChangeSchema.Type;

const ChangeEntityIdSchema = Schema.String.pipe(
  Schema.brand('FacilityOperationsChangeEntityId'),
  Schema.decodeTo(Schema.String),
);

export const ChangeEntrySchema = Schema.Struct({
  agenda: AgendaIdSchema,
  entityId: ChangeEntityIdSchema,
  /** Command tag that made the change, e.g. `DocumentUpdate`. */
  command: Schema.String,
  /** `created` = record did not exist before; `changed` = scalar fields differ; `removed` = record disappeared. */
  at: Schema.DateTimeUtcFromString,
  by: PrincipalRefSchema,
  changes: Schema.Array(FieldChangeSchema),
  kind: Schema.Literals(['created', 'changed', 'removed']),
});
export type ChangeEntry = typeof ChangeEntrySchema.Type;
export type ChangeEntryEncoded = typeof ChangeEntrySchema.Encoded;

export const ChangeLogStateSchema = Schema.Struct({ entries: Schema.Array(ChangeEntrySchema) });
/** The agenda is typed; its encoded state is opaque audit evidence owned by that agenda's schema. */
export const ChangeLogSnapshotSchema = Schema.Struct({ agenda: AgendaIdSchema, state: Schema.Json });

/** Audit and bookkeeping fields that every edit changes; they are shown separately, never as a "change". */
const ignoredFields = new Set(['createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'history', 'versions', 'edits']);

const isObject = Schema.is(Schema.JsonObject);
const isString: (value: Schema.Json | undefined) => value is string = Schema.is(Schema.String);
const ScalarSchema = Schema.Union([Schema.Null, Schema.Boolean, Schema.Number, Schema.String]);
const isScalar = Schema.is(ScalarSchema);

/**
 * Finds the record with `id === id` in an encoded state tree: breadth-first, so a top-level record wins over a
 * nested reference to it (e.g. a document link `{ id, kind, label }` inside another document), and among equally
 * deep matches an audited record (`updatedAt` / `createdAt`) wins.
 */
export const findRecord = (state: Schema.Json, id: string): Schema.JsonObject | undefined => {
  let level: Schema.Json[] = [state];
  while (level.length > 0) {
    const next: Schema.Json[] = [];
    let fallback: Schema.JsonObject | undefined;
    for (const value of level) {
      if (Arr.isArray<Schema.Json>(value)) {
        next.push(...value);
      } else if (isObject(value)) {
        if (value['id'] === id) {
          if (value['updatedAt'] !== undefined || value['createdAt'] !== undefined) {
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

const display = (value: Schema.Json | undefined): string | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (Arr.isArray<Schema.Json>(value)) {
    const scalars = value.every(isScalar);
    const text = scalars ? value.map(String).join(', ') : `#${value.length}`;
    return text.slice(0, MAX_VALUE);
  }
  if (isObject(value)) {
    const label = value['label'] ?? value['name'] ?? value['number'] ?? value['id'];
    return isString(label) ? label.slice(0, MAX_VALUE) : undefined;
  }
  return String(value).slice(0, MAX_VALUE);
};

/** Flattens nested plain objects (not references with a `label`) into dotted scalar fields, two levels deep. */
const flatten = (record: Schema.JsonObject, prefix = '', depth = 0): Map<string, string | undefined> => {
  const fields = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(record)) {
    if (depth === 0 && (ignoredFields.has(key) || key === 'id')) {
      continue;
    }
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (isObject(value) && value['label'] === undefined && value['id'] === undefined && depth < 2) {
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
  before: Schema.JsonObject | undefined,
  after: Schema.JsonObject | undefined,
): readonly FieldChange[] => {
  const left = before === undefined ? new Map<string, string | undefined>() : flatten(before);
  const right = after === undefined ? new Map<string, string | undefined>() : flatten(after);
  const changes: FieldChange[] = [];
  for (const field of new Set([...left.keys(), ...right.keys()])) {
    const previous = left.get(field);
    const next = right.get(field);
    if (previous !== next) {
      const change: { -readonly [K in keyof FieldChange]: FieldChange[K] } = { field };
      if (previous !== undefined) {
        change.before = previous;
      }
      if (next !== undefined) {
        change.after = next;
      }
      changes.push(change);
    }
  }
  return changes.slice(0, 40);
};

/**
 * Per-record optimistic concurrency: a command built from data loaded at `baseUpdatedAt` conflicts only when one of
 * the records it changes was itself changed after that instant (unrelated edits in the same agenda do not conflict).
 */
export const touchedSince = (
  currentEncoded: Schema.Json,
  entityIds: readonly string[],
  baseUpdatedAt: string,
): boolean => {
  const base = DateTime.make(baseUpdatedAt);
  if (Option.isNone(base)) {
    return true;
  }
  return entityIds.some((id) => {
    const record = findRecord(currentEncoded, id);
    const updatedAt = record?.['updatedAt'];
    if (!isString(updatedAt)) {
      return false;
    }
    const updated = DateTime.make(updatedAt);
    return Option.isSome(updated) && DateTime.isGreaterThan(updated.value, base.value);
  });
};

/** Change entries for the records a command touched (records with no field change are skipped). */
export const changeEntries = (input: {
  readonly after: Schema.Json;
  readonly agenda: ChangeEntryEncoded['agenda'];
  readonly at: string;
  readonly before: Schema.Json;
  readonly by: ChangeEntryEncoded['by'];
  readonly command: string;
  readonly entityIds: readonly string[];
}): readonly ChangeEntryEncoded[] =>
  [...new Set(input.entityIds)].flatMap((entityId) => {
    const previous = findRecord(input.before, entityId);
    const next = findRecord(input.after, entityId);
    if (previous === undefined && next === undefined) {
      return [];
    }
    let kind: ChangeEntryEncoded['kind'] = 'changed';
    if (previous === undefined) {
      kind = 'created';
    } else if (next === undefined) {
      kind = 'removed';
    }
    const changes = kind === 'created' ? [] : diffRecords(previous, next);
    if (kind === 'changed' && changes.length === 0) {
      return [];
    }
    return [{ agenda: input.agenda, at: input.at, by: input.by, changes, command: input.command, entityId, kind }];
  });
