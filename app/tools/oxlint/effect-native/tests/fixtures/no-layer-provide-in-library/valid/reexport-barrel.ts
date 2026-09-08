// A pure re-export pre-provides no layer. A1 does not prohibit this barrel vocabulary.
import { Layer } from 'effect';

import { DepLive, GatewayLive } from './gateway.ts';

export { provide, provideMerge as merge } from 'effect/Layer';

// Allowed combinators may still be re-exported from the same barrel.
export { mergeAll, effect } from 'effect/Layer';
export const GraphLive = Layer.mergeAll(GatewayLive, DepLive);
