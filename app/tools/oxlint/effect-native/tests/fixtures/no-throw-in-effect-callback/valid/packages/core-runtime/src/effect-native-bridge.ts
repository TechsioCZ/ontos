// The S1 target shape: the transaction body stays an Effect, rollback is a typed failure, and the
// single Drizzle boundary decides on `Exit.isFailure`. Nothing throws inside an Effect callback.
import { Cause, Effect, Exit, Layer, Schema } from 'effect';

export class ReadHandlerExecutionError extends Schema.TaggedError<ReadHandlerExecutionError>(
  'ReadHandlerExecutionError',
)('ReadHandlerExecutionError', { reason: Schema.String }) {}

declare const database: {
  readonly executor: {
    readonly transaction: <A>(body: (transaction: unknown) => Promise<A>) => Promise<A>;
  };
};
declare const handler: Effect.Effect<string, ReadHandlerExecutionError>;
declare const tag: unknown;

export const runGovernedRead = Effect.gen(function* () {
  const exit = yield* Effect.exit(handler);
  if (Exit.isFailure(exit)) {
    const failure = Cause.findErrorOption(exit.cause);
    return yield* Option.isSome(failure)
      ? Effect.fail(failure.value)
      : Effect.failCause(exit.cause);
  }
  return exit.value;
});

export const bridge = Effect.tryPromise({
  try: async (signal: AbortSignal) => {
    void signal;
    return await database.executor.transaction(async (transaction: unknown) => {
      void transaction;
      return 1;
    });
  },
  catch: (error: unknown) =>
    new ReadHandlerExecutionError({ reason: `the transaction failed: ${String(error)}` }),
});

// Broken invariants stay defects on purpose — `Effect.die`, not `throw`.
export const invariant = Effect.gen(function* () {
  const value = yield* Effect.succeed(0);
  if (value < 0) {
    return yield* Effect.die(new Error('negative invariant'));
  }
  return value;
});

// A plain module-level helper. The default `effect-callbacks` mode leaves these to the A3 rule
// `no-throw-in-configuration-parser`.
export function validateDescriptor(descriptor: { readonly key: string }): string {
  if (descriptor.key.length === 0) {
    throw new Error('descriptor key must not be empty');
  }
  return descriptor.key;
}

// Native array callbacks outside any Effect combinator (D tier: leave native ops alone).
export const keys = ['a', ''].map((entry) => {
  if (entry.length === 0) {
    throw new Error('empty entry');
  }
  return entry;
});

// D tier: `Layer.orDie` at a deliberate startup root.
export const RootLayer = Layer.orDie(Layer.succeed(tag as never, 1 as never));

declare const Option: { readonly isSome: (value: unknown) => boolean };
