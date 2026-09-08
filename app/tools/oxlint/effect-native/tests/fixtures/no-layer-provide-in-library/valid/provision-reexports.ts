// Re-exporting a combinator does not pre-provide a Live layer or hide its RIn.
import { Layer } from 'effect';
import { DepLive, GatewayLive } from './gateway.ts';
export { provide, provideMerge as merge } from 'effect/Layer';
export { mergeAll, effect } from 'effect/Layer';
export const GraphLive = Layer.mergeAll(GatewayLive, DepLive);
