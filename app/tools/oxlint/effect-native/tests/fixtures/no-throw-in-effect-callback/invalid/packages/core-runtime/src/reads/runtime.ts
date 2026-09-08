// expect-count: 4
// S1: the Read runtime's Promise transaction sandwich with its private `ReadRollback` sentinel.
import { Cause, Effect, Exit } from 'effect';

class ReadRollback {
  readonly error: unknown;
  constructor(error: unknown) {
    this.error = error;
  }
}

declare const database: {
  readonly executor: {
    readonly transaction: <A>(body: (transaction: unknown) => Promise<A>) => Promise<A>;
  };
};
declare const program: Effect.Effect<number>;

export const runGovernedRead = Effect.tryPromise({
  // The inner arrow belongs to `database.executor.transaction`, not to Effect: the rule has to
  // climb transitively to the outer `try` callback of `Effect.tryPromise`.
  try: async () =>
    await database.executor.transaction(async (transaction: unknown) => {
      void transaction;
      const exit = await Effect.runPromiseExit(program);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        if (failure._tag === 'Some') {
          throw new ReadRollback(failure.value);
        }
        throw new ReadRollback('the governed read transaction was interrupted');
      }
      if (exit.value < 0) {
        throw new Error('negative read result');
      }
      return exit.value;
    }),
  catch: (error: unknown) => error,
});

export const decodeReadKey = Effect.gen(function* () {
  const raw = yield* Effect.succeed('');
  if (raw.length === 0) {
    throw new ReadRollback('empty read key');
  }
  return raw;
});

// Deliberately NOT reported in the default `effect-callbacks` mode: a plain helper that is only
// ever *called* from the transaction callback. `mode: "effect-files"` catches this one.
export const unwrapCore = (value: number): number => {
  if (value < 0) {
    throw new ReadRollback('negative');
  }
  return value;
};
