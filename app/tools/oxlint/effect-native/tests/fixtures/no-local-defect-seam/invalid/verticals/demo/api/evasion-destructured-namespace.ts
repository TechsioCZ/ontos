// expect-count: 2
// `const { stringify } = JSON` is handled by rules/no-native-json-stringify.ts; the same
// destructuring of an Effect namespace hides this seam completely.
import { Cause, Effect } from 'effect';

const { catchDefect } = Effect;
const { hasDies: dies } = Cause;

declare const program: Effect.Effect<string, never>;
declare const internalProblem: () => { readonly _tag: 'Internal' };

export const handler = catchDefect(program, () => Effect.fail(internalProblem()));
export const split = (cause: Cause.Cause<never>): boolean => dies(cause);
