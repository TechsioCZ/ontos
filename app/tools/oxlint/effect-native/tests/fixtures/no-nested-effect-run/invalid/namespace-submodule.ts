// expect-count: 2
import * as Effect from "effect/Effect";

declare const work: Effect.Effect<number>;

export const outer = Effect.gen(function* () {
  const value = Effect.runSync(work);
  return yield* Effect.succeed(value);
});

export const chained = Effect.sync(() => Effect?.runPromise(work));
