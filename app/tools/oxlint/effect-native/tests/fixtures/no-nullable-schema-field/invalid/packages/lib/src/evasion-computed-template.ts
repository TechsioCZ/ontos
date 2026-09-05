// expect-count: 2
import { Schema } from 'effect';

// `Schema['NullOr']` is already detected; the no-substitution template spelling is the same access.
export const RowSchema = Schema.Struct({
  archivedAt: Schema[`NullOr`](Schema.String),
  deletedAt: Schema[`NullishOr`](Schema.String),
});
