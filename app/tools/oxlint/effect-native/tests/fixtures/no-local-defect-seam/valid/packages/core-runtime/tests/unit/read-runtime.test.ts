// Tests are out of scope (`includeTests`, default false): harness assertions may inspect the cause.
import { Cause, Effect, Exit } from 'effect';

declare const program: Effect.Effect<string, Error>;

export const assertDefect = async (): Promise<boolean> => {
  const exit = await Effect.runPromise(Effect.exit(program));
  return Exit.isFailure(exit) && Cause.hasDies(exit.cause);
};

export const swallowed = program.pipe(Effect.catchDefect(() => Effect.succeed('stub')));
