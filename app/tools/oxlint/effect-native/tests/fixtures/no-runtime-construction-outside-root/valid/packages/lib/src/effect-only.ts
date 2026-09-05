// Library code keeps its requirements in `R` and never builds a runtime: the A1 target.
import { Effect, Layer } from 'effect';

declare const persistenceLive: Layer.Layer<never>;

export const CustomerLive = Layer.effect(
  Symbol.for('Customer') as never,
  Effect.succeed({} as never),
);

export const composed = Layer.provide(CustomerLive, persistenceLive);
export const merged = Layer.mergeAll(CustomerLive, persistenceLive);
export const scoped = Effect.scoped(Effect.succeed(1));
