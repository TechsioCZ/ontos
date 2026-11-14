#!/usr/bin/env node
/**
 * USAGE (all commands run from app/, APP_ENV_PATH=/dev/null):
 * Producer: checkout/install and download/unpack same-run node-units-* as today.
 *   mise exec -- node scripts/ci/integration-seed.mts produce --directory "$RUNNER_TEMP/integration-seed" --disposable
 *   mise exec -- node scripts/ci/worker-host-artifact.mts build --directory "$RUNNER_TEMP/worker-host" \
 *     --from-proof "$RUNNER_TEMP/integration-seed-proof/outbox-worker-host-artifact"
 * Upload actions/upload-artifact name=integration-worker-host-${{ github.run_id }}
 * path=${{ runner.temp }}/worker-host (only runtime.tar and manifest.json; never proof logs).
 * Standalone build, without an existing proof: omit --from-proof; materializes exactly as the proof does.
 * Consumer: download that exact same-run artifact to $RUNNER_TEMP/worker-host, then:
 *   mise exec -- node scripts/ci/worker-host-artifact.mts use --directory "$RUNNER_TEMP/worker-host"
 * Replaces "Materialize the native combined Outbox Worker host artifact" (root-suite) and the BUILD
 * part of "Build and run the Outbox Worker host artifact against the fresh database" in test jobs.
 * The full existing build-and-run proof stays in the producer; it is NOT replaced with build alone.
 * use installs app/.zerops/runtime/outbox-worker-host, including its private runtime dependencies.
 * Never upload an unpacked node_modules tree: tar preserves dotfiles, modes and relative symlinks.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Layer, Option, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import { MANIFEST_FILE, WORKER_RUNTIME, seedFailure } from './integration-seed-model.mts';
import {
  APP_DIRECTORY,
  emptyOutputDirectory,
  requiredEnvironment,
  readSourceRevision,
  runSeedCommand,
} from './integration-seed-process.mts';

const PNPM = 'pnpm';
const ARCHIVE = 'runtime.tar';
const ENTRY = 'worker.mjs';
const HOST_METADATA = 'worker-artifact.json';
export class WorkerArtifactManifest extends Schema.Class<WorkerArtifactManifest>('WorkerArtifactManifest')({
  version: Schema.Literal(1),
  sourceRevision: Schema.String,
  workflowRun: Schema.String,
  digest: Schema.String,
}) {}
export const workerArtifactJson = Schema.fromJsonString(WorkerArtifactManifest, { space: 2 });
const metadataJson = Schema.fromJsonString(Schema.Struct({ sourceRevision: Schema.String }));

export const assertWorkerArtifact = (
  manifest: WorkerArtifactManifest,
  expected: {
    readonly workflowRun: string;
    readonly sourceRevision: string;
    readonly digest: string;
  },
) =>
  manifest.workflowRun === expected.workflowRun &&
  manifest.sourceRevision === expected.sourceRevision &&
  manifest.digest === expected.digest
    ? Effect.void
    : Effect.fail(
        seedFailure('Worker host artifact provenance/digest mismatch; only the same run and revision are allowed'),
      );

const readDigest = (directory: string) =>
  Effect.gen(function* hashRuntimeArchive() {
    const fs = yield* FileSystem.FileSystem;
    return yield* Effect.succeed(
      createHash('sha256')
        .update(yield* fs.readFile(path.join(directory, ARCHIVE)))
        .digest('hex'),
    );
  });
const requireRuntime = (directory: string) =>
  Effect.gen(function* checkRuntimeEntry() {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(path.join(directory, ENTRY))) || !(yield* fs.exists(path.join(directory, HOST_METADATA)))) {
      return yield* seedFailure('Outbox Worker host runtime is missing its entry or owner provenance');
    }
    const metadata = yield* Schema.decodeEffect(metadataJson)(
      yield* fs.readFileString(path.join(directory, HOST_METADATA)),
    );
    const revision = yield* readSourceRevision();
    if (metadata.sourceRevision !== revision) {
      return yield* seedFailure('Outbox Worker host metadata does not match this checkout revision');
    }
    return yield* Effect.succeed(revision);
  });

const buildArtifact = (directory: string, proof: Option.Option<string>) =>
  Effect.gen(function* buildWorkerArtifact() {
    const fs = yield* FileSystem.FileSystem;
    yield* emptyOutputDirectory(directory);
    let runtime = path.join(APP_DIRECTORY, WORKER_RUNTIME);
    if (Option.isSome(proof)) {
      const proofDirectory = path.resolve(proof.value);
      const log = yield* fs.readFileString(path.join(proofDirectory, 'outbox-worker-host.log'));
      const fixtureLog = yield* fs.readFileString(path.join(proofDirectory, 'outbox-worker-host-proof-fixture.log'));
      if (
        !(yield* fs.exists(path.join(proofDirectory, 'outbox-worker-host-proof-stopped'))) ||
        !log.includes('Outbox Worker host received SIGTERM; shutting down') ||
        fixtureLog.length === 0
      ) {
        return yield* seedFailure('--from-proof requires the completed, gracefully stopped worker proof');
      }
      runtime = path.join(proofDirectory, 'app', WORKER_RUNTIME);
    } else {
      const revision = yield* readSourceRevision();
      yield* runSeedCommand(
        PNPM,
        [
          'run',
          'zerops:materialize',
          '--app',
          'outbox-worker-host',
          '--package',
          'app',
          '--package-dir',
          '.',
          '--worker',
        ],
        { env: { ULTRAMODERN_SOURCE_REVISION: revision } },
      );
    }
    const revision = yield* requireRuntime(runtime);
    yield* runSeedCommand('tar', ['-cf', path.join(directory, ARCHIVE), '-C', runtime, '.']);
    const manifest = yield* Schema.encodeEffect(workerArtifactJson)(
      new WorkerArtifactManifest({
        version: 1,
        sourceRevision: revision,
        workflowRun: yield* requiredEnvironment('GITHUB_RUN_ID'),
        digest: yield* readDigest(directory),
      }),
    );
    return yield* fs.writeFileString(path.join(directory, MANIFEST_FILE), manifest);
  });

const useArtifact = (directory: string) =>
  Effect.scoped(
    Effect.gen(function* useWorkerArtifact() {
      const fs = yield* FileSystem.FileSystem;
      const manifest = yield* Schema.decodeEffect(workerArtifactJson)(
        yield* fs.readFileString(path.join(directory, MANIFEST_FILE)),
      );
      const revision = yield* readSourceRevision();
      yield* assertWorkerArtifact(manifest, {
        workflowRun: yield* requiredEnvironment('GITHUB_RUN_ID'),
        sourceRevision: revision,
        digest: yield* readDigest(directory),
      });
      const destination = path.join(APP_DIRECTORY, WORKER_RUNTIME);
      if (yield* fs.exists(destination)) {
        return yield* seedFailure(
          'Worker runtime already exists; replace the earlier materialize step with artifact use',
        );
      }
      const staging = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-worker-artifact-' });
      yield* runSeedCommand('tar', ['-xf', path.join(directory, ARCHIVE), '-C', staging]);
      yield* requireRuntime(staging);
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
      return yield* fs.copy(staging, destination);
    }),
  );

const directoryFlag = Flag.String('directory');
const build = Command.make(
  'build',
  {
    directory: directoryFlag,
    fromProof: Flag.String('from-proof').pipe(Flag.optional),
  },
  ({ directory, fromProof }) => buildArtifact(path.resolve(directory), fromProof),
);
const use = Command.make('use', { directory: directoryFlag }, ({ directory }) => useArtifact(path.resolve(directory)));
const cli = Command.make('worker-host-artifact').pipe(Command.withSubcommands([build, use]));
if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(
      Layer.effectDiscard(Command.run(cli, { version: '1.0.0' })).pipe(Layer.provide(NodeServices.layer)),
    ).pipe(Effect.scoped),
  );
}
