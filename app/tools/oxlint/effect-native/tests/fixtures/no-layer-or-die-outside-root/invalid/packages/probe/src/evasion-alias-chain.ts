// expect-count: 5
import { Layer } from 'effect';
import * as EffectAll from 'effect';

declare const Base: Layer.Layer<never>;

// Chained namespace aliases, a member alias, and destructuring off the barrel all
// still resolve back to effect's `Layer.orDie` — including the aliasing site itself.
const A = Layer;
const B = A;
const die = B.orDie;
const { orDie: alsoDie } = EffectAll.Layer;
const {
  Layer: { orDie: nested },
} = EffectAll;

export const one = B.orDie(Base);
export const two = Base.pipe(die);
export const three = Base.pipe(alsoDie);
export const four = Base.pipe(nested);
