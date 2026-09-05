// expect-count: 8
// Aliased submodule namespace import plus every callee-shape dodge.
import * as Fx from 'effect/Effect';

class Unavailable {}
declare const load: Fx.Effect<number, Error>;
declare const write: () => Promise<void>;

export const plain = load.pipe(Fx.mapError(() => new Unavailable()));
export const optionalCall = load.pipe(Fx.mapError?.(() => new Unavailable()));
export const optionalMember = load.pipe(Fx?.['catchAll'](() => Fx.succeed(0)));
export const parenthesised = load.pipe((Fx.mapError)(() => new Unavailable()));
export const asCast = load.pipe(Fx.mapError((() => new Unavailable()) as () => Unavailable));
export const satisfiesCast = load.pipe(Fx.mapError((() => new Unavailable()) satisfies () => Unavailable));
export const angleCast = load.pipe(Fx.mapError(<() => Unavailable>(() => new Unavailable())));
export const optionsCast = Fx.tryPromise({ try: write, catch: () => new Unavailable() } as {
  try: () => Promise<void>;
  catch: () => Unavailable;
});
