#!/usr/bin/env node
import { resolveEffectTsrsCompiler } from '@modern-js/app-tools-extensions/config';
import { Effect, Path, Schema } from 'effect';
import { Argument, Command } from 'effect/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { runQualityCli } from './quality-cli-lifecycle.mts';

class EffectDiagnosticsFailed extends Schema.TaggedError<EffectDiagnosticsFailed>()('EffectDiagnosticsFailed', {
  code: Schema.Number,
  project: Schema.String,
}) {}
const encodeRequest = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      cwd: Schema.String,
      format: Schema.Literal('text'),
      project: Schema.String,
      severity: Schema.Literal('error,warning'),
      strict: Schema.Literal(true),
    }),
  ),
);
// The launcher's generic diagnostics subcommand selects a Go executable. Its cohort Rust binary
// supports the same project-scoped request, including the nonzero exit for warnings in strict mode.
const cli = Command.make(
  'check-effect-diagnostics',
  { projects: Argument.String('project').pipe(Argument.atLeast(1)) },
  Effect.fn('EffectDiagnostics.run')(function* check({ projects }) {
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const cwd = path.resolve('.');
    const compiler = resolveEffectTsrsCompiler({ from: import.meta.url });
    for (const project of projects) {
      const request = yield* encodeRequest({
        cwd,
        format: 'text',
        project: path.resolve(cwd, project),
        severity: 'error,warning',
        strict: true,
      });
      const code = yield* spawner.exitCode(
        ChildProcess.make(compiler, ['--effect-cli-diagnostics', request], {
          cwd,
          stderr: 'inherit',
          stdin: 'ignore',
          stdout: 'inherit',
        }),
      );
      if (code !== 0) {yield* new EffectDiagnosticsFailed({ code, project });}
    }
  }),
);
runQualityCli(Command.run(cli, { version: '1.0.0' }));
