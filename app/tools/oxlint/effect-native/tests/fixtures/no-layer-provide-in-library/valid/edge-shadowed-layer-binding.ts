// Regression fixture for a false positive: the member expression is matched purely from the
// module-level import table, without the `getScope` check the sibling A1 rule
// (`no-layer-or-die-outside-root`) already performs. A local binding that shadows the `Layer`
// namespace is not the effect `Layer` module.
import { Layer } from 'effect';

import { GatewayLive, DepLive } from './gateway.ts';

export interface LayerPort {
  readonly provide: (name: string) => string;
  readonly provideMerge: (name: string) => string;
}

// Genuine, allowed combinator use so the file still imports the real namespace.
export const GraphLive = Layer.mergeAll(GatewayLive, DepLive);

// Parameter shadows the import: `Layer` here is the caller's port, not `effect/Layer`.
export const describePort = (Layer: LayerPort): string => Layer.provide('grid');

export const nestedShadow = (port: LayerPort): string => {
  const Layer = port;
  return Layer.provideMerge('overlay');
};
