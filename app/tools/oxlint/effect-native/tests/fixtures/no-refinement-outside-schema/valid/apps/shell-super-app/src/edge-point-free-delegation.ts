// False-positive probe: point-free delegation where the predicate type is carried by an `as` clause
// instead of a variable annotation, and where the delegate is an `effect/Predicate` named import used
// as a value. Both are the same "typing seam over the one authority" the rule blesses for
// `const f: (v: unknown) => v is T = Schema.is(S)` and for `(v) => isString(v)`.
import { Schema } from 'effect';
import { isString } from 'effect/Predicate';

export const SessionSchema = Schema.Struct({ sessionId: Schema.String });
export type Session = typeof SessionSchema.Type;

export const isSession = Schema.is(SessionSchema) as (value: unknown) => value is Session;

export const isText: (value: unknown) => value is string = isString;
