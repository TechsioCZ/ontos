// expect-count: 2
// A direct member import handed around in shorthand object properties. The rule already reports
// `export const boot = Layer.toRuntime` as "handing the constructor around"; shorthand is the same act.
import { make } from 'effect/ManagedRuntime';
import { toRuntime } from 'effect/Layer';

export const runtimeFactories = { make };
export const layerFactories = { toRuntime };
