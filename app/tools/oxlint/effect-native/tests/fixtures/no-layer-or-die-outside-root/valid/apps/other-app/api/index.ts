import { Effect, Layer } from 'effect';

declare const ApiLive: Layer.Layer<never>;
declare const DepsLive: Layer.Layer<never>;

const L = Layer;

// D tier: still exactly one deliberate outer boundary, only spelled through an alias.
export const layer = ApiLive.pipe(
  L.provide(DepsLive),
  L.tapErrorCause(Effect.logError),
  L.orDie,
);
