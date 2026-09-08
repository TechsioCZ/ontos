// expect-count: 2
import { Layer } from 'effect';

declare const ContextAccessLive: Layer.Layer<never>;
declare const OperationalScopeResolverLive: Layer.Layer<never>;
declare const readRuntimeLayer: Layer.Layer<never>;

// Point-free in a pipe: the shape the audit found at reads/runtime.ts:749.
export const operationalScopeResolverLayer = OperationalScopeResolverLive.pipe(
  Layer.provide(ContextAccessLive),
  Layer.fresh,
);

// Direct call form.
export const ReadRuntimeLive = Layer.fresh(readRuntimeLayer);
