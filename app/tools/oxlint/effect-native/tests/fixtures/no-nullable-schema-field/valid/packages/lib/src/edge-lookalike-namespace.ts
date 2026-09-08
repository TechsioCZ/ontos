import { Schema } from 'effect';
import * as EffectModule from 'effect/Effect';

// `effect/Effect` is not the root barrel, and a plain object member is not a Schema combinator.
const orm = { NullOr: (value: string) => value };

export const A = orm.NullOr('x');
export const B = EffectModule.Schema?.NullOr;
export const C = Schema.OptionFromNullishOr(Schema.String);
