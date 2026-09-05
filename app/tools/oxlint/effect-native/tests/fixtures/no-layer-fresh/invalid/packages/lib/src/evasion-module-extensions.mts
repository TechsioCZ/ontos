// expect-count: 2
import { Layer } from 'effect';

declare const Base: Layer.Layer<never>;

// `.mts` is real source in this repo's tooling; the rule must reach it too.
export const called = Layer.fresh(Base);
export const pointFree = Base.pipe(Layer.fresh);
