// expect-count: 2
// An aliased effect import (`Types as EffectTypes`) is still a tracked effect binding.
import { Types as EffectTypes } from 'effect';

export type Aliased = EffectTypes.Simplify<{ readonly _tag: 'Aliased' }>;
export type Mutated = EffectTypes.Mutable<{ readonly _tag: 'Mutated' }>;
