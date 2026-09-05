// expect-count: 3
// Evasion: the factory and the namespace are smuggled through local `const` aliases.
import { Schema } from 'effect';
import { Literals } from 'effect/Schema';

const Vocabulary = Schema.Literals;
const Sch = Schema;
const Direct = Literals;

export const A = Vocabulary(['plan', 'apply', 'verify']);
export const B = Sch.Literals(['verify', 'apply', 'plan']);
export const C = Direct([`apply`, `plan`, `verify`]);
export const D = Schema.Literals(['apply', 'verify', 'plan']);
