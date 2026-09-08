// The Effect-native target: yield the contextual service and let `R` propagate to the root.
import { Effect, Layer } from "effect";

declare const Clock: Effect.Effect<{ readonly now: number }, never, never>;
declare const runHandler: (input: unknown, clock: unknown) => Effect.Effect<string, never, never>;
declare const RepositoryLive: Layer.Layer<never, never, never>;
declare const ConfigLive: Layer.Layer<never, never, never>;

export const handler = (input: unknown) =>
  Effect.gen(function* () {
    const clock = yield* Clock;
    return yield* runHandler(input, clock);
  });

// Layer composition is not requirement erasure: `Layer.provide`/`Layer.provideMerge` stay allowed,
// and `Layer.orDie` at a deliberate startup boundary is D tier.
export const RepositoryStack = RepositoryLive.pipe(
  Layer.provide(ConfigLive),
  Layer.provideMerge(ConfigLive),
  Layer.orDie,
);
