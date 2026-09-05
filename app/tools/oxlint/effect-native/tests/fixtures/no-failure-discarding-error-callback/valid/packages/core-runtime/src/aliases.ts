import * as Effect from 'effect/Effect';

class Failure {
  constructor(readonly fields: { cause: unknown }) {}
}

declare const program: Effect.Effect<number, Error>;

// Same-file factory that reads its failure.
const toFailure = (cause: unknown) => new Failure({ cause });
function alsoToFailure(cause: unknown) {
  return new Failure({ cause });
}

export const a = program.pipe(Effect.mapError(toFailure));
export const b = program.pipe(Effect.mapError(alsoToFailure));

// Member-expression callbacks are skipped by default (flagMemberReferences is off).
declare const failures: { unavailable: () => Failure };
export const c = program.pipe(Effect.mapError(failures.unavailable));

// A parameter callback is unknowable and therefore skipped.
export const wrap = (handler: (cause: unknown) => Failure) => program.pipe(Effect.mapError(handler));
