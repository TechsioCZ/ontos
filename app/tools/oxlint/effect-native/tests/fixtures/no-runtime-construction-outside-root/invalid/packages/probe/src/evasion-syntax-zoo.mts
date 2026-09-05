// expect-count: 2
// `.mts` with top-level await, `using` -free but decorator-free modern syntax: construction inside
// an awaited IIFE and inside a labelled block is still construction.
import { Layer, ManagedRuntime } from 'effect';

declare const appLayer: Layer.Layer<never>;

export const topLevel = await (async () => ManagedRuntime.make(appLayer))();

boot: {
  void Layer.toRuntime(appLayer);
  break boot;
}
