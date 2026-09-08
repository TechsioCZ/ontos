import { Effect, Layer } from 'effect';

declare const CorePersistenceLive: Layer.Layer<never>;
declare const ActionRuntimeLive: Layer.Layer<never>;

// Library layers stay dependency-transparent: the typed error survives to the root.
export const actionRuntimeLive = ActionRuntimeLive.pipe(Layer.provide(CorePersistenceLive));

export const withRecovery = ActionRuntimeLive.pipe(
  Layer.catchCause((cause) => Layer.effect(ActionRuntimeLive, Effect.failCause(cause))),
);
