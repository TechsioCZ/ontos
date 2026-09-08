// expect-count: 2
import { Layer } from 'effect';
import * as EffectAll from 'effect';

declare const Base: Layer.Layer<never>;

// A one-line local alias of the namespace hides every later member access.
const Lay = Layer;
const { Layer: FromBarrel } = EffectAll;

export const live = Lay.orDie(Base);
export const other = FromBarrel.orDie(Base);
