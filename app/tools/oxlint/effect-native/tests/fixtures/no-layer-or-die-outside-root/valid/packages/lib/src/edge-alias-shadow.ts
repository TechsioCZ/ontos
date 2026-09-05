import { Layer } from 'effect';

declare const Base: Layer.Layer<never>;

// An alias of a look-alike object, and aliases built from a *shadowed* `Layer`.
const Fake = { orDie: <A,>(a: A): A => a };
const AliasOfFake = Fake;

export const notEffect = AliasOfFake.orDie(Base);

export function inner(Layer: { orDie: <A>(a: A) => A }): unknown {
  const Local = Layer;
  const { orDie } = Layer;
  return [Local.orDie(Base), orDie(Base)];
}

export const transparent = Base.pipe(Layer.provide(Base));
