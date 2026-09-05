import type { Schema } from 'effect';

// A type-only import can never be a value: the nullable spelling here is a type reference.
export type Row = {
  readonly archivedAt: Schema.NullOr<Schema.String>;
};
