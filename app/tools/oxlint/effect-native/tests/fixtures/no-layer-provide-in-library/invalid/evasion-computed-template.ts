// expect-count: 2
// Evasion: computed member access written with a template literal instead of a string literal.
import { Layer } from 'effect';

import { DepLive, GatewayLive } from './gateway.ts';

export const GatewayServiceLive = GatewayLive.pipe(Layer[`provide`](DepLive));
export const MergedLive = GatewayLive.pipe(Layer[`provideMerge`](DepLive));
