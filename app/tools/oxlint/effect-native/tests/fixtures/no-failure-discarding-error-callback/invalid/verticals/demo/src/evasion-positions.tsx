// expect-count: 9
// Syntactic positions: class members, static block, async generator, nested arrows, decorators,
// template literals and JSX — all inside a `.tsx` file.
import { Effect } from 'effect';

class RouteFailure {}
declare const load: Effect.Effect<number, Error>;
declare function trace(target: unknown, context: unknown): void;

export class Repository {
  static readonly boot = load.pipe(Effect.mapError(() => new RouteFailure()));
  readonly instance = load.pipe(Effect.mapError(() => new RouteFailure()));
  #hidden = load.pipe(Effect.mapError(() => new RouteFailure()));

  static {
    void load.pipe(Effect.mapError(() => new RouteFailure()));
  }

  @trace read() {
    return this.#hidden ?? load.pipe(Effect.catchAll(() => Effect.succeed(0)));
  }
}

export async function* stream() {
  yield load.pipe(Effect.mapError(() => new RouteFailure()));
}

export const curried = () => () => load.pipe(Effect.mapError(() => new RouteFailure()));

export const interpolated = `${String(load.pipe(Effect.mapError(() => new RouteFailure())))}`;

export const View = () => <div>{String(load.pipe(Effect.catchCause(() => Effect.succeed(0))))}</div>;
