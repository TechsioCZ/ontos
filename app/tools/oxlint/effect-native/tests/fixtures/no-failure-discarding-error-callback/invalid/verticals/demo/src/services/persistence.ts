// expect-count: 4
import * as Effect from 'effect/Effect';
import { catchAll } from 'effect/Effect';

class DatabaseUnavailable {}

declare const query: () => Promise<number>;
declare const program: Effect.Effect<number, Error>;

export const rows = Effect.tryPromise({ try: query, catch: () => new DatabaseUnavailable() });

export const recovered = program.pipe(catchAll(() => Effect.succeed(0)));

export const computed = program.pipe(Effect['mapError'](() => new DatabaseUnavailable()));

export const optional = program.pipe(Effect?.catchCause(() => Effect.succeed(0)));
