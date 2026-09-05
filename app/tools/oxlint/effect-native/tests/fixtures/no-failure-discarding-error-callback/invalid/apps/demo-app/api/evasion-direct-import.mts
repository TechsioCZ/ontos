// expect-count: 3
// Direct member imports from `effect/Effect`, including an alias, inside an `.mts` module.
import { catchAll, mapError as mapFailure, tryPromise } from 'effect/Effect';
import { Effect } from 'effect';

class Unavailable {}
declare const load: Effect.Effect<number, Error>;
declare const write: () => Promise<void>;

export const aliased = load.pipe(mapFailure(() => new Unavailable()));
export const recovered = load.pipe(catchAll(() => Effect.succeed(0)));
export const written = tryPromise({ try: write, catch: () => new Unavailable() });
