import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Config, Effect, FileSystem } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';

import { collectToolingProcess } from '../tests/tooling-process-fixture.mts';

const RUNTIME_PATHS = path.join(import.meta.dirname, 'app-runtime-paths.txt');
const EXCLUDED_PACKAGES = path.join(import.meta.dirname, 'app-runtime-excluded-packages.txt');
const LEFT_OUT = [
  '@effect+tsgo@0.69.0',
  '@effect+tsgo-linux-x64@0.69.0',
  'oxlint@1.88.0_oxlint-tsgolint@7.0.2005',
  'workerd@1.20261012.1',
  '@bleedingdev+modern-js-ultramodern-create@3.11.3-ultramodern.1_patch_hash=abc',
];
const STORE = 'app/node_modules/.pnpm';
const KEPT = ['@effect+platform-node@4.0.7', 'oxc-resolver@11.1.0', 'typescript@5.9.3', 'drizzle-kit@1.0.0'];
const PACK = 'pack-app-release.sh';
const UNPACK = 'unpack-app-release.sh';
const HOST = 'app/scripts/zerops/app-host.mts';
const RELEASE = '.zerops-release';
const ARCHIVE = `${RELEASE}/app.tar.zst`;
const STAMP = 'app/.zerops-release-digest';
const LINK = 'app/node_modules/effect';
const BUILD_PREFIX = 'app-release-build-';
const OLD_RELEASE = 'app/old-release';

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
    yield* fs.writeFileString(
      path.join(root, 'app/scripts/zerops/app-runtime-excluded-packages.txt'),
      yield* fs.readFileString(EXCLUDED_PACKAGES),
    );
    // Store directories the pack leaves out, and look-alikes it keeps.
    for (const store of [...LEFT_OUT, ...KEPT]) {
      yield* fs.makeDirectory(path.join(root, STORE, store, 'node_modules'), { recursive: true });
      yield* fs.writeFileString(path.join(root, STORE, store, 'package.json'), '{}');
    }
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
  const build = yield* fs.makeTempDirectoryScoped({ prefix: BUILD_PREFIX });
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
    // The build, lint and test tools stay out; everything else of the store ships.
    for (const store of LEFT_OUT) {
      expect(yield* fs.exists(path.join(www, STORE, store)), store).toBe(false);
    }
    for (const store of KEPT) {
      expect(yield* fs.exists(path.join(www, STORE, store, 'package.json')), store).toBe(true);
    }
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
    const build = yield* fs.makeTempDirectoryScoped({ prefix: BUILD_PREFIX });
    yield* buildTree(build);
    yield* fs.remove(path.join(build, 'app/.zerops/state'), { recursive: true });
    const packed = yield* run(build, `app/scripts/zerops/${PACK}`);
    expect(packed.status).toBe(1);
    expect(packed.stderr).toContain('app runtime path app/.zerops/state is missing from the build');
    expect(yield* fs.exists(path.join(build, RELEASE))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

/** A directory with one stub command, put first on PATH; `REAL_<TOOL>` names the real one for stubs that wrap it. */
const withStub = (root: string, tool: string, body: string) =>
  Effect.gen(function* writeStub() {
    const fs = yield* FileSystem.FileSystem;
    const bin = path.join(root, `stub-${tool}`);
    yield* fs.makeDirectory(bin, { recursive: true });
    yield* fs.writeFileString(path.join(bin, tool), `#!/bin/sh\n${body}\n`);
    yield* fs.chmod(path.join(bin, tool), 0o700);
    const real = (yield* collectToolingProcess(ChildProcess.make('sh', ['-c', `command -v ${tool}`]))).stdout.trim();
    return { [`REAL_${tool.toUpperCase()}`]: real, PATH: `${bin}:${yield* Config.String('PATH')}` };
  });
const runWith = (cwd: string, script: string, env: Readonly<Record<string, string>>) =>
  collectToolingProcess(ChildProcess.make('/bin/sh', [script], { cwd, env, extendEnv: true }));
const UNPACK_SCRIPT = `${RELEASE}/unpack.sh`;

it.live(
  'stops a start whose zstd dies mid-stream, keeps the archive and the old tree, and the next start succeeds',
  () =>
    Effect.gen(function* zstdDies() {
      const fs = yield* FileSystem.FileSystem;
      const www = yield* packedRuntime;
      yield* fs.makeDirectory(path.join(www, 'app'), { recursive: true });
      yield* fs.writeFileString(path.join(www, OLD_RELEASE), 'old');
      const env = yield* withStub(www, 'zstd', '"$REAL_ZSTD" "$@" | head -c 4096\nexit 1');
      const failed = yield* runWith(www, UNPACK_SCRIPT, env);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain('could not be unpacked (zstd status 1); the archive stays for the next start');
      expect(yield* fs.exists(path.join(www, ARCHIVE))).toBe(true);
      expect(yield* fs.readFileString(path.join(www, OLD_RELEASE))).toBe('old');
      expect(yield* fs.exists(path.join(www, STAMP))).toBe(false);
      expect(yield* fs.exists(path.join(www, '.zerops-release-unpack'))).toBe(false);
      const retried = yield* run(www, UNPACK_SCRIPT);
      expect(retried.status, retried.stderr).toBe(0);
      expect(yield* fs.exists(path.join(www, HOST))).toBe(true);
      expect(yield* fs.exists(path.join(www, OLD_RELEASE))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live('stops a start whose tar fails and replaces nothing', () =>
  Effect.gen(function* tarFails() {
    const fs = yield* FileSystem.FileSystem;
    const www = yield* packedRuntime;
    const env = yield* withStub(www, 'tar', 'cat >/dev/null\nexit 2');
    const failed = yield* runWith(www, UNPACK_SCRIPT, env);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('could not be unpacked');
    expect(yield* fs.exists(path.join(www, 'app'))).toBe(false);
    expect(yield* fs.exists(path.join(www, ARCHIVE))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live('refuses to start on a failing or malformed digest and on a malformed digest record', () =>
  Effect.gen(function* unpackDigests() {
    const fs = yield* FileSystem.FileSystem;
    for (const [label, body, reason] of [
      ['failing sha256sum', 'exit 1', 'digest could not be computed; refusing to unpack'],
      ['malformed sha256sum', 'echo "not-a-digest  $1"', "digest 'not-a-digest' is not a SHA-256; refusing to unpack"],
    ] as const) {
      const www = yield* packedRuntime;
      const failed = yield* runWith(www, UNPACK_SCRIPT, yield* withStub(www, 'sha256sum', body));
      expect(failed.status, label).toBe(1);
      expect(failed.stderr, label).toContain(reason);
      expect(yield* fs.exists(path.join(www, 'app')), label).toBe(false);
      expect(yield* fs.exists(path.join(www, ARCHIVE)), label).toBe(true);
    }
    const www = yield* packedRuntime;
    yield* fs.writeFileString(path.join(www, `${ARCHIVE}.sha256`), '\n');
    const empty = yield* run(www, UNPACK_SCRIPT);
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain('is not a SHA-256; refusing to start');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live('fails the build and writes no release when tar or the digest fails in the pack', () =>
  Effect.gen(function* packFailures() {
    const fs = yield* FileSystem.FileSystem;
    for (const [label, tool, body, reason] of [
      ['failing tar', 'tar', 'echo "tar: broken" >&2\nexit 2', 'could not be packed (tar status 2)'],
      ['failing sha256sum', 'sha256sum', 'exit 1', 'the app release digest could not be computed'],
      ['empty sha256sum', 'sha256sum', 'echo "  $1"', "the app release digest '' is not a SHA-256"],
    ] as const) {
      const build = yield* fs.makeTempDirectoryScoped({ prefix: BUILD_PREFIX });
      yield* buildTree(build);
      const packed = yield* runWith(build, `app/scripts/zerops/${PACK}`, yield* withStub(build, tool, body));
      expect(packed.status, label).toBe(1);
      expect(packed.stderr, label).toContain(reason);
      expect(yield* fs.exists(path.join(build, RELEASE)), label).toBe(false);
      expect(yield* fs.exists(path.join(build, `${RELEASE}.next`)), label).toBe(false);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
