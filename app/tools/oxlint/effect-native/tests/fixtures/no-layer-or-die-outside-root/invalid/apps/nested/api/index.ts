// expect-count: 1
import { Effect, Layer } from 'effect';
declare const source: Layer.Layer<never, unknown>;
// The inner orDie is a finding. The outer startup boundary is the allowed site,
// even though its callee begins earlier in the source than the nested invocation.
export const layer = Layer.orDie(source.pipe(
  Layer.orDie,
  Layer.tapErrorCause(Effect.logError),
));
