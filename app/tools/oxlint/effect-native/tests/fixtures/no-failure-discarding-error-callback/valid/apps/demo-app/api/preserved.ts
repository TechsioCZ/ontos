import { Effect } from 'effect';

class OutboxPersistenceError {
  constructor(readonly fields: { cause: unknown }) {}
}

declare const decodeDatabaseFailure: (cause: unknown) => OutboxPersistenceError;
declare const program: Effect.Effect<number, Error>;
declare const write: () => Promise<void>;

// The failure is carried into the replacement error.
export const mapped = program.pipe(Effect.mapError((error) => new OutboxPersistenceError({ cause: error })));

// The shared Core decoder A5 asks for (imported → skipped, and it does take the failure).
export const written = Effect.tryPromise({ try: write, catch: decodeDatabaseFailure });

// Destructuring the failure counts as reading it.
export const destructured = program.pipe(Effect.mapError(({ message }) => new OutboxPersistenceError({ cause: message })));

// Rest parameter.
export const rested = program.pipe(Effect.mapError((...causes) => new OutboxPersistenceError({ cause: causes })));

// A4's target: the tag already carries the failure identity, so a zero-arity handler is fine.
export const narrowed = program.pipe(Effect.catchTag('ActionAlreadyCommitted', () => Effect.void));
export const narrowedMany = program.pipe(Effect.catchTags({ Timeout: () => Effect.void }));
export const conditional = program.pipe(Effect.catchIf(() => true, () => Effect.void));

// Both channels read their argument.
export const both = program.pipe(
  Effect.mapBoth({ onFailure: (error) => new OutboxPersistenceError({ cause: error }), onSuccess: (value) => value }),
);
