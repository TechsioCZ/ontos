import { Layer } from 'effect';

declare const ServiceLive: Layer.Layer<never>;

// `__tests__/` is a test path: harness composition may die eagerly.
export const harness = ServiceLive.pipe(Layer.orDie);
export const other = Layer.orDie(ServiceLive);
