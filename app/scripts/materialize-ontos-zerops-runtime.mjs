#!/usr/bin/env node
/// <reference types="node" />

import { NodeServices } from '@effect/platform-node';
import { Config, Effect, FileSystem, Layer, Option, Path, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

class OutboxRuntimeError extends Schema.TaggedError()('OutboxRuntimeError', { message: Schema.String }) {}

/** @param {string} message Error detail. */
const failure = (message) => new OutboxRuntimeError({ message });

const RuntimePackageJsonSchema = Schema.fromJsonString(Schema.Unknown, { space: 2 });
const PackageManifestSchema = Schema.fromJsonString(Schema.Struct({ name: Schema.String }));

const materializeCommand = Command.make(
  'materialize-ontos-zerops-runtime',
  {
    appId: Flag.String('app'),
    packageDir: Flag.String('package-dir'),
    packageName: Flag.String('package'),
    worker: Flag.Boolean('worker').pipe(Flag.withDefault(false)),
  },
  ({ appId, packageDir, packageName, worker }) =>
    Effect.gen(function* materializeRuntime() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const workspaceRoot = path.resolve(
        yield* Config.String('ULTRAMODERN_WORKSPACE_ROOT').pipe(Config.withDefault(process.cwd())),
      );
      const frameworkArgs = [
        'exec',
        'ultramodern-create',
        'ultramodern',
        'zerops-materialize',
        '--app',
        appId,
        '--package',
        packageName,
        '--package-dir',
        packageDir,
      ];

      if (worker) {
        const { materializeOutboxWorker, resolveOutboxWorker } = yield* Effect.tryPromise({
          catch: (cause) => failure(String(cause)),
          try: async () => await import('./materialize-outbox-worker.mjs'),
        });
        if (path.isAbsolute(packageDir) || packageDir.split(/[\\/]/u).includes('..')) {
          return yield* Effect.fail(failure('--package-dir must be a workspace-relative path'));
        }
        const packageRoot = path.resolve(workspaceRoot, packageDir);
        const packageRelative = path.relative(yield* fs.realPath(workspaceRoot), yield* fs.realPath(packageRoot));
        if (packageRelative.startsWith('..') || path.isAbsolute(packageRelative)) {
          return yield* Effect.fail(failure('package directory resolved outside the workspace'));
        }
        const manifest = yield* fs
          .readFileString(path.join(packageRoot, 'package.json'))
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PackageManifestSchema)));
        if (manifest.name !== packageName) {
          return yield* Effect.fail(failure('--package must match --package-dir/package.json name'));
        }
        const options = { appId, packageDir, packageName, workspaceRoot };
        // scripts/ci/build-outbox-host.sh passes the plan's host digest, which the bundle serves on /status, and the
        // revision each hosted owner's build identity names (JSON, by owner id).
        const artifactDigest = yield* Config.option(Config.String('ONTOS_OUTBOX_HOST_DIGEST'));
        const ownerRevisions = yield* Config.option(Config.String('ONTOS_OUTBOX_HOST_OWNER_REVISIONS'));
        const delivery = yield* Effect.tryPromise({
          catch: (cause) => failure(String(cause)),
          try: async () => await resolveOutboxWorker(options),
        });
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(delivery.serviceId)) {
          return yield* Effect.fail(failure('Outbox Worker service must be a service identifier'));
        }
        const relativeRuntime = `.zerops/runtime/${delivery.serviceId}`;
        const runtimeDir = path.join(workspaceRoot, relativeRuntime);
        // Check existing ancestors before replacing this service's prepared runtime.
        let ancestor = runtimeDir;
        while (!(yield* fs.exists(ancestor))) {
          ancestor = path.dirname(ancestor);
        }
        const runtimeRelative = path.relative(yield* fs.realPath(workspaceRoot), yield* fs.realPath(ancestor));
        if (runtimeRelative.startsWith('..') || path.isAbsolute(runtimeRelative)) {
          return yield* Effect.fail(failure('runtime directory resolved outside the workspace'));
        }
        yield* fs.remove(runtimeDir, { force: true, recursive: true });
        yield* fs.makeDirectory(runtimeDir, { recursive: true });
        const runtimePackage = yield* Effect.tryPromise({
          catch: (cause) => failure(String(cause)),
          try: async () =>
            await materializeOutboxWorker({
              ...options,
              artifactDigest: Option.getOrUndefined(artifactDigest),
              ownerRevisions: Option.getOrUndefined(ownerRevisions),
              runtimeDir,
            }),
        });
        const runtimePackageJson = yield* Schema.encodeEffect(RuntimePackageJsonSchema)(runtimePackage);
        yield* fs.writeFileString(path.join(runtimeDir, 'package.json'), `${runtimePackageJson}\n`);
        frameworkArgs.push('--finalize-only', '--runtime-dir', relativeRuntime);
      }

      // The published tooling owns cohort normalization, platform filtering, lockfile pins and installation.
      return yield* spawner
        .exitCode(
          ChildProcess.make('pnpm', frameworkArgs, {
            cwd: workspaceRoot,
            stderr: 'inherit',
            stdin: 'inherit',
            stdout: 'inherit',
          }),
        )
        .pipe(
          Effect.filterOrFail(
            (code) => code === ChildProcessSpawner.ExitCode(0),
            (code) => failure(`Published Zerops materialization failed with exit code ${code}`),
          ),
          Effect.asVoid,
        );
    }),
);

const program = Command.run(materializeCommand, { version: '1.0.0' });
const executableLayer = Layer.effectDiscard(program).pipe(Layer.provide(NodeServices.layer));
await Effect.runPromise(Effect.scoped(Layer.build(executableLayer)));
