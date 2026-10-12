#!/usr/bin/env node
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { ConfigProvider, Console, Effect, Exit, Layer, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

import {
  DemoResetConfigurationError,
  resetChildEnvironment,
  resetEnvironment,
  validateResetEnvironment,
} from './reset-configuration.mts';
import type { DemoResetChildEnvironment } from './reset-configuration.mts';

const workspaceRoot = path.resolve(import.meta.dirname, '../..');
const ResetStepSchema = Schema.Literals(['migrate', 'reset', 'validate']);
type ResetStep = typeof ResetStepSchema.Type;
export const makeDemoResetCommand = (environment: DemoResetChildEnvironment, step: ResetStep) => {
  const options = {
    cwd: workspaceRoot,
    env: { ...environment, MISE_ARGV0: '' },
    extendEnv: true,
    stderr: 'inherit',
    stdin: 'ignore',
    stdout: 'inherit',
  } satisfies ChildProcess.CommandOptions;
  if (step === 'migrate') {
    return ChildProcess.make('pnpm', ['db:migrate'], options);
  }
  return ChildProcess.make(
    process.execPath,
    [path.join(workspaceRoot, 'scripts/siampark/reset-demo.mts'), ...(step === 'validate' ? ['--validate-only'] : [])],
    options,
  );
};
export const executeDemoReset = Effect.fn('SiamparkDemo.executeGuardedReset')(function* executeGuardedReset(
  environment: DemoResetChildEnvironment,
  validateOnly: boolean,
  execute: (step: ResetStep) => Effect.Effect<void, DemoResetConfigurationError>,
) {
  yield* validateResetEnvironment(environment).pipe(
    Effect.mapError(
      () => new DemoResetConfigurationError({ reason: 'Only validated local development configuration is permitted' }),
    ),
  );
  if (validateOnly) {
    return yield* execute('validate');
  }
  yield* execute('migrate');
  return yield* execute('reset');
});

const main = Effect.fn('SiamparkDemo.resetEntrypoint')(function* resetEntrypoint(validateOnly: boolean) {
  const file = yield* ConfigProvider.fromDotEnv({ path: path.join(workspaceRoot, '.env') });
  const configuration = yield* resetEnvironment
    .parse(ConfigProvider.orElse(ConfigProvider.fromEnv(), file))
    .pipe(
      Effect.mapError(
        () => new DemoResetConfigurationError({ reason: 'Required reset configuration is missing or invalid' }),
      ),
    );
  const environment = resetChildEnvironment(configuration);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* executeDemoReset(environment, validateOnly, (step) =>
    spawner.exitCode(makeDemoResetCommand(environment, step)).pipe(
      Effect.mapError(
        () => new DemoResetConfigurationError({ reason: `The validated ${step} subprocess could not start` }),
      ),
      Effect.flatMap((code) =>
        code === ChildProcessSpawner.ExitCode(0)
          ? Effect.void
          : new DemoResetConfigurationError({ reason: `The validated ${step} subprocess failed` }),
      ),
    ),
  );
});

const command = Command.make(
  'siampark-demo-reset',
  { validateOnly: Flag.Boolean('validate-only').pipe(Flag.withDefault(false)) },
  ({ validateOnly }) =>
    main(validateOnly).pipe(
      Effect.scoped,
      Effect.tapError((failure) =>
        Console.error(
          `Siampark reset failed (${failure._tag}): ${Schema.is(DemoResetConfigurationError)(failure) ? failure.reason : 'Configuration could not be loaded'}; no configuration values are logged.`,
        ),
      ),
    ),
);

if (import.meta.main) {
  const runtimeLive = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
    Layer.provide(NodeServices.layer),
  );
  const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(runtimeLive)));
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
