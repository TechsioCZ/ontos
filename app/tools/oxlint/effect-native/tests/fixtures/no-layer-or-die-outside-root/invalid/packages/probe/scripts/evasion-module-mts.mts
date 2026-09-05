// expect-count: 2
import * as Layer from 'effect/Layer';

declare const Base: Layer.Layer<never>;

export const a = Layer.orDie(Base);
export const b = Base.pipe(Layer.orDie);
