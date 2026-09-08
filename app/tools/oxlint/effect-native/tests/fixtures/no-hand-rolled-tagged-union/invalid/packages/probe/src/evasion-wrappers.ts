// expect-count: 6
// Transparent wrappers, including Effect's `Types.*` reached through a named import, a submodule
// namespace import and a direct member import.
import type { Types } from 'effect';
import * as EffectTypes from 'effect/Types';
import { Simplify } from 'effect/Types';

export type A = Readonly<Readonly<{ readonly _tag: 'A' }>>;
export type B = NonNullable<{ readonly _tag: 'B' }>;
export type C = Array<{ readonly _tag: 'C' }>;
export type D = Types.Simplify<{ readonly _tag: 'D' }>;
export type E = EffectTypes.Simplify<{ readonly _tag: 'E' }>;
export type F = Simplify<{ readonly _tag: 'F' }>;
