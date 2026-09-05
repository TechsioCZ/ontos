// expect-count: 6
// Point-free `pipe(x, Effect.mapError(f))` and same-file factory shapes.
import { Effect, pipe } from 'effect';

class Unavailable {}
declare const load: Effect.Effect<number, Error>;
declare const write: () => Promise<void>;

function hoisted() {
  return new Unavailable();
}
const asExpression = function () {
  return new Unavailable();
};
let reassignable = () => new Unavailable();

export const pointFree = pipe(load, Effect.mapError(() => new Unavailable()));
export const chained = pipe(load, Effect.catchAll(() => Effect.succeed(0)), Effect.mapError(() => new Unavailable()));
export const viaHoisted = pipe(load, Effect.mapError(hoisted));
export const viaExpression = Effect.tryPromise({ try: write, catch: asExpression });
export const viaLet = pipe(load, Effect.mapError(reassignable));
export { reassignable };
