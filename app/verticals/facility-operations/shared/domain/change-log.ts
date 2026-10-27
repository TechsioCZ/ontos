// Facility operations — per-record change history and per-record conflict detection (S00, S12, S15).
// Owned by ops-scaffold. Every agenda command is diffed generically on the ENCODED (JSON) state: the records the
// command touched (its `entityIds`) are found by `id` anywhere in the state tree and their scalar fields compared.
// Entries live in one extra `agenda_states` row (`agenda = 'change-log'`) per company, appended in the same
// transaction as the change itself, so history can never disagree with the stored data.
import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { DateTime, Option, Schema, SchemaTransformation } from 'effect';
import { optionalField, AgendaIdSchema, EntityIdSchema } from './common.ts';

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

export const ChangeEntrySchema = Schema.Struct({
  agenda: AgendaIdSchema,
  entityId: EntityIdSchema,
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

/** Audit and bookkeeping fields that every edit changes; they are shown separately, never as a "change". */
const ignoredFields = new Set(['createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'history', 'versions', 'edits']);

/** Raw encoded agenda evidence retained for generic before/after audit diffs. */
export const ChangeSnapshotSchema = Schema.Struct({ agenda: AgendaIdSchema, document: Schema.Json });

type Json = Schema.Json;
const AuditValueSchema: Schema.Codec<Json> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Boolean,
    Schema.Finite,
    Schema.String,
    Schema.Array(AuditValueSchema),
    Schema.Record(Schema.String, AuditValueSchema),
  ]),
);
const JsonObjectSchema = Schema.Record(Schema.String, AuditValueSchema);
const JsonArraySchema = Schema.Array(AuditValueSchema);
const JsonScalarSchema = Schema.Union([Schema.Null, Schema.Boolean, Schema.Finite, Schema.String]);
const isObject = Schema.is(JsonObjectSchema);
const isJsonArray = Schema.is(JsonArraySchema);
const isJsonScalar = Schema.is(JsonScalarSchema);
const hasAuditStamp = Schema.is(
  Schema.Union([Schema.Struct({ updatedAt: Schema.Json }), Schema.Struct({ createdAt: Schema.Json })]),
);
const isReference = Schema.is(
  Schema.Union([Schema.Struct({ label: Schema.Json }), Schema.Struct({ id: Schema.Json })]),
);
/**
 * Finds the record with `id === id` in an encoded state tree: breadth-first, so a top-level record wins over a
 * nested reference to it (e.g. a document link `{ id, kind, label }` inside another document), and among equally
 * deep matches an audited record (`updatedAt` / `createdAt`) wins.
 */
export const findRecord = (state: Json, id: string): Readonly<Record<string, Json>> | undefined => {
  let level: Json[] = [state];
  while (level.length > 0) {
    const next: Json[] = [];
    let fallback: Readonly<Record<string, Json>> | undefined;
    for (const value of level) {
      if (isJsonArray(value)) {
        for (const child of value) {
          next.push(child);
        }
      } else if (isObject(value)) {
        if (value['id'] === id) {
          if (hasAuditStamp(value)) {
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
  if (isJsonArray(value)) {
    const scalars = value.every(isJsonScalar);
    const text = scalars ? value.map(String).join(', ') : `#${value.length}`;
    return text.slice(0, MAX_VALUE);
  }
  if (isObject(value)) {
    const label = value['label'] ?? value['name'] ?? value['number'] ?? value['id'];
    return Schema.decodeUnknownOption(Schema.String)(label).pipe(
      Option.map((text) => text.slice(0, MAX_VALUE)),
      Option.getOrUndefined,
    );
  }
  return isJsonScalar(value) ? String(value).slice(0, MAX_VALUE) : undefined;
};

/** Flattens nested plain objects (not references with a `label`) into dotted scalar fields, two levels deep. */
const flatten = (record: Readonly<Record<string, Json>>, prefix = '', depth = 0): Map<string, string | undefined> => {
  const fields = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(record)) {
    if (depth === 0 && (ignoredFields.has(key) || key === 'id')) {
      continue;
    }
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (isObject(value) && !isReference(value) && depth < 2) {
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
        ...optionalField('before', previous),
        ...optionalField('after', next),
      });
    }
  }
  return changes.slice(0, 40);
};

const LegacyStampInstantSchema = Schema.DateFromString.pipe(
  Schema.decodeTo(
    Schema.DateTimeUtc,
    SchemaTransformation.transform({
      decode: DateTime.fromDateUnsafe,
      encode: DateTime.toDateUtc,
    }),
  ),
);
const stampInstant = Schema.decodeOption(LegacyStampInstantSchema);

/** Keep legacy source text exactly, including an invalid stamp that must conflict on a stale revision. */
export const BaseUpdatedAtSchema = Schema.String.check(Schema.isMaxLength(40)).pipe(
  Schema.decodeTo(
    Schema.Struct({ instant: Schema.Option(Schema.DateTimeUtc), source: Schema.String }),
    SchemaTransformation.transform({
      decode: (source) => ({ instant: stampInstant(source), source }),
      encode: (value) => value.source,
    }),
  ),
);
export type BaseUpdatedAt = typeof BaseUpdatedAtSchema.Type;
const isStampText = Schema.is(Schema.String);

/**
 * Per-record optimistic concurrency: a command built from data loaded at `baseUpdatedAt` conflicts only when one of
 * the records it changes was itself changed after that instant (unrelated edits in the same agenda do not conflict).
 */
export const touchedSince = (
  currentEncoded: Json,
  entityIds: readonly string[],
  baseUpdatedAt: string | BaseUpdatedAt,
): boolean => {
  const base = isStampText(baseUpdatedAt) ? stampInstant(baseUpdatedAt) : baseUpdatedAt.instant;
  if (Option.isNone(base)) {
    return true;
  }
  return entityIds.some((id) => {
    const record = findRecord(currentEncoded, id);
    const updatedAt = record?.['updatedAt'];
    if (!isStampText(updatedAt)) {
      return false;
    }
    return Option.match(stampInstant(updatedAt), {
      onNone: () => false,
      onSome: (at) => DateTime.toEpochMillis(at) > DateTime.toEpochMillis(base.value),
    });
  });
};

const recordChangeKind = (before: Json | undefined, after: Json | undefined) => {
  if (before === undefined) {
    return 'created';
  }
  return after === undefined ? 'removed' : 'changed';
};

/** Change entries for the records a command touched (records with no field change are skipped). */
export const changeEntries = (input: {
  readonly after: Json;
  readonly agenda: ChangeEntryEncoded['agenda'];
  readonly at: string;
  readonly before: Json;
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
    const kind = recordChangeKind(previous, next);
    const changes = kind === 'created' ? [] : diffRecords(previous, next);
    if (kind === 'changed' && changes.length === 0) {
      return [];
    }
    return [{ agenda: input.agenda, at: input.at, by: input.by, changes, command: input.command, entityId, kind }];
  });
