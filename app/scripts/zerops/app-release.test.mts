import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';

import { collectToolingProcess } from '../tests/tooling-process-fixture.mts';

const RUNTIME_PATHS = path.join(import.meta.dirname, 'app-runtime-paths.txt');
const PACK = 'pack-app-release.sh';
const UNPACK = 'unpack-app-release.sh';
const HOST = 'app/scripts/zerops/app-host.mts';
const RELEASE = '.zerops-release';
const ARCHIVE = `${RELEASE}/app.tar.zst`;
const STAMP = 'app/.zerops-release-digest';
const LINK = 'app/node_modules/effect';

const runtimePaths = Effect.gen(function* readRuntimePaths() {
  const fs = yield* FileSystem.FileSystem;
  return (yield* fs.readFileString(RUNTIME_PATHS)).split('\n').filter((line) => line !== '' && !line.startsWith('#'));
});

const run = (cwd: string, script: string) =>
  collectToolingProcess(ChildProcess.make('sh', [script], { cwd, extendEnv: true }));

/** A build tree with every runtime path, a relative symlink like pnpm's, and the two release scripts. */
const buildTree = (root: string) =>
  Effect.gen(function* makeBuildTree() {
    const fs = yield* FileSystem.FileSystem;
    for (const entry of yield* runtimePaths) {
      const target = path.join(root, entry);
      if (path.extname(entry) === '') {
        yield* fs.makeDirectory(target, { recursive: true });
        yield* fs.writeFileString(path.join(target, '.present'), entry);
      } else {
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.writeFileString(target, entry);
      }
    }
    yield* fs.makeDirectory(path.join(root, 'app/node_modules/.pnpm/effect@4.0.7/node_modules/effect'), {
      recursive: true,
    });
    yield* fs.symlink('.pnpm/effect@4.0.7/node_modules/effect', path.join(root, LINK));
    yield* fs.makeDirectory(path.join(root, 'app/scripts/zerops'), { recursive: true });
    yield* fs.writeFileString(path.join(root, HOST), 'export {};\n');
    yield* fs.writeFileString(
      path.join(root, 'app/scripts/zerops/app-runtime-paths.txt'),
      yield* fs.readFileString(RUNTIME_PATHS),
    );
    for (const script of [PACK, UNPACK]) {
      yield* fs.writeFileString(
        path.join(root, 'app/scripts/zerops', script),
        yield* fs.readFileString(path.join(import.meta.dirname, script)),
      );
    }
  });

/** Packs a build tree and copies the release to a fresh runtime directory, as Zerops deploys `.zerops-release`. */
const packedRuntime = Effect.gen(function* packedRuntime() {
  const fs = yield* FileSystem.FileSystem;
  const build = yield* fs.makeTempDirectoryScoped({ prefix: 'app-release-build-' });
  yield* buildTree(build);
  const packed = yield* run(build, `app/scripts/zerops/${PACK}`);
  expect(packed.status, packed.stderr).toBe(0);
  expect(packed.stdout).toContain(`packed the app runtime tree into ${ARCHIVE}`);
  const www = yield* fs.makeTempDirectoryScoped({ prefix: 'app-release-www-' });
  yield* fs.makeDirectory(path.join(www, RELEASE));
  for (const file of yield* fs.readDirectory(path.join(build, RELEASE))) {
    yield* fs.copyFile(path.join(build, RELEASE, file), path.join(www, RELEASE, file));
  }
  return www;
});

it.live('packs every runtime path and unpacks it whole into app/, then keeps it across a restart', () =>
  Effect.gen(function* unpackOnce() {
    const fs = yield* FileSystem.FileSystem;
    const www = yield* packedRuntime;
    expect((yield* fs.readDirectory(path.join(www, RELEASE))).toSorted()).toEqual([
      'app.tar.zst',
      'app.tar.zst.sha256',
      'unpack.sh',
    ]);
    const digest = (yield* fs.readFileString(path.join(www, `${ARCHIVE}.sha256`))).trim();
    const first = yield* run(www, `${RELEASE}/unpack.sh`);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain(`unpacked app release ${digest} in`);
    for (const entry of yield* runtimePaths) {
      expect(yield* fs.exists(path.join(www, entry)), entry).toBe(true);
    }
    expect(yield* fs.readLink(path.join(www, LINK))).toBe('.pnpm/effect@4.0.7/node_modules/effect');
    expect((yield* fs.readFileString(path.join(www, STAMP))).trim()).toBe(digest);
    // The archive is not held twice on disk; the scratch directory is gone.
    expect(yield* fs.exists(path.join(www, ARCHIVE))).toBe(false);
    expect(yield* fs.exists(path.join(www, '.zerops-release-unpack'))).toBe(false);
    // A restart of the same container keeps the complete tree and unpacks nothing.
    const restart = yield* run(www, `${RELEASE}/unpack.sh`);
    expect(restart.status, restart.stderr).toBe(0);
    expect(restart.stdout).toContain(`app release ${digest} is already unpacked`);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live('replaces a half-written tree from an interrupted start instead of running it', () =>
  Effect.gen(function* interrupted() {
    const fs = yield* FileSystem.FileSystem;
    const www = yield* packedRuntime;
    // An earlier start died mid-unpack: a scratch tree, and an app/ without this release's stamp.
    yield* fs.makeDirectory(path.join(www, '.zerops-release-unpack/app'), { recursive: true });
    yield* fs.makeDirectory(path.join(www, 'app/scripts'), { recursive: true });
    yield* fs.writeFileString(path.join(www, 'app/partial'), 'partial');
    const result = yield* run(www, `${RELEASE}/unpack.sh`);
    expect(result.status, result.stderr).toBe(0);
    expect(yield* fs.exists(path.join(www, 'app/partial'))).toBe(false);
    expect(yield* fs.exists(path.join(www, HOST))).toBe(true);
    expect(yield* fs.exists(path.join(www, 'app.previous'))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live('refuses an archive whose digest differs, and a start with neither an archive nor a complete tree', () =>
  Effect.gen(function* refusals() {
    const fs = yield* FileSystem.FileSystem;
    const www = yield* packedRuntime;
    yield* fs.writeFileString(path.join(www, `${ARCHIVE}.sha256`), `${'0'.repeat(64)}\n`);
    const corrupt = yield* run(www, `${RELEASE}/unpack.sh`);
    expect(corrupt.status).toBe(1);
    expect(corrupt.stderr).toContain('refusing to unpack');
    expect(yield* fs.exists(path.join(www, 'app'))).toBe(false);
    yield* fs.remove(path.join(www, ARCHIVE));
    const missing = yield* run(www, `${RELEASE}/unpack.sh`);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('no archive and no complete tree to start from');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live('fails the build when a runtime path is missing, before it writes any archive', () =>
  Effect.gen(function* missingPath() {
    const fs = yield* FileSystem.FileSystem;
    const build = yield* fs.makeTempDirectoryScoped({ prefix: 'app-release-build-' });
    yield* buildTree(build);
    yield* fs.remove(path.join(build, 'app/.zerops/state'), { recursive: true });
    const packed = yield* run(build, `app/scripts/zerops/${PACK}`);
    expect(packed.status).toBe(1);
    expect(packed.stderr).toContain('app runtime path app/.zerops/state is missing from the build');
    expect(yield* fs.exists(path.join(build, RELEASE))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
