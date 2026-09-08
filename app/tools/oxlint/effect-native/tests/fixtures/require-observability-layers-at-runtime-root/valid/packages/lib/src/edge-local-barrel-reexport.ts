// A relative re-export wrapper cannot be resolved syntactically; it is not treated as an Effect root.
import { Layer, ManagedRuntime } from './effect-barrel.ts';

declare const libLayer: Layer.Layer<never>;

export const boot = () => ManagedRuntime.make(libLayer);
