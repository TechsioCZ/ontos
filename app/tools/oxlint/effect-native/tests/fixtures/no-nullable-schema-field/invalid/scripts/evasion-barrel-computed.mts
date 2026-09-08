// expect-count: 2
import * as Effect from 'effect';

// Computed access at both levels, plus optional chaining on the namespace member.
export const RowSchema = Effect.Schema.Struct({
  archivedAt: Effect['Schema']['NullOr'](Effect.Schema.String),
  cursor: Effect.Schema?.UndefinedOr(Effect.Schema.String),
});
