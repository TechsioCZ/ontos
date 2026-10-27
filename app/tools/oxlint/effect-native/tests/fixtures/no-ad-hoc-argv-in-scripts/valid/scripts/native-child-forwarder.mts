// Frozen first-party forwarding shape from scripts/demo/seed-siampark-ops.mts.
import { Effect, Path } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

declare const childEnvironment: Readonly<Record<string, string>>;
const OWNER_SCRIPT = 'verticals/facility-operations/scripts/reset-demo.mts';

export const main = Effect.gen(function* seedFacilityOperations() {
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL('../..', import.meta.url));
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.exitCode(
    ChildProcess.make(process.execPath, [path.join(root, OWNER_SCRIPT), '--sales-demo', ...process.argv.slice(2)], {
      cwd: root,
      env: { ...childEnvironment, DEMO_RESET_PROFILE: 'sales', MISE_ARGV0: '' },
      stderr: 'inherit',
      stdin: 'ignore',
      stdout: 'inherit',
    }),
  );
});
