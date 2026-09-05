// FALSE POSITIVE regression fixture.
//
// The audit blesses the outer run seam: "Bare `Effect.runPromise` is acceptable at the single outer
// process or framework adapter seam; the problem is repeated deep re-entry."
//
// Written point-free, that seam is the terminal stage of a `pipe` chain. `isInsideEffectOwnedCode`
// treats *any* `pipe(...)` / `.pipe(...)` whose arguments contain an Effect-family call as
// Effect-owned code, so the run stage of the chain is reported even though nothing encloses it.
// None of the runs below are nested inside a callback — they are the seam itself.
import { Effect, Layer, Schedule, Stream, pipe } from "effect";

declare const program: Effect.Effect<void, never, number>;
declare const AppLayer: Layer.Layer<number>;
declare const numbers: Stream.Stream<number>;

export const main = (): Promise<void> => program.pipe(Effect.provide(AppLayer), Effect.runPromise);

export const main2 = (): Promise<void> => pipe(program, Effect.provide(AppLayer), Effect.runPromise);

export const collect = (): Promise<unknown> =>
  numbers.pipe(Stream.take(1), Stream.runCollect, Effect.runPromise);

export const retried = (): Promise<void> =>
  program.pipe(Effect.provide(AppLayer), Effect.retry(Schedule.forever), Effect.runPromise);
