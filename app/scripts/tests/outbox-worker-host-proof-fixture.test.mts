import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { expect, it } from 'effect-rstest';

import {
  assertHostProofAuthorityEmpty,
  OutboxWorkerHostProofFixtureError,
  requireHostProofDatabase,
} from '../outbox-worker-host-proof-fixture.mts';

const workspaceRoot = path.resolve(import.meta.dirname, '../..');
const nativeControlPath = fileURLToPath(new URL('outbox-worker-host-proof-native.fixture.mts', import.meta.url));

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
    expect({ code, stderr, stdout }).toEqual({
      code: 0,
      stderr: '',
      stdout: 'complete native host admission controls passed\n',
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
