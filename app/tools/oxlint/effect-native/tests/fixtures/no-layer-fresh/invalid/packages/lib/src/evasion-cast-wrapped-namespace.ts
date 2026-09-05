// expect-count: 3
import { Layer } from 'effect';

declare const Base: Layer.Layer<never>;

// Type-level wrappers around the namespace do not change what is called at runtime.
export const cast = (Layer as typeof Layer).fresh(Base);
export const nonNull = Layer!.fresh(Base);
export const satisfied = (Layer satisfies typeof Layer).fresh(Base);
