// expect-count: 3
import { Layer } from 'effect';
import * as EffectNs from 'effect';

declare const Base: Layer.Layer<never>;

export const optional = Layer?.fresh(Base);
export const optionalComputed = Layer?.['fresh'](Base);
export const rootOptional = EffectNs.Layer?.fresh(Base);
