// expect-count: 2
import { Schema } from 'effect';

// Re-binding the namespace (or destructuring the combinator off it) is the same decode.
const S = Schema;
const { NullOr } = Schema;

export const RowSchema = Schema.Struct({
  archivedAt: S.NullOr(Schema.String),
  deletedAt: NullOr(Schema.String),
});
