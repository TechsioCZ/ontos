// expect-count: 2
// Namespace import of the `effect` barrel itself.
import * as effect from "effect";

declare const program: effect.Effect.Effect<number>;

export const inGen = effect.Effect.gen(function* () {
  const value = effect.Effect.runSync(program);
  return yield* effect.Effect.succeed(value);
});

export const inSync = effect.Effect.sync(() => {
  void effect.Effect.runPromise(program);
});
