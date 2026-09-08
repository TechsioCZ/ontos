// expect-count: 3
import { Layer } from 'effect';

declare const Base: Layer.Layer<never>;

export const a = (Layer as typeof Layer).orDie(Base);
export const b = Layer!.orDie(Base);
export const c = (Layer satisfies typeof Layer).orDie(Base);
