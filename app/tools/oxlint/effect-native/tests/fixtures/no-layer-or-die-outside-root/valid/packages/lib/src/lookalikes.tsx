import { Effect, Layer } from 'effect';

// Not effect's Layer.
const Layers = { orDie: <A,>(a: A): A => a };
declare const Base: Layer.Layer<never>;
declare const target: Layer.Layer<never>;

export const shadowed = (() => {
  // A local shadow named `Layer` is not the effect import.
  const Layer = { orDie: <A,>(a: A): A => a };
  return Layer.orDie(target);
})();

export const notLayer = Layers.orDie(target);
export const effectOrDie = Effect.orDie(Effect.succeed(1));
export const key = { orDie: true } as const;
export const property = key.orDie;
export const stillFine = Base;

export const Element = () => <div data-or-die="orDie">{String(notLayer)}</div>;
