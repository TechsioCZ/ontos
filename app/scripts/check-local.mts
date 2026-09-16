#!/usr/bin/env node
import { Console, Effect, Path, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

import { runQualityCli } from './quality-cli-lifecycle.mts';

// Explicit scopes, not a guessed changed-file dependency graph. Full is the safe default.
const localValidationScripts = {
  full: ['check'],
  'lint-rules': ['typecheck:lint-rules', 'test:lint-rules'],
  quality: ['quality:audit:test'],
  scripts: ['test:scripts'],
  unit: ['test:unit'],
} as const;

class LocalValidationError extends Schema.TaggedError<LocalValidationError>()('LocalValidationError', {
  message: Schema.String,
}) {}

const cli = Command.make(
  'check-local',
  {
    dryRun: Flag.boolean('dry-run').pipe(Flag.withDefault(false)),
    scope: Flag.choice('scope', ['full', 'lint-rules', 'quality', 'scripts', 'unit']).pipe(Flag.withDefault('full')),
  },
  ({ dryRun, scope }) =>
    Effect.gen(function* checkLocalCommand() {
      const path = yield* Path.Path;
      const root = yield* path.fromFileUrl(new URL('..', import.meta.url));
      if (scope !== 'full') {
        yield* Console.log('Focused feedback only. Run pnpm check and task-required tests before completion.');
      }
      yield* Effect.forEach(
        localValidationScripts[scope],
        Effect.fn(function* runLocalValidationScript(script) {
          yield* Console.log(`pnpm ${script}`);
          if (dryRun) {
            return;
          }
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const code = yield* spawner.exitCode(
            ChildProcess.make('pnpm', [script], {
              cwd: root,
              stderr: 'inherit',
              stdin: 'inherit',
              stdout: 'inherit',
            }),
          );
          if (code !== ChildProcessSpawner.ExitCode(0)) {
            yield* Effect.fail(new LocalValidationError({ message: `${script} failed with exit code ${code}` }));
          }
        }),
        { concurrency: 1, discard: true },
      );
    }),
);

if (Schema.is(Schema.Struct({ main: Schema.Literal(true) }))(import.meta)) {
  runQualityCli(Command.run(cli, { version: '1.0.0' }));
}
