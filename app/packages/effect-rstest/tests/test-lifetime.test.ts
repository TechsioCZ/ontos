import { NodeServices } from '@effect/platform-node';
import { expect, it } from '@app/effect-rstest';
import { Effect, FileSystem, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/unstable/process';

const runnerReport = Schema.fromJsonString(
  Schema.Struct({
    files: Schema.Array(
      Schema.Struct({ errors: Schema.Array(Schema.Struct({ message: Schema.String })) }),
    ),
    summary: Schema.Struct({
      failedTests: Schema.Finite,
      passedTests: Schema.Finite,
      skippedTests: Schema.Finite,
      tests: Schema.Finite,
    }),
    tests: Schema.Array(
      Schema.Struct({
        errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
        name: Schema.String,
        status: Schema.String,
      }),
    ),
    unhandledErrors: Schema.Array(Schema.Unknown),
  }),
);

it.layer(NodeServices.layer, { excludeTestServices: true })((suiteIt) => {
  suiteIt.effect(
    'test timeout cleanup settles before later tests and suite release without changing outcomes',
    () =>
      Effect.gen(function* runTestLifetimeFixture() {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: 'effect-rstest-test-lifetime-',
        });
        const config = `${directory}/rstest.config.mjs`;
        yield* fs.writeFileString(
          config,
          `export default {
            testEnvironment: 'node',
            reporters: [['json', { outputPath: new URL('./report.json', import.meta.url).pathname }]],
          };`,
        );
        const child = yield* ChildProcess.make(
          process.execPath,
          [
            'node_modules/@rstest/core/bin/rstest.js',
            'run',
            '--include',
            'tests/fixtures/test-lifetime.fixture.ts',
            '--config',
            config,
            '--pool.maxWorkers',
            '1',
            '--hookTimeout',
            '50',
          ],
          {
            cwd: new URL('..', import.meta.url).pathname,
            env: { RSTEST_NO_AGENT: '1' },
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
        );
        expect(Number(status), `${stdout}\n${stderr}`).toBe(1);
        const report = yield* fs
          .readFileString(`${directory}/report.json`)
          .pipe(Effect.flatMap(Schema.decodeEffect(runnerReport)));
        expect(report.summary).toEqual({
          failedTests: 3,
          passedTests: 20,
          skippedTests: 2,
          tests: 25,
        });
        expect(report.unhandledErrors).toEqual([]);
        expect(report.files).toHaveLength(1);
        expect(report.files.flatMap((file) => file.errors)).toEqual([]);
        const failures = report.tests.filter((test) => test.status === 'fail');
        expect(failures.map((test) => test.name)).toEqual([
          'timeout',
          'failure',
          'unexpected-success',
        ]);
        expect(failures.flatMap((test) => test.errors ?? []).map((error) => error.message)).toEqual(
          [
            'test timed out in 30ms (no expect assertions completed)',
            'intentional-test-failure',
            'Expect test to fail',
          ],
        );
        for (const name of ['expected-timeout', 'expected-failure', 'success']) {
          expect(report.tests.find((test) => test.name === name)?.status).toBe('pass');
        }
        for (const name of ['skipped', 'runtime-skip']) {
          expect(report.tests.find((test) => test.name === name)?.status).toBe('skip');
        }
      }),
    30_000,
  );
});
