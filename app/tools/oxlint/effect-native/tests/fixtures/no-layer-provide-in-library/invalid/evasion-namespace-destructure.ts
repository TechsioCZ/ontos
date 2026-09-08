// expect-count: 2
// Evasion: the `Layer` module is rebound locally from an `import * as Effect from "effect"` root
// namespace, so the reference is no longer a direct import binding.
import * as Effect from 'effect';

import { DepLive, GatewayLive } from './gateway.ts';

const { Layer } = Effect;
const LayerAlias = Effect.Layer;

export const GatewayServiceLive = GatewayLive.pipe(Layer.provide(DepLive));
export const MergedLive = GatewayLive.pipe(LayerAlias.provideMerge(DepLive));
