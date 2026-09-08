// expect-count: 3
// Declared host entry point that builds a ManagedRuntime with no Logger, Tracer or minimum level.
import { Effect, Layer, ManagedRuntime } from 'effect';

export const start = (layer: Layer.Layer<never>): void => {
  const runtime = ManagedRuntime.make(layer);
  void runtime.runPromise(Effect.void);
};
