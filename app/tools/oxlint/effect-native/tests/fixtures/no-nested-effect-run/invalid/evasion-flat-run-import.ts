// expect-count: 2
// Named imports of the run functions themselves: `Effect.runSync` written as `runSync`.
import { Effect } from "effect";
import { runPromise, runSync } from "effect/Effect";

declare const program: Effect.Effect<number>;

export const inGen = Effect.gen(function* () {
  const value = runSync(program);
  return yield* Effect.succeed(value);
});

export const inSync = Effect.sync(() => {
  void runPromise(program);
});
