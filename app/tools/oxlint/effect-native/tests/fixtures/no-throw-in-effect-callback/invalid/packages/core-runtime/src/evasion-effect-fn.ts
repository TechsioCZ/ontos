// expect-count: 2
// EVASION (currently missed): audit A6 tells this codebase to "adopt `Effect.fn` for service
// operations and handlers". The canonical spelling is curried — `Effect.fn(name)(function* () {…})`
// — so the callee of the call that owns the callback is a CallExpression, not `Effect.<member>`.
// Both throws below are exactly the S1 rollback sentinel / A4 blanket failure the rule exists for.
import { Effect, Exit } from 'effect';

class ActionRollbackSignal {
  readonly token: symbol;
  readonly cause: unknown;
  constructor(token: symbol, cause: unknown) {
    this.token = token;
    this.cause = cause;
  }
}

declare const handler: Effect.Effect<string, Error>;

export const runGovernedAction = Effect.fn('runGovernedAction')(function* (token: symbol) {
  const exit = yield* Effect.exit(handler);
  if (Exit.isFailure(exit)) {
    throw new ActionRollbackSignal(token, exit.cause);
  }
  return exit.value;
});

export const lockInvocation = Effect.fn('lockInvocation', Effect.tapErrorCause(Effect.logError))(
  function* () {
    throw new Error('The Action invocation no longer exists');
  },
);
