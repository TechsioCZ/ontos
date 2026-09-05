// expect-count: 2
// Point-free run references are run sites even though they are never the callee.
import { Effect, pipe } from "effect";

declare const items: ReadonlyArray<Effect.Effect<number>>;
declare const program: Effect.Effect<number>;

export const collected = Effect.sync(() => items.map(Effect.runPromise));

export const piped = Effect.gen(function* () {
  const value = pipe(program, Effect.runSync);
  return yield* Effect.succeed(value);
});
