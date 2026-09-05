import { Layer } from 'effect';

declare const ServiceLive: Layer.Layer<never>;
declare const StubLive: Layer.Layer<never>;

// Tests are out of scope: harness composition may die eagerly.
export const testLayer = ServiceLive.pipe(Layer.provide(StubLive), Layer.orDie);
export const another = Layer.orDie(ServiceLive);
