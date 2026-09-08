// expect-count: 3
// `as` / `!` / `satisfies` around the namespace object are transparent: ~20 sibling rules
// unwrap exactly these (see TRANSPARENT_PARENTS in rules/no-native-json-stringify.ts).
import { Cause, Effect } from 'effect';

declare const cause: Cause.Cause<never>;
declare const program: Effect.Effect<string, never>;
declare const internalProblem: () => { readonly _tag: 'Internal' };

export const squashed = (Cause as typeof Cause).squash(cause);
export const dies = Cause!.hasDies(cause);
export const swallowed = (Effect satisfies typeof Effect).catchDefect(program, () =>
  Effect.fail(internalProblem()),
);
