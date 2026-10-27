// expect-count: 1
import { NodeRuntime } from '@effect/platform-node';
import { Effect, Exit, Runtime } from 'effect';

const exitWhenCommandCompletes: Runtime.Teardown = (exit, onExit) => {
  Runtime.defaultTeardown(exit, (code) => {
    onExit(code);
    process.exit(code);
  });
};

exitWhenCommandCompletes(Exit.succeed(undefined), () => {});
NodeRuntime.runMain(Effect.void, { teardown: exitWhenCommandCompletes });
