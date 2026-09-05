import { Schema } from 'effect';

// `tools/**` is outside the rule's default `include` scope.
export const InternalSchema = Schema.Struct({
  archivedAt: Schema.NullOr(Schema.String),
});
