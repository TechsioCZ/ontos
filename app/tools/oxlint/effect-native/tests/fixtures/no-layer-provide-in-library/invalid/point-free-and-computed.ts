// expect-count: 5
import { Layer, pipe } from 'effect';

import { DatabaseLive, PoolLive, TracerLive, ServiceLive } from './infrastructure.ts';

// Point-free reference passed to another combinator.
export const provideAll = [DatabaseLive, PoolLive].map(Layer.provide);

// Point-free `pipe` argument.
export const PipedLive = pipe(ServiceLive, Layer.provide(DatabaseLive));

// Computed string member access.
export const ComputedLive = ServiceLive.pipe(Layer['provide'](PoolLive));

// Optional chaining on the namespace.
export const OptionalLive = ServiceLive.pipe(Layer?.provide(TracerLive));

// Destructured escape hatch.
const { provide } = Layer;
export const DestructuredLive = provide(DatabaseLive)(ServiceLive);
