// A composition root listed in `rootFiles`: providing the process Layer graph here is the target state.
import { Effect, Layer } from "effect";

declare const program: Effect.Effect<void, never, never>;
declare const ShellLayer: Layer.Layer<never, never, never>;
declare const Clock: never;
declare const clock: never;

export const main = program.pipe(Effect.provide(ShellLayer), Effect.provideService(Clock, clock));
