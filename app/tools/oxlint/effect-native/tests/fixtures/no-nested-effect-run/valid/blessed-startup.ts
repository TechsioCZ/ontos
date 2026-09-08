// D tier: Layer.orDie at a deliberate outer startup boundary, one adapter seam, native array ops.
import { Effect, Layer } from "effect";

declare const AppLayer: Layer.Layer<never>;
declare const server: Effect.Effect<void>;

const runtimeLayer = Layer.orDie(AppLayer);

export const start = (): Promise<void> => Effect.runPromise(Effect.provide(server, runtimeLayer));

export const startExit = (): Promise<unknown> =>
  Effect.runPromiseExit(Effect.provide(server, runtimeLayer));
