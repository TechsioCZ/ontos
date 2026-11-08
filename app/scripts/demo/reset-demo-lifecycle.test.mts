import { NodeServices } from '@effect/platform-node';
import { Effect, Fiber, FileSystem, Path, Schedule, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { expect, it } from 'effect-rstest';

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const readySchema = Schema.Struct({ fixture: Schema.String, pid: Schema.Int.check(Schema.isGreaterThan(1)) });
const handoffUrl = new URL('sales-customer-fixture.mts', import.meta.url).href;
const resetUrl = new URL('reset-demo.mts', import.meta.url);

/** Read the actual entry footer without importing or executing the reset/configuration program. */
const resetFooter = Effect.gen(function* readActualFooter() {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* fs.readFileString(resetUrl.pathname);
  const offset = source.lastIndexOf('const runtimeLive = ');
  expect(offset).toBeGreaterThan(0);
  return source.slice(offset);
});

const waitForFile = Effect.fn('SalesDemoSignalTest.waitForFile')(function* waitForFile(file: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs
    .exists(file)
    .pipe(
      Effect.repeat({ schedule: Schedule.spaced('10 millis'), until: (exists) => exists }),
      Effect.timeout('5 seconds'),
    );
});

const ownerSource = (directory: string) => `
  import { NodeRuntime, NodeServices } from '@effect/platform-node';
  import { Effect, FileSystem, Layer, Schedule } from 'effect';
  const directory = ${encodeJson(directory)};
  const fixture = process.argv[1];
  const main = Effect.scoped(Effect.gen(function* dummyOwner() {
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.addFinalizer(() => Effect.gen(function* finishDummyOwner() {
        yield* fs.writeFileString(directory + '/signalled', 'owner-finalizing', { flag: 'wx' });
        yield* fs.exists(directory + '/release-owner').pipe(
          Effect.repeat({ schedule: Schedule.spaced('10 millis'), until: exists => exists })
        );
        yield* fs.writeFileString(directory + '/stopped',
          JSON.stringify({ fixtureExistsAtExit: yield* fs.exists(fixture) }), { flag: 'wx' });
    }));
    yield* fs.writeFileString(directory + '/ready.json', JSON.stringify({ fixture, pid: process.pid }), { flag: 'wx' });
    return yield* Effect.never;
  })).pipe(Effect.provide(NodeServices.layer));
  NodeRuntime.runMain(main, { disableErrorReporting: true, teardown: (_exit, done) => done(0) });
`;

const driverSource = (directory: string, footer: string) => `
  import { NodeCrypto, NodeRuntime, NodeServices } from '@effect/platform-node';
  import { Effect, Exit, FileSystem, Layer } from 'effect';
  import { Command } from 'effect/cli';
  import { ChildProcess, ChildProcessSpawner } from 'effect/process';
  import { withSalesDemoCustomerHandoff } from ${encodeJson(handoffUrl)};
  const command = Command.make('dummy-reset', {}, () =>
    withSalesDemoCustomerHandoff(({ fixture }) => Effect.gen(function* dummyOwnerSequence() {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      yield* spawner.exitCode(ChildProcess.make(process.execPath,
        ['--input-type=module', '-e', ${encodeJson(ownerSource(directory))}, fixture], {
          env: { TMPDIR: ${encodeJson(directory)}, NODE_DISABLE_COMPILE_CACHE: '1' },
          extendEnv: false, forceKillAfter: '5 seconds', stderr: 'inherit', stdout: 'inherit',
        }));
      yield* fs.writeFileString(${encodeJson(`${directory}/later-owner`)}, 'must not start', { flag: 'wx' });
    }))
  );
  ${footer}
`;

/** Test fallback only: the ready file identifies this test's independently detached dummy owner. */
const stopDummyOwner = Effect.fn('SalesDemoSignalTest.stopOwnedDummy')(function* stopDummyOwner(directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* fs.writeFileString(`${directory}/release-owner`, 'release');
  if (!(yield* fs.exists(`${directory}/ready.json`))) {
    return;
  }
  const ready = yield* fs
    .readFileString(`${directory}/ready.json`)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(readySchema))));
  // The platform owns normal group termination. This fallback prevents a deliberately broken
  // footer's detached test child escaping the regression's outer Scope.
  yield* spawner.exitCode(
    ChildProcess.make(
      process.execPath,
      [
        '-e',
        `
    try { process.kill(-${ready.pid}, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  `,
      ],
      { forceKillAfter: '1 second' },
    ),
  );
  yield* spawner
    .exitCode(
      ChildProcess.make(process.execPath, [
        '-e',
        `
    try { process.kill(${ready.pid}, 0); process.exitCode = 1; }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  `,
      ]),
    )
    .pipe(
      Effect.repeat({ schedule: Schedule.spaced('10 millis'), until: (code) => code === 0 }),
      Effect.timeout('3 seconds'),
    );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  it.live(`the actual reset footer ${signal} awaits its detached owner and then removes the real handoff`, () =>
    Effect.gen(function* signalOwnedResetScope() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'sales-demo-signal-unit-' });
      const footer = yield* resetFooter;
      const runner = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          ['--input-type=module', '-e', driverSource(directory, footer), 'dummy-reset'],
          {
            env: { NODE_DISABLE_COMPILE_CACHE: '1', TMPDIR: directory },
            extendEnv: false,
            forceKillAfter: '10 seconds',
            stderr: 'pipe',
            stdout: 'pipe',
          },
        ),
      );
      yield* Effect.addFinalizer(() => stopDummyOwner(directory).pipe(Effect.orDie));
      const stderr = yield* runner.stderr.pipe(Stream.decodeText, Stream.mkString, Effect.forkScoped);
      yield* waitForFile(`${directory}/ready.json`);
      const ready = yield* fs
        .readFileString(`${directory}/ready.json`)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(readySchema))));
      expect(ready.pid).not.toBe(runner.pid);
      const handoffDirectory = path.dirname(ready.fixture);
      expect(yield* fs.exists(ready.fixture)).toBe(true);
      const stopping = yield* runner.kill({ forceKillAfter: '10 seconds', killSignal: signal }).pipe(Effect.forkScoped);
      yield* waitForFile(`${directory}/signalled`);
      // The child's finalizer is held at a real barrier. Parent exit/cleanup must await it.
      expect(yield* runner.isRunning).toBe(true);
      expect(yield* fs.exists(ready.fixture)).toBe(true);
      expect(yield* fs.exists(`${directory}/later-owner`)).toBe(false);
      yield* fs.writeFileString(`${directory}/release-owner`, 'release');
      yield* Fiber.join(stopping).pipe(Effect.timeout('5 seconds'));
      expect(yield* runner.exitCode).toBe(1);
      expect(yield* runner.isRunning).toBe(false);
      expect(yield* fs.readFileString(`${directory}/stopped`)).toBe('{"fixtureExistsAtExit":true}');
      expect(yield* fs.exists(handoffDirectory)).toBe(false);
      expect(yield* fs.exists(`${directory}/later-owner`)).toBe(false);
      const gone = yield* spawner.exitCode(
        ChildProcess.make(process.execPath, [
          '-e',
          `
        try { process.kill(${ready.pid}, 0); process.exitCode = 1; }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      `,
        ]),
      );
      expect(gone).toBe(0);
      expect(yield* Fiber.join(stderr)).not.toContain('Error');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.live('the actual footer preserves zero/one exit codes and logs only the safe failure tag', () =>
  Effect.gen(function* ordinaryFooterResults() {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'sales-demo-exit-unit-' });
    const footer = yield* resetFooter;
    for (const fails of [false, true]) {
      const source = `
        import { NodeCrypto, NodeRuntime, NodeServices } from '@effect/platform-node';
        import { Console, Data, Effect, Exit, Layer } from 'effect';
        import { Command } from 'effect/cli';
        class DummyFailure extends Data.TaggedError('DummyFailure') {}
        const command = Command.make('dummy-reset', {}, () =>
          ${fails ? "Effect.fail(new DummyFailure({ message: 'private-diagnostic-control' }))" : 'Effect.void'}.pipe(
            Effect.tapError(failure => Console.error('Sales demo reset failed (' + failure._tag + ').'))
          )
        );
        ${footer}
      `;
      const runner = yield* spawner.spawn(
        ChildProcess.make(process.execPath, ['--input-type=module', '-e', source, 'dummy-reset'], {
          env: { NODE_DISABLE_COMPILE_CACHE: '1', TMPDIR: directory },
          extendEnv: false,
          forceKillAfter: '3 seconds',
        }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [
          runner.stdout.pipe(Stream.decodeText, Stream.mkString),
          runner.stderr.pipe(Stream.decodeText, Stream.mkString),
          runner.exitCode,
        ],
        { concurrency: 'unbounded' },
      ).pipe(Effect.timeout('5 seconds'));
      expect(code).toBe(fails ? 1 : 0);
      expect(stdout).toBe('');
      expect(stderr).toBe(fails ? 'Sales demo reset failed (DummyFailure).\n' : '');
      expect(stderr).not.toContain('private-diagnostic-control');
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
