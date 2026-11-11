import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Console as EffectConsole, Deferred, Effect, Fiber, FileSystem, Ref, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { expect, it } from 'effect-rstest';

import {
  assertHostProofAuthorityEmpty,
  OutboxWorkerHostProofFixtureError,
  requireHostProofDatabase,
} from '../outbox-worker-host-proof-fixture.mts';

const workspaceRoot = path.resolve(import.meta.dirname, '../..');
const nativeControlPath = fileURLToPath(new URL('outbox-worker-host-proof-native.fixture.mts', import.meta.url));

// The generator's supported default package profile can emit this pinned Node26 advisory while
// native TypeScript module detection imports real owner registrations. Every byte stays visible.
const nodeModuleTypeWarnings = new RegExp(
  String.raw`^(?:\(node:\d+\) \[MODULE_TYPELESS_PACKAGE_JSON\] Warning: Module type of file:\/\/[^\r\n]+\.ts is not specified and it doesn't parse as CommonJS\.\n` +
    String.raw`Reparsing as ES module because module syntax was detected\. This incurs a performance overhead\.\n` +
    String.raw`To eliminate this warning, add "type": "module" to [^\r\n]+\/package\.json\.\n` +
    String.raw`(?:\(Use \x60node --trace-warnings \.\.\.\x60 to show where the warning was created\)\n)?)+(?![\s\S])`,
  'u',
);
const hasOnlyNativeModuleTypeWarnings = (stderr: string): boolean =>
  stderr === '' || nodeModuleTypeWarnings.test(stderr);

it('accepts only complete native module-type advisories and rejects unexpected stderr', () => {
  const warning =
    "(node:123) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///tmp/ontos/verticals/catalog/shared/value.ts is not specified and it doesn't parse as CommonJS.\n" +
    'Reparsing as ES module because module syntax was detected. This incurs a performance overhead.\n' +
    'To eliminate this warning, add "type": "module" to /tmp/ontos/verticals/catalog/package.json.\n';
  const hint = '(Use `node --trace-warnings ...` to show where the warning was created)\n';
  expect(hasOnlyNativeModuleTypeWarnings('')).toBe(true);
  expect(hasOnlyNativeModuleTypeWarnings(warning)).toBe(true);
  expect(hasOnlyNativeModuleTypeWarnings(`${warning}${hint}${warning}`)).toBe(true);
  for (const unexpected of [
    'Error: native admission failed\n',
    `${warning}Error: native admission failed\n`,
    `unexpected runtime diagnostic\n${warning}`,
    `${warning}TS2322: invalid runtime contract\n`,
    `${warning}\n`,
    warning.split('\n')[0],
  ]) {
    expect(hasOnlyNativeModuleTypeWarnings(unexpected)).toBe(false);
  }
});

const runSignalControl = (control: 'signal' | 'signal-finalizer-failure') =>
  Effect.gen(function* realNativeSignal() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [nativeControlPath, '--control', control], {
        cwd: workspaceRoot,
      }),
    );
    const ready = yield* Deferred.make<boolean>();
    const observed = yield* Ref.make('');
    const stdoutFiber = yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.tap((chunk) =>
        Ref.updateAndGet(observed, (current) => current + chunk).pipe(
          Effect.flatMap((current) =>
            current.includes('signal-control-ready\n') ? Deferred.succeed(ready, true) : Effect.void,
          ),
        ),
      ),
      Stream.mkString,
      Effect.forkChild,
    );
    const stderrFiber = yield* child.stderr.pipe(Stream.decodeText(), Stream.mkString, Effect.forkChild);
    yield* Deferred.await(ready).pipe(Effect.timeout('10 seconds'));
    yield* child.kill({ forceKillAfter: '5 seconds', killSignal: 'SIGTERM' });
    const [stdout, stderr, code] = yield* Effect.all(
      [Fiber.join(stdoutFiber), Fiber.join(stderrFiber), child.exitCode],
      {
        concurrency: 'unbounded',
      },
    );
    return { code, stderr, stdout };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.live('real SIGTERM completes scoped finalization before exiting successfully', () =>
  Effect.gen(function* cleanSignalShutdown() {
    const result = yield* runSignalControl('signal');
    expect(result).toEqual({ code: 0, stderr: '', stdout: 'signal-control-ready\nsignal-control-finalized\n' });
  }),
);

it.live('real SIGTERM retains a scoped finalizer failure as a failed process exit', () =>
  Effect.gen(function* failedSignalFinalizer() {
    const result = yield* runSignalControl('signal-finalizer-failure');
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('signal-control-finalized\n');
    expect(`${result.stdout}${result.stderr}`).toContain('intentional scoped finalizer failure');
  }),
);

it.live('rejects invalid shell proof timeouts before allocating an artifact or starting materialization', () =>
  Effect.gen(function* invalidShellTimeoutControls() {
    const fileSystem = yield* FileSystem.FileSystem;
    const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({ prefix: 'ontos-host-proof-timeout-' });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    for (const timeout of ['invalid', '0']) {
      const artifactPath = path.join(temporaryDirectory, `absent-${timeout}`);
      const child = yield* spawner.spawn(
        ChildProcess.make('sh', ['scripts/prove-outbox-worker-host-artifact.sh', artifactPath], {
          cwd: workspaceRoot,
          env: { OUTBOX_WORKER_HOST_READY_TIMEOUT_SECONDS: timeout },
        }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [
          child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          child.stderr.pipe(Stream.decodeText(), Stream.mkString),
          child.exitCode,
        ],
        { concurrency: 'unbounded' },
      );
      expect(code).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toContain('OUTBOX_WORKER_HOST_READY_TIMEOUT_SECONDS must be a positive integer');
      expect(yield* fileSystem.exists(artifactPath)).toBe(false);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('requires distinct roles in one explicit local database without connection routing overrides', () =>
  Effect.gen(function* localDatabaseControls() {
    const environment = {
      DATABASE_ADMIN_URL: 'postgresql://proof_admin:admin_secret@127.0.0.1:5433/host_proof',
      DATABASE_URL: 'postgresql://proof_runtime:runtime_secret@127.0.0.1:5433/host_proof',
    };
    yield* requireHostProofDatabase(environment);
    for (const DATABASE_ADMIN_URL of [
      environment.DATABASE_URL,
      'postgresql://proof_admin:admin_secret@remote.example:5433/host_proof',
      'postgresql://proof_admin:admin_secret@127.0.0.1:5434/host_proof',
      'postgresql://proof_admin:admin_secret@127.0.0.1:5433/another_database',
      `${environment.DATABASE_ADMIN_URL}?host=remote.example`,
      `${environment.DATABASE_ADMIN_URL}?user=proof_runtime`,
    ]) {
      const rejected = yield* Effect.flip(requireHostProofDatabase({ ...environment, DATABASE_ADMIN_URL }));
      expect(Schema.is(OutboxWorkerHostProofFixtureError)(rejected)).toBe(true);
      expect(rejected.reason).not.toContain('admin_secret');
      expect(rejected.reason).not.toContain('runtime_secret');
    }
    yield* assertHostProofAuthorityEmpty([]);
    expect((yield* Effect.flip(assertHostProofAuthorityEmpty([{ revision: 'a'.repeat(64) }]))).reason).toContain(
      'fresh empty authority',
    );
  }),
);

// The native owner producer imports runtime registrations dynamically. Run it in Node, where Core's
// private registration class has one identity, rather than crossing the Rstest bundle boundary.

it.live('preserves the real complete catalog and serves exact native snapshot bytes after admission', () =>
  Effect.gen(function* nativeProcessControl() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [nativeControlPath], { cwd: workspaceRoot }),
    );
    const [stdout, stderr, code] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: 'unbounded' },
    );
    if (stderr !== '') {
      yield* EffectConsole.error(stderr);
    }
    expect({ code, stdout }).toEqual({
      code: 0,
      stdout: 'complete native host admission controls passed\n',
    });
    expect(hasOnlyNativeModuleTypeWarnings(stderr)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
