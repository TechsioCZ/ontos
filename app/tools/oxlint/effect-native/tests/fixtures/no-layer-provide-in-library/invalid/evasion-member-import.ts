// expect-count: 3
// Evasion: the member itself is imported from `effect/Layer`, so there is no `Layer.` member
// expression to match. This is the same escape hatch as `const { provide } = Layer`, one step earlier.
import { provide, provideMerge as merge } from 'effect/Layer';

import { DepLive, GatewayLive } from './gateway.ts';

export const GatewayServiceLive = GatewayLive.pipe(provide(DepLive));
export const MergedLive = GatewayLive.pipe(merge(DepLive));
export const provideAll = [DepLive].map(provide);
