// expect-count: 6
// S1/A4: the governed Read engine splits the Cause by hand before throwing a private rollback sentinel.
import { Cause, Effect, Exit } from 'effect';

declare const readHandlerExecutionError: () => Error;

export const unwrapCore = <Value>(exit: Exit.Exit<Value, Error>): Value => {
  if (Exit.isFailure(exit)) {
    if (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause)) {
      throw readHandlerExecutionError();
    }
    const failure = Cause.findErrorOption(exit.cause);
    if (failure._tag === 'Some') {
      throw failure.value;
    }
    throw readHandlerExecutionError();
  }
  return exit.value;
};

export const scopeGuard = <Value>(scopeExit: Exit.Exit<Value, Error>): Effect.Effect<void, never> => {
  if (Exit.isFailure(scopeExit)) {
    const failure = Cause.findErrorOption(scopeExit.cause);
    if (!Cause.hasDies(scopeExit.cause) && !Cause.hasInterrupts(scopeExit.cause) && failure._tag === 'Some') {
      return Effect.logError('denied');
    }
  }
  return Effect.void;
};
