#!/usr/bin/env node
import { Console, Effect, Path, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import { runQualityCli } from './quality-cli-lifecycle.mts';

// Explicit scopes, not a guessed changed-file dependency graph. Full is the safe default.
// `tooling` runs the same commands as CI's Repository Tooling gate.
const localValidationScripts = {
  full: ['check'],
  generation: ['test:generation'],
  'lint-rules': ['typecheck:lint-rules', 'test:lint-rules'],
  quality: ['quality:audit:test'],
  scripts: ['test:scripts'],
  tooling: ['shell:ui-candidates:check', 'test:scripts', 'module-entrypoints:check', 'test:generation'],
  unit: ['test:unit'],
} as const;

const fullScopeNotice = [
  'pnpm check does not run these CI gates:',
  '  Repository Tooling: pnpm check:local --scope tooling',
  '  Unit and component tests: pnpm check:local --scope unit',
  '  Integration, browser, and Node artifact builds run in CI.',
].join('\n');

class LocalValidationError extends Schema.TaggedError<LocalValidationError>()('LocalValidationError', {
  message: Schema.String,
}) {}

const cli = Command.make(
  'check-local',
  {
    dryRun: Flag.Boolean('dry-run').pipe(Flag.withDefault(false)),
    scope: Flag.Literals('scope', ['full', 'generation', 'lint-rules', 'quality', 'scripts', 'tooling', 'unit']).pipe(
      Flag.withDefault('full'),
    ),
  },
  ({ dryRun, scope }) =>
    Effect.gen(function* checkLocalCommand() {
      const path = yield* Path.Path;
      const root = yield* path.fromFileUrl(new URL('..', import.meta.url));
      yield* Console.log(
        scope === 'full'
          ? fullScopeNotice
          : 'Focused feedback only. Run pnpm check and task-required tests before completion.',
      );
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
