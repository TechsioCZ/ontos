import { Schema } from 'effect';

// The owning snapshot codec admits the closed JSON value algebra, not one entity shape.
export const SnapshotSchema: Schema.Codec<Schema.Json> = Schema.suspend(() =>
  Schema.Union([Schema.Null, Schema.Finite, Schema.Boolean, Schema.String,
    Schema.Array(SnapshotSchema), Schema.Record(Schema.String, SnapshotSchema)]),
);

const orderedValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(orderedValue);
  }
  if (value !== null && typeof value === 'object') {
    if ('clientId' in value) return value.clientId;
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, orderedValue(entry)]),
    );
  }
  return value;
};
export const equalSnapshots = (left: unknown, right: unknown) =>
  JSON.stringify(orderedValue(left)) === JSON.stringify(orderedValue(right));
