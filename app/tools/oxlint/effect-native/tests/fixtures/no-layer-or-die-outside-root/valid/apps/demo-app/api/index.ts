import { Effect, Layer } from 'effect';

declare const HttpApiBuilderLayer: Layer.Layer<never>;
declare const AllDependenciesLive: Layer.Layer<never>;

// D tier: `Layer.orDie` at a deliberate outer startup boundary, typed cause logged first.
export const layer = HttpApiBuilderLayer.pipe(
  Layer.provide(AllDependenciesLive),
  Layer.tapErrorCause(Effect.logError),
  Layer.orDie,
);
