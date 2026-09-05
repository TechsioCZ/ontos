// `effect`-prefixed but unrelated packages must never be treated as Effect.
import { Schema } from 'effect-mock-toolkit';
import { Literals } from '@sinclair/typebox';

export const A = Schema.Literals(['alpha', 'beta']);
export const B = Schema.Literals(['beta', 'alpha']);
export const C = Literals(['gamma', 'delta']);
export const D = Literals(['delta', 'gamma']);
