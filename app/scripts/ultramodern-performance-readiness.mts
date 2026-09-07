#!/usr/bin/env node
import { NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, Exit, Option, Path, Schema, Stdio } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

class PerformanceReadinessError extends Schema.TaggedError<PerformanceReadinessError>()(
  'PerformanceReadinessError',
  { reason: Schema.String },
) {}

const failure = (reason: string): PerformanceReadinessError =>
  new PerformanceReadinessError({ reason });

const program = Effect.gen(function* ultramodernPerformanceReadiness() {
  const path = yield* Path.Path;
  const stdio = yield* Stdio.Stdio;
  const processSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const moduleDirectory = yield* path
    .fromFileUrl(new URL('.', import.meta.url))
    .pipe(Effect.mapError(() => failure('Unable to resolve the performance-readiness directory')));
  const defaultWorkspaceRoot = path.resolve(moduleDirectory, '..');
  const workspaceRoot = yield* Config.string('ULTRAMODERN_WORKSPACE_ROOT').pipe(
    Config.withDefault(defaultWorkspaceRoot),
    Effect.mapError(() => failure('ULTRAMODERN_WORKSPACE_ROOT is invalid')),
  );
  const createBin = yield* Config.string('ULTRAMODERN_CREATE_BIN').pipe(
    Config.option,
    Effect.map(Option.filter((value) => value.length > 0)),
    Effect.mapError(() => failure('ULTRAMODERN_CREATE_BIN is invalid')),
  );
  const forwardedArgs = yield* stdio.args;
  const ultramodernArgs = ['ultramodern', 'performance-readiness', ...forwardedArgs];
  const executable = Option.isSome(createBin) ? 'node' : 'modern-js-create';
  const executableArgs = Option.isSome(createBin)
    ? [createBin.value, ...ultramodernArgs]
    : ultramodernArgs;
  const launchTarget = Option.isSome(createBin)
    ? `node with ULTRAMODERN_CREATE_BIN=${createBin.value}`
    : 'modern-js-create from PATH';

  return Number(
    yield* processSpawner
      .exitCode(
        ChildProcess.make(executable, executableArgs, {
          env: { ULTRAMODERN_WORKSPACE_ROOT: workspaceRoot },
          extendEnv: true,
          shell: Option.isNone(createBin) && path.sep === '\\',
          stderr: 'inherit',
          stdin: 'inherit',
          stdout: 'inherit',
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          failure(
            `Failed to launch ${launchTarget} for UltraModern command "${ultramodernArgs
              .slice(1)
              .join(' ')}": ${String(error)}`,
          ),
        ),
      ),
  );
});

const exit = await Effect.runPromiseExit(
  program.pipe(
    Effect.tapError((error) => Console.error(error.reason)),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
  ),
);
process.exitCode = Exit.match(exit, {
  onFailure: () => 1,
  onSuccess: (status) => status,
});
