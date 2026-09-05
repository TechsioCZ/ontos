// `pipe(...)` and `.pipe(...)` are the only links allowed between a provide and the outer run call.
import { Effect, Layer, pipe } from "effect";

declare const program: Effect.Effect<void, never, never>;
declare const RuntimeLive: Layer.Layer<never, never, never>;

await Effect.runPromise(pipe(program, Effect.provide(RuntimeLive)));

Effect.runFork(pipe(program, Effect.provide(RuntimeLive)).pipe(Effect.provide(RuntimeLive)));
