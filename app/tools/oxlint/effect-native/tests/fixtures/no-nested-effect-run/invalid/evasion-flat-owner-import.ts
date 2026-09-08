// expect-count: 2
// Effect-owned code entered through flat named imports of the combinators.
import { Effect } from "effect";
import { gen, sync } from "effect/Effect";

declare const program: Effect.Effect<number>;

export const inGen = gen(function* () {
  const value = Effect.runSync(program);
  return yield* Effect.succeed(value);
});

export const inSync = sync(() => {
  void Effect.runPromise(program);
});
