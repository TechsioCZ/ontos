import { Layer } from 'effect';

declare const ServiceLive: Layer.Layer<never>;

// Outside `include` (docs/**): documentation samples are not production composition.
export const sample = ServiceLive.pipe(Layer.orDie);
