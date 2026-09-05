import { Effect } from 'effect';

class Unavailable {}
declare const load: Effect.Effect<number, Error>;

// A `__tests__` directory is a test path, blessed by the audit's D tier.
export const mapped = load.pipe(Effect.mapError(() => new Unavailable()));
