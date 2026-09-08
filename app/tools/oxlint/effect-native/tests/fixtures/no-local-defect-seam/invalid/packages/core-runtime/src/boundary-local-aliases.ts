// expect-count: 2
import { Cause, Effect } from 'effect';
const C = Cause;
export const inspect = (cause: unknown) => C[`hasDies`](cause as never);
const E = Effect;
export const handle = E.catchDefect(() => E.succeed('collapsed'));
