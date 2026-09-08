import { Effect, Layer } from 'effect';

// Not effect's Layer module.
const Layers = { fresh: <A,>(a: A): A => a };
declare const Base: Layer.Layer<never>;
declare const target: Layer.Layer<never>;

export const shadowed = (() => {
  // A local shadow named `Layer` is not the effect import.
  const Layer = { fresh: <A,>(a: A): A => a };
  return Layer.fresh(target);
})();

export const notLayer = Layers.fresh(target);
export const shadowedParameter = (Layer: { fresh: (value: unknown) => unknown }) => Layer.fresh(target);
export const cacheFlag = { fresh: true } as const;
export const readFlag = cacheFlag.fresh;
export const label = 'Layer.fresh';
export const effectMemberElsewhere = Effect.succeed(1);
export const stillFine = Base;

export const Element = () => <div data-fresh="fresh" className="fresh">{String(notLayer)}</div>;
