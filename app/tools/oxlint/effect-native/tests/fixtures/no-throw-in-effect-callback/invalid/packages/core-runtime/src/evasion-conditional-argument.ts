// expect-count: 2
// EVASION (currently missed): the callback reaches the combinator through a `??` or `?:` expression.
// `ArrayExpression` and `SpreadElement` are already treated as argument wrappers, but the two far
// more common conditional wrappers are not, so a single `?? (async () => …)` hides the sentinel.
import { Effect } from 'effect';

class ReadRollback {
  readonly cause: unknown;
  constructor(cause: unknown) {
    this.cause = cause;
  }
}

declare const overrideBody: (() => Promise<number>) | undefined;
declare const strict: boolean;

export const runGovernedRead = Effect.tryPromise({
  try:
    overrideBody ??
    (async () => {
      throw new ReadRollback('the governed read transaction was interrupted');
    }),
  catch: (error: unknown) => error,
});

export const decode = Effect.sync(
  strict
    ? () => {
        throw new Error('strict descriptor decoding failed');
      }
    : () => 0,
);
