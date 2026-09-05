// `scripts/**` is out of scope (`includeScripts`, default false): the process-exit adapter may die.
import { Cause, Effect, Exit } from 'effect';

declare const migrate: Effect.Effect<void, Error>;

export const main = async (): Promise<void> => {
  const exit = await Effect.runPromiseExit(migrate);
  if (Exit.isFailure(exit) && Cause.hasDies(exit.cause)) process.exitCode = 1;
};
