// expect-count: 1
// `apps/*/api/index.ts` is a composition root, but A1 allows exactly one runtime per host:
// the second construction is still reported.
import { Layer, ManagedRuntime } from 'effect';

declare const shellLayer: Layer.Layer<never>;
declare const workerLayer: Layer.Layer<never>;

export const shellRuntime = ManagedRuntime.make(shellLayer);
export const workerRuntime = ManagedRuntime.make(workerLayer);
