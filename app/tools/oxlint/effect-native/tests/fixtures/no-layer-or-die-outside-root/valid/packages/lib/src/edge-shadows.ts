import { Layer } from 'effect';

declare const Base: Layer.Layer<never>;

// Every `orDie` below belongs to a local shadow, never to effect's `Layer`.
export function viaParameter(Layer: { orDie: (value: unknown) => unknown }): unknown {
  return Layer.orDie(Base);
}

export function viaCatch(): unknown {
  try {
    return Base;
  } catch (Layer) {
    return (Layer as { orDie: (value: unknown) => unknown }).orDie(Base);
  }
}

export function viaClassDeclaration(): unknown {
  class Layer {
    static orDie(value: unknown): unknown {
      return value;
    }
  }
  return Layer.orDie(Base);
}

export const viaBlockConst = (() => {
  {
    const Layer = { orDie: (value: unknown): unknown => value };
    return Layer.orDie(Base);
  }
})();
