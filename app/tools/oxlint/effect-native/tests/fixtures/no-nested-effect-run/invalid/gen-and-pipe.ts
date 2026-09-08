// expect-count: 4
import { Effect, pipe } from "effect";

declare const other: () => Effect.Effect<number>;
declare const source: Effect.Effect<number>;

export const inGen = Effect.gen(function* () {
  const value = Effect.runSync(other());
  return yield* Effect.succeed(value);
});

export const pointFree = source.pipe(
  Effect.tap(() => Effect.promise(() => Effect.runPromise(other()))),
);

export const inPipe = pipe(
  source,
  Effect.map((value) => {
    Effect.runFork(other());
    return value;
  }),
);

export const nestedCallback = Effect.forEach([1, 2], (item) =>
  Effect.sync(() => Effect.runSync(other()) + item),
);
