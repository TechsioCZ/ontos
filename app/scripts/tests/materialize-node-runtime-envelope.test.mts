import { cp } from 'node:fs/promises';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { verifyNodeReleaseEnvelopeStaging } from '@modern-js/app-tools-extensions/release-envelope/framework-output';
import { Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { NodeRuntimeEnvelopeError, normalizeAndSealNodeRuntime } from '../materialize-node-runtime-envelope.mts';
import { makeSealedNodeBuildFixture } from './support/node-runtime-envelope-fixture.mts';

const ENVELOPE = 'release/microvertical-release-envelope.json';
const UNKNOWN_BINDING = 'unknown-binding';
const DIFFERENT_DEPENDENCY = 'different-dependency';

const fixture = (options: { readonly declaredPublicAsset?: boolean; readonly metadataBinding?: boolean } = {}) =>
  Effect.gen(function* realSealedFixture() {
    const fs = yield* FileSystem.FileSystem;
    const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-node-envelope-' });
    const identity = { appId: 'fixture', packageDir: 'verticals/fixture', packageName: '@app/fixture', workspaceRoot };
    const built = yield* makeSealedNodeBuildFixture({ ...identity, ...options });
    const runtimeDir = path.join(workspaceRoot, '.zerops/runtime/fixture');
    yield* fs.copy(built.output, runtimeDir, { overwrite: true });
    return { ...identity, ...built, runtimeDir };
  });

const check = (outputDirectory: string) =>
  Effect.tryPromise(() => verifyNodeReleaseEnvelopeStaging({ outputDirectory }));

it.effect('reseals finalized package metadata using the public SDK without adding React to an API-only owner', () =>
  Effect.gen(function* resealRealPublicSdkOutput() {
    const fs = yield* FileSystem.FileSystem;
    const built = yield* fixture();
    const rawEnvelope = yield* fs.readFileString(path.join(built.output, ENVELOPE));
    yield* fs.writeFileString(
      path.join(built.runtimeDir, 'package.json'),
      '{"name":"@app/fixture-prod","type":"commonjs","private":true,"scripts":{"serve":"node index.js"}}\n',
    );
    yield* check(built.runtimeDir).pipe(Effect.flip);
    yield* normalizeAndSealNodeRuntime(built);
    const sealed = yield* check(built.runtimeDir);
    expect(sealed?.identity.sourceRevision).toBe(built.sourceRevision);
    expect(sealed?.artifacts.some((artifact) => artifact.logicalPath === 'package.json')).toBe(true);
    expect(yield* fs.readFileString(path.join(built.output, ENVELOPE))).toBe(rawEnvelope);
    yield* check(built.output);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  'normalizes only the generated renderer binding to its byte-identical public dependency and reseals index.js',
  () =>
    Effect.gen(function* publicRendererBinding() {
      const fs = yield* FileSystem.FileSystem;
      const built = yield* fixture({ metadataBinding: true });
      const original = yield* fs.readFileString(path.join(built.output, 'index.js'));
      yield* normalizeAndSealNodeRuntime(built);
      const normalized = yield* fs.readFileString(path.join(built.runtimeDir, 'index.js'));
      expect(normalized).not.toContain(built.metadataFile);
      expect(normalized).toContain(
        'require("@bleedingdev/modern-js-ultramodern-app-tools/react-build-metadata-server")',
      );
      expect(normalized).toContain('const plugin_0 = plugin_0_ns.default;');
      expect(yield* fs.readFileString(path.join(built.output, 'index.js'))).toBe(original);
      yield* check(built.runtimeDir);
      yield* check(built.output);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('seals copied nested workspace Node outputs before the parent envelope binds their final envelopes', () =>
  Effect.gen(function* nestedSealingOrder() {
    const fs = yield* FileSystem.FileSystem;
    const built = yield* fixture();
    const nested = yield* makeSealedNodeBuildFixture({
      appId: 'nested',
      metadataBinding: true,
      packageDir: 'verticals/nested',
      packageName: '@app/nested',
      workspaceRoot: built.workspaceRoot,
    });
    const copied = path.join(built.runtimeDir, 'node_modules/@app/nested');
    yield* Effect.tryPromise(() =>
      cp(nested.packageRoot, copied, {
        filter: (source) => !source.includes(`${path.sep}node_modules`),
        recursive: true,
      }),
    );
    yield* Effect.tryPromise(() =>
      cp(
        path.join(nested.output, 'node_modules/@bleedingdev'),
        path.join(built.runtimeDir, 'node_modules/@bleedingdev'),
        { recursive: true },
      ),
    );
    const rawNested = yield* fs.readFileString(path.join(nested.output, 'index.js'));
    yield* normalizeAndSealNodeRuntime(built);
    yield* check(path.join(copied, '.output'));
    const parent = yield* check(built.runtimeDir);
    expect(
      parent?.artifacts.some(
        (artifact) =>
          artifact.logicalPath === 'node_modules/@app/nested/.output/release/microvertical-release-envelope.json',
      ),
    ).toBe(true);
    expect(yield* fs.readFileString(path.join(nested.output, 'index.js'))).toBe(rawNested);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('preserves declared public asset classification through the real SDK reseal', () =>
  Effect.gen(function* declaredAssets() {
    const fs = yield* FileSystem.FileSystem;
    const built = yield* fixture({ declaredPublicAsset: true });
    yield* normalizeAndSealNodeRuntime(built);
    const sealed = yield* check(built.runtimeDir);
    expect(sealed?.artifacts.find((artifact) => artifact.logicalPath === 'public/fixture-public.txt')?.runtime).toBe(
      'public-asset',
    );
    expect(yield* fs.readFileString(path.join(built.runtimeDir, 'public/fixture-public.txt'))).toBe(
      'declared provider asset\n',
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const invalid of [
  'original-dist',
  UNKNOWN_BINDING,
  'nested-absolute',
  'unsupported-esm',
  'changed-source',
  DIFFERENT_DEPENDENCY,
  'wrong-source-revision',
]) {
  it.effect(`rejects ${invalid} without rewriting original build bytes`, () =>
    Effect.gen(function* invalidSealingControl() {
      const fs = yield* FileSystem.FileSystem;
      const built = yield* fixture({ metadataBinding: [DIFFERENT_DEPENDENCY, UNKNOWN_BINDING].includes(invalid) });
      const rawBefore = yield* fs.readFileString(path.join(built.output, 'index.js'));
      const distBefore = yield* fs.readFileString(path.join(built.dist, ENVELOPE));
      if (invalid === UNKNOWN_BINDING) {
        yield* fs.writeFileString(
          path.join(built.runtimeDir, 'index.js'),
          'const plugin_0_ns = require("/arbitrary/foreign.js");\n',
        );
      }
      if (invalid === 'nested-absolute') {
        yield* fs.writeFileString(
          path.join(built.runtimeDir, 'index.js'),
          'function load() { return require("/arbitrary/foreign.js"); }\n',
        );
      }
      if (invalid === 'unsupported-esm') {
        yield* fs.writeFileString(
          path.join(built.runtimeDir, 'index.js'),
          'import value from "/arbitrary/foreign.js";\n',
        );
      }
      if (invalid === 'changed-source') {
        yield* fs.writeFileString(path.join(built.dist, 'api/index.js'), 'exports.changed = true;\n');
      }
      if (invalid === DIFFERENT_DEPENDENCY) {
        yield* fs.writeFileString(
          path.join(
            built.runtimeDir,
            'node_modules/@bleedingdev/modern-js-ultramodern-app-tools/dist/cjs/renderers/react/build-metadata-server.js',
          ),
          'module.exports = {};\n',
        );
      }
      const rejected = yield* normalizeAndSealNodeRuntime({
        ...built,
        runtimeDir: invalid === 'original-dist' ? built.dist : built.runtimeDir,
        sourceRevision: invalid === 'wrong-source-revision' ? 'b'.repeat(40) : built.sourceRevision,
      }).pipe(Effect.flip);
      expect(Schema.is(NodeRuntimeEnvelopeError)(rejected)).toBe(true);
      if (invalid === UNKNOWN_BINDING) {
        expect(rejected.reason).toContain('Unexpected absolute Node bootstrap binding');
      }
      expect(yield* fs.readFileString(path.join(built.output, 'index.js'))).toBe(rawBefore);
      expect(yield* fs.readFileString(path.join(built.dist, ENVELOPE))).toBe(distBefore);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
