import { Effect, Layer } from 'effect';

declare const ReadRuntimeLive: Layer.Layer<never>;
declare const ResolverLive: Layer.Layer<never>;
declare const ContextAccessLive: Layer.Layer<never>;

// The A1 target shape: dependency-transparent layers composed once at the root.
export const AppLive = Layer.mergeAll(ReadRuntimeLive, ResolverLive, ContextAccessLive);

export const provided = ReadRuntimeLive.pipe(Layer.provide(ContextAccessLive));
export const memoized = Layer.merge(ReadRuntimeLive, ResolverLive);
export const effectful = Layer.effect(Effect.void as never, Effect.void) as unknown;
