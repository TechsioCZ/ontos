// expect-count: 3
// The rule already accepts `Cause["hasDies"]`; a single-quasi template literal is the same
// static member name (cf. `asStringLiteral` in rules/no-manual-tag-comparison.ts).
import * as Cause from 'effect/Cause';
import { Effect as Fx } from 'effect';

declare const cause: never;
declare const program: never;
declare const internalProblem: () => { readonly _tag: 'Internal' };

export const dies = Cause[`hasDies`](cause);
export const squashed = Cause[`squash`](cause);
export const swallowed = Fx[`catchDefect`](program, () => Fx.fail(internalProblem()));
