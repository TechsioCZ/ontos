// expect-count: 2
import { Layer } from 'effect';

declare const Base: Layer.Layer<never>;
declare const toDefect: (cause: unknown) => unknown;

export const a = Base.pipe(Layer.orDieWith(toDefect));
export const b = Layer.orDie(Base);
