import { NodeRuntime } from '@effect/platform-node';
import { Effect, Layer, Runtime } from 'effect';

const executableLayer = Layer.empty;
const exitWhenCommandCompletes: Runtime.Teardown = (exit, onExit) => {
  Runtime.defaultTeardown(exit, (code) => {
    onExit(code);
    process.exit(code);
  });
};

if (import.meta.main) {
  NodeRuntime.runMain(Layer.build(executableLayer).pipe(Effect.scoped), { teardown: exitWhenCommandCompletes });
}
