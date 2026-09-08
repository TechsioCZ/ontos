import { Effect } from 'effect';

class Failure {}
declare const program: Effect.Effect<number, Error>;

// Inside this function `Effect` is a parameter, not the Effect namespace.
export function withLocalEffect(Effect: { mapError: (f: () => Failure) => void }) {
  Effect.mapError(() => new Failure());
}

export const real = program.pipe(Effect.mapError((error) => error));
