// expect-count: 1
// Robustness: `.mts` library modules are governed like `.ts`.
import { Layer } from 'effect';

import { DepLive, GatewayLive } from './gateway.ts';

export const GatewayServiceLive = GatewayLive.pipe(Layer.provide(DepLive));
