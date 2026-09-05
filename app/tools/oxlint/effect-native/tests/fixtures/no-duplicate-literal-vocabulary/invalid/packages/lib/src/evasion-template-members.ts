// expect-count: 2
// Evasion: no-substitution template literals instead of quoted string members.
import { Schema } from 'effect';

export const Phase = Schema.Literals([`plan`, `apply`, `verify`]);
export const A = Schema.Struct({ phase: Schema.Literals(['apply', 'plan', 'verify']) });
export const B = Schema.Struct({ phase: Schema.Literals([`verify`, `plan`, `apply`]) });
