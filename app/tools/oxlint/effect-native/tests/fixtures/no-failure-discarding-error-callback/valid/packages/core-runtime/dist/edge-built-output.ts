import { Effect } from 'effect';

class Unavailable {}
declare const load: Effect.Effect<number, Error>;

// Build output is out of scope.
export const mapped = load.pipe(Effect.mapError(() => new Unavailable()));
