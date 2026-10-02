import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { OntosShellRuntimeContractSchema } from '../../packages/core-runtime/src/index.ts';
import {
  generateOntosShellRuntimeContract,
  ShellRuntimeContractGenerationError,
} from '../generate-ontos-shell-runtime-contract.mts';

const topology = {
  shell: {
    deliveryUnit: { buildMarker: 'shell-generation-marker', unitId: 'app/shell-super-app' },
    id: 'shell-super-app',
    path: 'apps/shell-super-app',
  },
};
const Json = Schema.fromJsonString(Schema.Json);
const Contract = Schema.fromJsonString(OntosShellRuntimeContractSchema);
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

it.live('stamps both deployment targets with the actual immutable Shell release identity', () =>
  Effect.gen(function* identifiesPromotedShell() {
    const { root, shellDirectory } = yield* fixture;
    const generate = (target: 'cloudflare-dist' | 'dist') =>
      generateOntosShellRuntimeContract({ shellDirectory, target }).pipe(Effect.provide(NodeServices.layer));
    const readContract = (file: string) =>
      Effect.tryPromise(() => readFile(file, 'utf-8')).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Contract)));
    const first = yield* readContract(yield* generate('dist'));
    const cloudflare = yield* readContract(yield* generate('cloudflare-dist'));
    expect(first.schemaVersion).toBe('2');
    expect(first.deployment.appId).toBe('shell-super-app');
    expect(first.deployment.buildMarker).not.toBe(topology.shell.deliveryUnit.buildMarker);
    expect(cloudflare.deployment).toEqual(first.deployment);

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
