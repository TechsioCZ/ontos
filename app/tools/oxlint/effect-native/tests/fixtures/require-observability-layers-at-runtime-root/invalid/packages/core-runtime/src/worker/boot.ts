// expect-count: 3
// Not a declared root file, but it still constructs a runtime: A6 applies wherever the root lives.
import { Layer, ManagedRuntime as MR } from 'effect';

export const boot = (layer: Layer.Layer<never>) => MR['make'](layer);
