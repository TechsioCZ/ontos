#!/usr/bin/env node
import { Clock, Console, Effect, Schema, Semaphore, Stream } from 'effect';
import { Command, Flag } from 'effect/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import { runQualityCli } from './quality-cli-lifecycle.mts';

// `pnpm check` runs these package scripts. A lane runs its scripts in order and stops at the first
// failure; lanes run side by side under one concurrency limit, and every lane runs to completion.
//
// Two scripts write into the source tree, so the schedule keeps them apart from the scripts that read it:
// - check:module-contracts creates and deletes bundles under verticals/, so it runs before every lane.
// - test:lint-rules writes fixture workspaces under tools/oxlint/effect-native/tests/, so it starts only
//   after every tree-reading lane has finished. lint and typecheck read explicit paths, so they run beside it.
const firstLane = ['check:module-contracts'];
const explicitPathLanes = [['lint'], ['typecheck']];
const treeReadingLanes = [
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
];
const afterTreeReadersLane = ['typecheck:lint-rules', 'test:lint-rules'];

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

      const runLanes = (lanes: readonly (readonly string[])[]) =>
        Effect.forEach(lanes, runLane, { concurrency: 'unbounded', discard: true });

      yield* runLane(firstLane);
      yield* Effect.all(
        [runLanes(explicitPathLanes), runLanes(treeReadingLanes).pipe(Effect.andThen(runLane(afterTreeReadersLane)))],
        { concurrency: 'unbounded', discard: true },
      );

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
