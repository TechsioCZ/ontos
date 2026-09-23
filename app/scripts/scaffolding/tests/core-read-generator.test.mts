import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, Exit } from 'effect';
import { expect, it } from 'effect-rstest';

import { runScaffoldEffect } from '../cli.mts';

const appRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const CORE_MODULE = 'core.identity';
const CORE_NAME = 'fixture-read';
const CORE_READ_PATH = 'packages/core-runtime/src/generated-reads/fixture-read.ts';
const SHELL_CONTRACT_PATH = 'apps/shell-super-app/shared/core-reads/fixture-read.ts';
const SHELL_SHARED_API_PATH = 'apps/shell-super-app/shared/api.ts';
const SHELL_SERVER_PATH = 'apps/shell-super-app/api/index.ts';
const SHELL_CLIENT_PATH = 'apps/shell-super-app/src/api/auth-client.ts';
const AUTHORIZATION_FLAG = '--authorization';
const roots = [
  'packages/core-runtime/src/index.ts',
  SHELL_SHARED_API_PATH,
  SHELL_SERVER_PATH,
  SHELL_CLIENT_PATH,
] as const;
const coreFlags = [
  '--core',
  '--module',
  CORE_MODULE,
  '--name',
  CORE_NAME,
  AUTHORIZATION_FLAG,
  'authenticated_principal',
];

const fixture = <A, E, R>(runFixture: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), 'ontos-core-read-'))),
    (root) =>
      Effect.gen(function* prepareFixture() {
        for (const relative of roots) {
          const target = path.join(root, relative);
          yield* Effect.promise(() => mkdir(path.dirname(target), { recursive: true }));
          yield* Effect.promise(() => copyFile(path.join(appRoot, relative), target));
        }
        return yield* runFixture(root);
      }),
    (root) => Effect.promise(() => rm(root, { force: true, recursive: true })),
  );

const run = (root: string, flags = coreFlags) =>
  runScaffoldEffect('module-api', flags, { workspaceRoot: root }).pipe(Effect.provide(NodeServices.layer));
const read = (root: string, relative: string) => Effect.promise(() => readFile(path.join(root, relative), 'utf-8'));

it.effect('Core READ mode creates a fail-closed Core read and typed Shell route/client idempotently', () =>
  fixture((root) =>
    Effect.gen(function* coreReadRoundTrip() {
      yield* run(root);
      const readSource = yield* read(root, CORE_READ_PATH);
      const contract = yield* read(root, SHELL_CONTRACT_PATH);
      const sharedApi = yield* read(root, SHELL_SHARED_API_PATH);
      const server = yield* read(root, SHELL_SERVER_PATH);
      const client = yield* read(root, SHELL_CLIENT_PATH);
      expect(readSource).toContain('defineRead(');
      expect(readSource).toContain('Core read requires owner implementation and target authorization');
      expect(contract).toContain('FixtureReadRequestSchema');
      expect(sharedApi).toContain("HttpApiGroup.make('coreReadFixtureRead')");
      expect(server).toContain('registration: fixtureReadRead');
      expect(server.match(/import \{[\s\S]*?\} from '@app\/core-runtime';/gu)).toHaveLength(1);
      expect(server).toContain('fixtureReadRead,');
      expect(client).toContain('client.coreReadFixtureRead.executeFixtureRead({ payload })');
      const before = yield* Effect.all(roots.map((relative) => read(root, relative)));
      yield* run(root);
      expect(yield* Effect.all(roots.map((relative) => read(root, relative)))).toEqual(before);
    }),
  ),
);

it.effect('Core READ mode rejects overwrite and traversal without partially changing roots', () =>
  fixture((root) =>
    Effect.gen(function* rejectInvalidCoreRead() {
      const target = path.join(root, CORE_READ_PATH);
      yield* Effect.promise(() => mkdir(path.dirname(target), { recursive: true }));
      yield* Effect.promise(() => writeFile(target, '// developer file\n'));
      const before = yield* Effect.all(roots.map((relative) => read(root, relative)));
      const rejected = yield* Effect.exit(run(root));
      expect(Exit.isFailure(rejected)).toBe(true);
      expect(yield* Effect.all(roots.map((relative) => read(root, relative)))).toEqual(before);
      const traversal = yield* Effect.exit(
        run(root, [
          '--core',
          '--module',
          CORE_MODULE,
          '--name',
          '../escape',
          AUTHORIZATION_FLAG,
          'authenticated_principal',
        ]),
      );
      expect(Exit.isFailure(traversal)).toBe(true);
      expect(yield* Effect.all(roots.map((relative) => read(root, relative)))).toEqual(before);
    }),
  ),
);

it.effect('Core READ mode rejects contract drift and incompatible CLI ownership without partial writes', () =>
  fixture((root) =>
    Effect.gen(function* rejectCoreReadDrift() {
      yield* run(root);
      const contractPath = path.join(root, SHELL_CONTRACT_PATH);
      yield* Effect.promise(() => writeFile(contractPath, '// developer contract\n'));
      const before = yield* Effect.all(roots.map((relative) => read(root, relative)));
      expect(Exit.isFailure(yield* Effect.exit(run(root)))).toBe(true);
      expect(Exit.isFailure(yield* Effect.exit(run(root, [...coreFlags, '--vertical', 'catalog'])))).toBe(true);
      expect(Exit.isFailure(yield* Effect.exit(run(root, [...coreFlags, '--core'])))).toBe(true);
      expect(yield* Effect.all(roots.map((relative) => read(root, relative)))).toEqual(before);
      expect(yield* Effect.promise(() => readFile(contractPath, 'utf-8'))).toBe('// developer contract\n');
    }),
  ),
);

it.effect('Core READ mode composes another read without disturbing the first', () =>
  fixture((root) =>
    Effect.gen(function* composeCoreReads() {
      yield* run(root);
      yield* run(root, [
        '--core',
        '--module',
        CORE_MODULE,
        '--name',
        'another-read',
        AUTHORIZATION_FLAG,
        'context_permission',
        '--permission',
        'module.access',
      ]);
      const sharedApi = yield* read(root, SHELL_SHARED_API_PATH);
      const server = yield* read(root, SHELL_SERVER_PATH);
      expect(sharedApi).toContain("HttpApiGroup.make('coreReadFixtureRead')");
      expect(sharedApi).toContain("HttpApiGroup.make('coreReadAnotherRead')");
      expect(server).toContain('coreReadFixtureReadGroupLive,');
      expect(server).toContain('coreReadAnotherReadGroupLive,');
      yield* run(root);
    }),
  ),
);

it.effect('Core READ mode rejects a missing Shell registration slot before any write', () =>
  fixture((root) =>
    Effect.gen(function* rejectMissingSlot() {
      const serverPath = path.join(root, SHELL_SERVER_PATH);
      const server = yield* read(root, SHELL_SERVER_PATH);
      yield* Effect.promise(() =>
        writeFile(serverPath, server.replace('// @ontos-codesmith-core-read-server-layers:start', '// slot removed')),
      );
      const before = yield* Effect.all(roots.map((relative) => read(root, relative)));
      expect(Exit.isFailure(yield* Effect.exit(run(root)))).toBe(true);
      expect(yield* Effect.all(roots.map((relative) => read(root, relative)))).toEqual(before);
    }),
  ),
);
