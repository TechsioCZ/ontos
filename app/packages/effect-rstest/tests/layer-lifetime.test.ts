import { NodeServices } from '@effect/platform-node';
import { expect, it } from '@app/effect-rstest';
import { Effect, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/unstable/process';

const runnerReport = Schema.fromJsonString(
  Schema.Struct({
    files: Schema.Array(
      Schema.Struct({
        errors: Schema.Array(Schema.Struct({ message: Schema.String })),
      }),
    ),
    summary: Schema.Struct({
      failedTests: Schema.Finite,
      passedTests: Schema.Finite,
      skippedTests: Schema.Finite,
      tests: Schema.Finite,
    }),
    unhandledErrors: Schema.Array(Schema.Unknown),
  }),
);

it.layer(NodeServices.layer, { excludeTestServices: true })((suiteIt) => {
  suiteIt.effect(
    'layer setup fibers stop on hook timeout and release resources on early failure',
    () =>
      Effect.gen(function* runLayerLifetimeFixture() {
        const child = yield* ChildProcess.make(
          process.execPath,
          [
            'node_modules/@rstest/core/bin/rstest.js',
            'run',
            '--include',
            'tests/fixtures/layer-lifetime.fixture.ts',
            '--reporter',
            'json',
            '--hookTimeout',
            '100',
            '--pool.maxWorkers',
            '1',
          ],
          {
            cwd: new URL('..', import.meta.url).pathname,
            forceKillAfter: '1 second',
            stderr: 'pipe',
            stdin: 'ignore',
            stdout: 'pipe',
          },
        );
        const [status, stdout, stderr] = yield* Effect.all(
          [
            child.exitCode,
            child.stdout.pipe(Stream.decodeText(), Stream.mkString),
            child.stderr.pipe(Stream.decodeText(), Stream.mkString),
          ],
          { concurrency: 'unbounded' },
        ).pipe(
          // oxlint-disable-next-line effect-native/no-native-timers -- subprocess deadline uses real time; remove-when: Rstest can control child-process time
          Effect.timeout('20 seconds'),
        );
        // Failing hooks must still fail the runner, not become swallowed failures.
        expect(Number(status), stderr).toBe(1);
        const report = yield* Schema.decodeEffect(runnerReport)(stdout);
        expect(report.summary).toEqual({
          failedTests: 0,
          passedTests: 6,
          skippedTests: 6,
          tests: 12,
        });
        expect(report.unhandledErrors).toEqual([]);
        expect(report.files).toHaveLength(1);
        const errors = report.files.flatMap((file) => file.errors);
        expect(errors.map((error) => error.message)).toEqual([
          'beforeAll hook timed out in 100ms',
          'beforeAll hook timed out in 100ms',
          'early-setup-failure',
          'beforeAll hook timed out in 100ms',
          'beforeAll hook timed out in 100ms',
          'early-setup-failure',
        ]);
      }),
    30_000,
  );
});
