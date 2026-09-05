// expect-count: 5
// Adversarial: the throw is buried under a non-Effect callback, a `catch` clause, an IIFE, a getter
// or an `Exit` check. The transitive climb must still reach the enclosing Effect combinator.
import { Effect, Exit } from 'effect';

class ReadRollback {
  readonly cause: unknown;
  constructor(cause: unknown) {
    this.cause = cause;
  }
}

declare const database: {
  readonly executor: { readonly transaction: <A>(body: (tx: unknown) => Promise<A>) => Promise<A> };
};
declare const program: Effect.Effect<number>;

// 1 — inside a `.then()` continuation nested in the Drizzle transaction body (the real
// gateway-assertion-redemption shape).
export const a = Effect.tryPromise({
  try: async () =>
    await database.executor.transaction(async () =>
      await Effect.runPromise(program).then((value) => {
        if (value < 0) throw new ReadRollback(value);
        return value;
      }),
    ),
  catch: (error: unknown) => error,
});

// 2 — inside a `catch` clause in `Effect.gen`.
export const b = Effect.gen(function* () {
  try {
    yield* program;
  } catch (error) {
    throw new ReadRollback(error);
  }
});

// 3 — inside an async IIFE forked from an Effect callback.
export const c = Effect.gen(function* () {
  void (async () => {
    throw new ReadRollback('iife');
  })();
  yield* program;
});

// 4 — inside a getter of an object literal returned from `Effect.sync`.
export const d = Effect.sync(() => ({
  get value(): number {
    throw new ReadRollback('getter');
  },
}));

// 5 — the plain `Exit.isFailure` rollback throw.
export const e = Effect.gen(function* () {
  const exit = yield* Effect.exit(program);
  if (Exit.isFailure(exit)) {
    throw new ReadRollback(exit.cause);
  }
});
