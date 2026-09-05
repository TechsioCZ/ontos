// expect-count: 5
// S1: `ActionRollbackSignal` thrown out of the Drizzle transaction body, recovered by `instanceof`.
import { Cause, Effect, Exit } from 'effect';

class ActionRollbackSignal<E> {
  readonly token: symbol;
  readonly cause: Cause.Cause<E>;
  constructor(token: symbol, cause: Cause.Cause<E>) {
    this.token = token;
    this.cause = cause;
  }
  matches(token: symbol): boolean {
    return this.token === token;
  }
}

declare const rollbackToken: symbol;
declare const database: {
  readonly executor: {
    readonly transaction: <A>(body: (transaction: unknown) => Promise<A>) => Promise<A>;
  };
};
declare const handler: Effect.Effect<string, Error>;
declare const steps: ReadonlyArray<Effect.Effect<void>>;

export const runGovernedAction = Effect.tryPromise({
  try: async () =>
    await database.executor.transaction(async () => {
      const exit = await Effect.runPromiseExit(handler);
      if (Exit.isFailure(exit)) {
        throw new ActionRollbackSignal(rollbackToken, exit.cause);
      }
      // Nested native callback inside the transaction body: still an Effect callback transitively.
      await Promise.all(
        steps.map(async (step) => {
          const stepExit = await Effect.runPromiseExit(step);
          if (Exit.isFailure(stepExit)) {
            throw new ActionRollbackSignal(rollbackToken, stepExit.cause);
          }
        }),
      );
      return exit.value;
    }),
  catch: (error: unknown) => {
    if (error instanceof ActionRollbackSignal && error.matches(rollbackToken)) {
      return error;
    }
    throw error;
  },
});

export const flush = Effect.forEach(steps, (step) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(step);
    if (Exit.isFailure(exit)) {
      throw new ActionRollbackSignal(rollbackToken, exit.cause);
    }
  }),
);

export const acquire = Effect.acquireRelease(
  Effect.sync(() => {
    throw new Error('lock unavailable');
  }),
  () => Effect.void,
);
