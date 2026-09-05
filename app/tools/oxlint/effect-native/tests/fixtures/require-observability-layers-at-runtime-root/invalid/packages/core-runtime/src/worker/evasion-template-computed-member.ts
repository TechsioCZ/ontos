// expect-count: 3
// Evasion: computed member access through a no-substitution template literal.
import { Layer, ManagedRuntime } from 'effect';

export const boot = (layer: Layer.Layer<never>) => ManagedRuntime[`make`](layer);
