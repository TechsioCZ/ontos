// expect-count: 1
import { Layer } from 'effect';

declare const Base: Layer.Layer<never>;

// Destructuring the namespace object is the same call, spelled point-free.
const { orDie } = Layer;

export const live = Base.pipe(orDie);
