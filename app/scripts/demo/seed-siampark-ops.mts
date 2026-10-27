#!/usr/bin/env node
/**
 * `pnpm demo:seed:facility-operations`: (re)seeds every Facility operations agenda (facility.operations) for Siampark 0021.
 * Runs verticals/facility-operations/scripts/reset-demo.mts with the validated local environment. Local only.
 */
import { NodeServices } from '@effect/platform-node';
import { ConfigProvider, Console, Effect, Exit, Path, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

import { resetChildEnvironment, resetEnvironment, validateResetEnvironment } from '../siampark/reset-configuration.mts';

class SeedError extends Schema.TaggedError<SeedError>()('SeedError', { reason: Schema.String }) {}

const OWNER_SCRIPT = 'verticals/facility-operations/scripts/reset-demo.mts';

const main = Effect.gen(function* seedFacilityOperations() {
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL('../..', import.meta.url));
  const fileProvider = yield* ConfigProvider.fromDotEnv({ path: path.join(root, '.env') });
  const provider = ConfigProvider.orElse(ConfigProvider.fromEnv(), fileProvider);
  const childEnvironment = resetChildEnvironment(yield* resetEnvironment.parse(provider));
  yield* validateResetEnvironment(childEnvironment);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const code = yield* spawner.exitCode(
    ChildProcess.make(process.execPath, [path.join(root, OWNER_SCRIPT), '--sales-demo', ...process.argv.slice(2)], {
      cwd: root,
      env: { ...childEnvironment, DEMO_RESET_PROFILE: 'sales', MISE_ARGV0: '' },
      stderr: 'inherit',
      stdin: 'ignore',
      stdout: 'inherit',
    }),
  );
  if (code !== ChildProcessSpawner.ExitCode(0)) {
    return yield* new SeedError({ reason: `Seed failed: ${OWNER_SCRIPT}` });
  }
  return yield* Console.log('Facility operations seeded.');
});

const exit = await Effect.runPromiseExit(
  main.pipe(
    Effect.tapError((failure) => Console.error(`facility-operations seed failed (${failure._tag}).`)),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);
process.exitCode = Exit.isFailure(exit) ? 1 : 0;
