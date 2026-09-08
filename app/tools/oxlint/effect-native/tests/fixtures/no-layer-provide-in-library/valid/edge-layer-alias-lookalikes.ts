// Local rebindings that look like the `Layer` namespace but are not: the alias chain must terminate
// at an actual `effect` import before anything is reported.
import { Effect, Layer } from 'effect';

import { GatewayLive, DepLive } from './gateway.ts';

interface LayerPort {
  readonly provide: (name: string) => string;
  readonly provideMerge: (name: string) => string;
}

const port: LayerPort = { provide: (name) => name, provideMerge: (name) => name };

// Rebinding a look-alike port, not the effect namespace.
const Painter = port;
const { provide } = port;
export const painted = Painter.provide('grid');
export const repainted = provide('grid');

// Rebinding a different effect namespace is not `Layer`.
const Fx = Effect;
export const program = Fx.succeed(1);

// Genuine allowed use of the real namespace.
export const GraphLive = Layer.mergeAll(GatewayLive, DepLive);
