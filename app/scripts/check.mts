#!/usr/bin/env node
import { Clock, Console, Effect, Schema, Semaphore, Stream } from 'effect';
import { Command, Flag } from 'effect/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import { runQualityCli } from './quality-cli-lifecycle.mts';

// `pnpm check` runs these package scripts. A lane runs its scripts in order and stops at the first
// failure; lanes run side by side under one concurrency limit, and every lane runs to completion.
//
// check:module-contracts creates and deletes bundles under verticals/, so it runs alone before every
// other lane. No later script writes into the scanned source tree: test:lint-rules lints virtual
// filenames in process and stages on-disk cases only below the ignored .codex/reports/ or the
// operating-system temporary directory. Every remaining lane therefore starts together.
const firstLane = ['check:module-contracts'];
const parallelLanes = [
  ['lint'],
  ['typecheck'],
  ['quality:audit', 'quality:audit:gate', 'lint:suppressions'],
  ['api:check'],
  ['api:check:ontos'],
  ['module-entrypoints:check'],
  ['contract:check'],
  ['database-access:check'],
  ['lean-core:check'],
  ['format:check'],
  ['i18n:boundaries'],
  ['action:test:unit'],
  ['skills:check'],
  ['performance:readiness'],
  ['typecheck:lint-rules', 'test:lint-rules'],
  ['lint:repository-policy'],
];

class CheckFailedError extends Schema.TaggedError<CheckFailedError>()('CheckFailedError', {
  message: Schema.String,
}) {}

const cli = Command.make(
  'check',
  {
    // The lint step alone peaks near 11 GB; four lanes fit a 32 GB machine.
    concurrency: Flag.Int('concurrency').pipe(Flag.withDefault(4)),
  },
  ({ concurrency }) =>
    Effect.gen(function* checkCommand() {
      const root = new URL('..', import.meta.url).pathname;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const permits = yield* Semaphore.make(Math.max(1, concurrency));
      const failures: string[] = [];
      const startedAt = yield* Clock.currentTimeMillis;

      const runScript = Effect.fn(function* runScript(script: string) {
        const scriptStartedAt = yield* Clock.currentTimeMillis;
        const { exitCode, output } = yield* Effect.scoped(
          Effect.gen(function* spawnScript() {
            const handle = yield* spawner.spawn(
              ChildProcess.make('pnpm', [script], { cwd: root, stderr: 'pipe', stdin: 'ignore', stdout: 'pipe' }),
            );
            const [code, text] = yield* Effect.all([handle.exitCode, Stream.mkString(Stream.decodeText(handle.all))], {
              concurrency: 'unbounded',
            });
            return { exitCode: Number(code), output: text };
          }),
        );
        const seconds = ((yield* Clock.currentTimeMillis) - scriptStartedAt) / 1000;
        const passed = exitCode === 0;
        const outcome = passed ? 'passed' : `failed with exit code ${exitCode}`;
        yield* Console.log(`\n--- pnpm ${script}: ${outcome} in ${seconds.toFixed(1)} s\n${output}`);
        if (!passed) {
          failures.push(script);
        }
        return passed;
      });

      const runLane = Effect.fn(function* runLane(lane: readonly string[]) {
        for (const script of lane) {
          if (!(yield* permits.withPermit(runScript(script)))) {
            return;
          }
        }
      });

      yield* runLane(firstLane);
      yield* Effect.forEach(parallelLanes, runLane, { concurrency: 'unbounded', discard: true });

      const seconds = ((yield* Clock.currentTimeMillis) - startedAt) / 1000;
      if (failures.length > 0) {
        const failed = failures.map((script) => `pnpm ${script}`).join(', ');
        return yield* Effect.fail(
          new CheckFailedError({ message: `pnpm check failed after ${seconds.toFixed(1)} s: ${failed}` }),
        );
      }
      return yield* Console.log(`\npnpm check passed in ${seconds.toFixed(1)} s.`);
    }),
);

if (Schema.is(Schema.Struct({ main: Schema.Literal(true) }))(import.meta)) {
  runQualityCli(Command.run(cli, { version: '1.0.0' }));
}
