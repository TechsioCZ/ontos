// expect-count: 3
// The run-seam exemption is anchored to the run call's direct argument pipeline. A provide laundered
// through another combinator (or an array element) escapes the run as a pre-provided library value,
// so it keeps hiding `R` from the composition root.
import { Effect, Layer } from "effect";

declare const program: Effect.Effect<void, never, never>;
declare const RuntimeLive: Layer.Layer<never, never, never>;

export const suspended = Effect.runSync(Effect.succeed(program.pipe(Effect.provide(RuntimeLive))));

export const batched = Effect.runPromise(Effect.all([program.pipe(Effect.provide(RuntimeLive))]));

export const stashed = Effect.runFork(Effect.succeed({ ready: Effect.provide(program, RuntimeLive) }));
