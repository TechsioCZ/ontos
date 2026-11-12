import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { resolveUltramodernReleaseIdentity } from '@modern-js/app-tools-extensions/release-identity';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
  OntosShellRuntimeContractSchema,
} from '../../packages/core-runtime/src/index.ts';
import {
  generateOntosShellRuntimeContract,
  ShellRuntimeContractGenerationError,
} from '../generate-ontos-shell-runtime-contract.mts';

const shellAppId = 'shell-super-app';
const topology = {
  shell: {
    deliveryUnit: { buildMarker: 'shell-generation-marker', unitId: 'app/shell-super-app' },
    id: shellAppId,
    path: 'apps/shell-super-app',
  },
};
const Json = Schema.fromJsonString(Schema.Json);
const Contract = Schema.fromJsonString(OntosShellRuntimeContractSchema);
const generatorPath = fileURLToPath(new URL('../generate-ontos-shell-runtime-contract.mts', import.meta.url));
const git = (root: string, ...args: readonly string[]) =>
  Effect.try(() => execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf-8', stdio: 'pipe' }).trim());

const fixture = Effect.gen(function* makeFixture() {
  const root = yield* Effect.acquireRelease(
    Effect.tryPromise(() => mkdtemp(path.join(tmpdir(), 'ontos-shell-contract-'))),
    (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
  );
  const shellDirectory = path.join(root, topology.shell.path);
  yield* Effect.tryPromise(() => mkdir(shellDirectory, { recursive: true }));
  yield* Effect.tryPromise(() => mkdir(path.join(root, 'topology')));
  yield* Effect.tryPromise(() =>
    writeFile(path.join(root, 'topology/reference-topology.json'), Schema.encodeSync(Json)(topology)),
  );
  yield* Effect.tryPromise(() => writeFile(path.join(root, '.gitignore'), 'dist/\ndist-cloudflare/\n'));
  yield* Effect.tryPromise(() => writeFile(path.join(shellDirectory, 'source.ts'), 'export const release = 1;\n'));
  yield* git(root, 'init', '--quiet');
  yield* git(root, 'add', '.');
  yield* git(
    root,
    '-c',
    'user.name=Contract Test',
    '-c',
    'user.email=contract@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'First release',
  );
  return { root, shellDirectory };
});

const readContract = (file: string) =>
  Effect.tryPromise(() => readFile(file, 'utf-8')).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Contract)));

const localCompiledBuild = 'a'.repeat(64);
const writeCompiledIdentity = (
  shellDirectory: string,
  { appId = shellAppId, buildMarker = localCompiledBuild, sourceRevision = 'workspace' } = {},
) =>
  Effect.gen(function* writeIdentity() {
    const dist = path.join(shellDirectory, 'dist');
    yield* Effect.tryPromise(() => mkdir(dist, { recursive: true }));
    yield* Effect.tryPromise(() =>
      writeFile(
        path.join(dist, 'ultramodern-build.json'),
        Schema.encodeSync(Json)({
          deliveryUnit: {
            appId,
            build: buildMarker,
            buildMarker,
            sourceRevision,
            unitId: 'app/shell-super-app',
          },
        }),
      ),
    );
  });

it.live('publishes the emitted Node identity for a local compiled Shell', () =>
  Effect.gen(function* identifiesCompiledWorkspaceShell() {
    const { shellDirectory } = yield* fixture;
    yield* Effect.tryPromise(() => writeFile(path.join(shellDirectory, 'source.ts'), 'export const release = 2;\n'));
    yield* writeCompiledIdentity(shellDirectory);
    const file = yield* generateOntosShellRuntimeContract({ shellDirectory, target: 'dist' });
    expect((yield* readContract(file)).deployment).toEqual({
      appId: shellAppId,
      buildMarker: localCompiledBuild,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live('requires the matching compiled identity for a clean release', () =>
  Effect.gen(function* validatesCompiledReleaseIdentity() {
    const { root, shellDirectory } = yield* fixture;
    const sourceRevision = yield* git(root, 'rev-parse', 'HEAD');
    const { buildMarker } = resolveUltramodernReleaseIdentity({
      environment: { ULTRAMODERN_SOURCE_REVISION: sourceRevision },
      generationBuildMarker: topology.shell.deliveryUnit.buildMarker,
      unitId: topology.shell.deliveryUnit.unitId,
      workspaceRoot: root,
    });
    const generate = () =>
      spawnSync(process.execPath, [generatorPath, '--shell-directory', shellDirectory, '--target', 'dist'], {
        encoding: 'utf-8',
        env: { ULTRAMODERN_SOURCE_REVISION: sourceRevision },
      });
    const expectRejection = (message: string) => {
      const result = generate();
      expect(result.status).toBe(1);
      expect(result.stderr + result.stdout).toContain(message);
    };
    yield* writeCompiledIdentity(shellDirectory, { appId: 'another-shell' });
    expectRejection('invalid compiled Shell identity');
    const mismatch = 'the compiled Shell identity does not match the current release';
    yield* writeCompiledIdentity(shellDirectory);
    expectRejection(mismatch);
    yield* writeCompiledIdentity(shellDirectory, { sourceRevision });
    expectRejection(mismatch);
    yield* writeCompiledIdentity(shellDirectory, { buildMarker, sourceRevision });
    expect(generate().status).toBe(0);
    const contract = yield* readContract(
      path.join(shellDirectory, 'dist/public', ONTOS_SHELL_RUNTIME_CONTRACT_PATH.slice(1)),
    );
    expect(contract.deployment).toEqual({ appId: shellAppId, buildMarker });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live('stamps both deployment targets with the actual immutable Shell release identity', () =>
  Effect.gen(function* identifiesPromotedShell() {
    const { root, shellDirectory } = yield* fixture;
    const generate = (target: 'cloudflare-dist' | 'dist') =>
      Effect.gen(function* generateFixtureRelease() {
        const sourceRevision = yield* git(root, 'rev-parse', 'HEAD');
        yield* Effect.try(() =>
          execFileSync(process.execPath, [generatorPath, '--shell-directory', shellDirectory, '--target', target], {
            env: { ULTRAMODERN_SOURCE_REVISION: sourceRevision },
            stdio: 'pipe',
          }),
        );
        return path.join(
          shellDirectory,
          target === 'cloudflare-dist' ? 'dist-cloudflare' : target,
          'public',
          ONTOS_SHELL_RUNTIME_CONTRACT_PATH.slice(1),
        );
      });
    const first = yield* readContract(yield* generate('dist'));
    const cloudflare = yield* readContract(yield* generate('cloudflare-dist'));
    expect(first.schemaVersion).toBe('2');
    expect(first.deployment.appId).toBe(shellAppId);
    expect(first.deployment.buildMarker).not.toBe(topology.shell.deliveryUnit.buildMarker);
    expect(cloudflare.deployment).toEqual(first.deployment);
    expect(first.coreCapabilities).toEqual([{ id: 'ontos.module-dependency-contracts', version: '1' }]);
    expect(cloudflare.coreCapabilities).toEqual(first.coreCapabilities);

    yield* Effect.tryPromise(() => writeFile(path.join(shellDirectory, 'source.ts'), 'export const release = 2;\n'));
    yield* git(root, 'add', '.');
    yield* git(
      root,
      '-c',
      'user.name=Contract Test',
      '-c',
      'user.email=contract@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'Second release',
    );
    const second = yield* readContract(yield* generate('dist'));
    expect(second.deployment.buildMarker).not.toBe(first.deployment.buildMarker);
    expect(second.coreCapabilities).toEqual(first.coreCapabilities);
  }),
);

it.live('rejects an output directory that belongs to a different deployment', () =>
  Effect.gen(function* rejectsForeignShellDirectory() {
    const { root } = yield* fixture;
    const rejected = yield* generateOntosShellRuntimeContract({
      shellDirectory: path.join(root, 'apps/foreign-shell'),
      target: 'dist',
    }).pipe(Effect.provide(NodeServices.layer), Effect.flip);
    expect(Schema.is(ShellRuntimeContractGenerationError)(rejected)).toBe(true);
    expect(rejected.message).toBe('the Shell directory does not match topology');
  }),
);

it.live('rejects a topology that names another Shell identity', () =>
  Effect.gen(function* rejectsContradictoryIdentity() {
    const { root, shellDirectory } = yield* fixture;
    yield* Effect.tryPromise(() =>
      writeFile(
        path.join(root, 'topology/reference-topology.json'),
        Schema.encodeSync(Json)({ shell: { ...topology.shell, id: 'another-shell' } }),
      ),
    );
    const rejected = yield* generateOntosShellRuntimeContract({ shellDirectory, target: 'dist' }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.flip,
    );
    expect(Schema.is(ShellRuntimeContractGenerationError)(rejected)).toBe(true);
    expect(rejected.message).toBe('unable to read the Shell delivery identity');
  }),
);
