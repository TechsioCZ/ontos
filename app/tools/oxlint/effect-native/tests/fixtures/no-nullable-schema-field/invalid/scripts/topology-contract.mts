// expect-count: 2
import * as Effect from 'effect';

// Root barrel access: `Effect.Schema.NullOr`.
export const TopologySchema = Effect.Schema.Struct({
  previousState: Effect.Schema.NullOr(Effect.Schema.String),
  nextOffset: Effect.Schema.NullishOr(Effect.Schema.Finite),
});
