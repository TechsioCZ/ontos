import type { Layer } from 'effect';
import type { orDie } from 'effect/Layer';

declare const Base: Layer.Layer<never>;

// `import type` bindings are erased: nothing here can turn a layer failure into a defect.
export type Signature = typeof orDie;
export type Namespaced = typeof Layer.orDie;
export type Boundary = Layer.Layer<never>;
export const passthrough = Base;
