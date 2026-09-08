// expect-count: 1
import { Effect, Layer } from 'effect';
declare const source: Layer.Layer<never, unknown>;
export const layer = source.pipe(Layer.tapErrorCause(Effect.logError), Layer.orDie);
// A later helper must not steal the startup boundary's allowance.
export function helper() {
  return source.pipe(Layer.orDie);
}
