// Every `make` / `launch` here belongs to something that is not the effect namespace.
import { Layer, ManagedRuntime } from 'effect';

declare const appLayer: Layer.Layer<never>;

export function withCatch(): unknown {
  try {
    return Layer.provide(appLayer, appLayer);
  } catch (Layer) {
    // `Layer` is the catch binding, not the import.
    return (Layer as { launch: (a: unknown) => unknown }).launch(appLayer);
  }
}

export function withParam(ManagedRuntime: { make: (a: unknown) => unknown }): unknown {
  return ManagedRuntime.make(appLayer);
}

export const withBlockShadow = (): unknown => {
  {
    class Layer {
      static launch(value: unknown): unknown {
        return value;
      }
    }
    return Layer.launch(appLayer);
  }
};

const registry = { make: 1, launch: 2, runtime: 3 } as const;
export const reads = [registry.make, registry['launch'], registry[`runtime`]] as const;
