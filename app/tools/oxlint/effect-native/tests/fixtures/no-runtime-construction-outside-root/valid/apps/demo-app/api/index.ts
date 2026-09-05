// The BFF composition root: one Layer graph, one host runtime, `Layer.orDie` at the startup edge.
import { Effect, Layer, ManagedRuntime } from '@modern-js/plugin-bff/effect-edge';

declare const persistenceLive: Layer.Layer<never>;
declare const gatewayLive: Layer.Layer<never>;

const rootLayer = Layer.mergeAll(persistenceLive, gatewayLive);
export const hostRuntime = ManagedRuntime.make(Layer.orDie(rootLayer));
export const handle = (): Promise<void> => hostRuntime.runPromise(Effect.void);
