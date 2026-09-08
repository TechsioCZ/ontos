// expect-count: 2
// The BFF edge barrel re-exports Effect namespaces verbatim; `api/server.ts` is not a root file.
import { Layer, ManagedRuntime } from '@modern-js/plugin-bff/effect-edge';

declare const edgeLayer: Layer.Layer<never>;

export const edgeRuntime = ManagedRuntime.make(edgeLayer);
export const built = Layer.toRuntime(edgeLayer);
