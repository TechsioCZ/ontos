// expect-count: 3
// Evasion: the namespace object is hidden behind `as` / `satisfies` before the member access.
import { Layer, ManagedRuntime } from 'effect';

export const boot = (layer: Layer.Layer<never>) =>
  (ManagedRuntime as typeof ManagedRuntime).make(layer);
