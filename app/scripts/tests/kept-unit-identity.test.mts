import { createHash } from 'node:crypto';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { createUltramodernReleaseBuildMarker } from '@modern-js/app-tools-extensions/release-identity';
import { Effect, Exit, FileSystem, Schema } from 'effect';
import { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';

import { resolveOwnerReleaseIdentity } from '../ci/kept-unit-identity.mts';
import { CacheReceiptSchema } from '../ci/unit-output-receipt.mts';
import { readSources, readWorkspace } from '../zerops/delivery-plan-cli.mts';
import { unitIdentity, unitInputGraph } from '../zerops/delivery-plan.mts';
import { collectToolingProcess } from './tooling-process-fixture.mts';

const SHELL = 'apps/shell-super-app';
const GENERATION = 'generation-marker';
const UNIT_ID = 'app/shell-super-app';
const OLD_REVISION = 'a'.repeat(40);
const METADATA = 'dist/ultramodern-build.json';
/** A committed workspace with one unit; built outputs and caches are ignored, as in the real checkout. */
const COMMITTED = {
  '.gitignore': 'dist/\nnode_modules/\n',
  'app/apps/shell-super-app/package.json': JSON.stringify({ name: '@app/shell-super-app', scripts: { build: 'x' } }),
  'app/apps/shell-super-app/src/index.ts': 'export const shell = 1;\n',
  'app/scripts/zerops/build-app.sh': 'echo build\n',
  'app/topology/application-release-intent.json': JSON.stringify({ modules: [] }),
  'app/topology/reference-topology.json': JSON.stringify({ shell: { path: SHELL }, verticals: [] }),
} satisfies Readonly<Record<string, string>>;
const markerAt = (revision: string) =>
  createUltramodernReleaseBuildMarker({ generationBuildMarker: GENERATION, sourceRevision: revision, unitId: UNIT_ID });
/** No ULTRAMODERN_SOURCE_REVISION: the fixture checkout's own clean HEAD is the source revision. */
const ENVIRONMENT = {};

const git = (repository: string, args: readonly string[]) =>
  collectToolingProcess(ChildProcess.make('git', ['-C', repository, ...args])).pipe(
    Effect.map(({ stdout }) => stdout.trim()),
  );

const fixture = Effect.gen(function* keptUnitFixture() {
  const fs = yield* FileSystem.FileSystem;
  const repository = yield* fs.makeTempDirectoryScoped();
  const write = (file: string, content: string) =>
    fs
      .makeDirectory(path.dirname(path.join(repository, file)), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(path.join(repository, file), content)));
  for (const [file, content] of Object.entries(COMMITTED)) {
    yield* write(file, content);
  }
  yield* git(repository, ['init', '-q']);
  yield* git(repository, ['add', '-A']);
  yield* git(repository, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'fixture']);
  const head = yield* git(repository, ['rev-parse', 'HEAD']);
  const workspaceRoot = path.join(repository, 'app');
  const workspace = yield* readWorkspace(head, workspaceRoot);
  const graph = unitInputGraph({ ...workspace, sources: yield* readSources(workspace.entries, workspaceRoot) });
  const headInputs = (yield* unitIdentity(`app/${SHELL}`, { environment: [], graph })).files;
  /** Writes a built Shell naming `revision`, and its gates receipt unless `receipt` is false. */
  const build = (revision: string, overrides: { readonly inputs?: string; readonly marker?: string } = {}) =>
    Effect.gen(function* writeBuild() {
      const identity = {
        appId: 'shell-super-app',
        build: overrides.marker ?? markerAt(revision),
        buildMarker: overrides.marker ?? markerAt(revision),
        sourceRevision: revision,
      };
      const metadataText = JSON.stringify({ deliveryUnit: identity });
      const metadata = new TextEncoder().encode(metadataText);
      yield* write(`app/${SHELL}/${METADATA}`, metadataText);
      const receipt = yield* Schema.encodeEffect(Schema.fromJsonString(CacheReceiptSchema))({
        digest: 'c'.repeat(64),
        files: [
          {
            mode: 0o644,
            path: METADATA,
            sha256: createHash('sha256').update(metadata).digest('hex'),
            size: metadata.byteLength,
          },
        ],
        identity,
        inputs: overrides.inputs ?? headInputs,
        schemaVersion: 2,
        unit: 'shell-super-app',
      });
      yield* write(`app/${SHELL}/dist/.gates-output-cache.json`, receipt);
    });
  const resolve = () =>
    resolveOwnerReleaseIdentity({
      environment: ENVIRONMENT,
      generationBuildMarker: GENERATION,
      unitDirectory: SHELL,
      unitId: UNIT_ID,
      workspaceRoot,
    });
  return { build, fs, head, markerAt, repository, resolve };
});
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));
const refused = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.exit(effect).pipe(Effect.map(Exit.isFailure));

it.effect(
  'without built output, and for a build of the checkout itself, runs as the checkout',
  () =>
    run(
      Effect.gen(function* checkoutIdentity() {
        const context = yield* fixture;
        const checkout = { buildMarker: context.markerAt(context.head), sourceRevision: context.head };
        expect(yield* context.resolve()).toEqual(checkout);
        yield* context.build(context.head);
        expect(yield* context.resolve()).toEqual(checkout);
      }),
    ),
  30_000,
);

it.effect(
  'runs a kept unit as the release it was built at once its receipt proves the same sources',
  () =>
    run(
      Effect.gen(function* keptIdentity() {
        const context = yield* fixture;
        yield* context.build(OLD_REVISION);
        expect(yield* context.resolve()).toEqual({
          buildMarker: context.markerAt(OLD_REVISION),
          sourceRevision: OLD_REVISION,
        });
      }),
    ),
  30_000,
);

it.effect(
  'refuses a kept unit built from other sources than the checkout',
  () =>
    run(
      Effect.gen(function* otherSources() {
        const context = yield* fixture;
        yield* context.build(OLD_REVISION, { inputs: 'd'.repeat(64) });
        expect(yield* refused(context.resolve())).toBe(true);
      }),
    ),
  30_000,
);

it.effect(
  'refuses a kept unit without a receipt, with a receipt of another build, or with a foreign marker',
  () =>
    run(
      Effect.gen(function* unprovenKeep() {
        const context = yield* fixture;
        const receipt = path.join(context.repository, 'app', SHELL, 'dist/.gates-output-cache.json');
        yield* context.build(OLD_REVISION);
        yield* context.fs.remove(receipt);
        // No receipt: nothing proves which sources the bytes came from.
        expect(yield* refused(context.resolve())).toBe(true);
        // The receipt was written for these bytes, then the build identity changed underneath it.
        yield* context.build(OLD_REVISION);
        const metadata = path.join(context.repository, 'app', SHELL, METADATA);
        yield* context.fs.writeFileString(
          metadata,
          (yield* context.fs.readFileString(metadata)).replace(OLD_REVISION, 'b'.repeat(40)),
        );
        expect(yield* refused(context.resolve())).toBe(true);
        // A marker that is not this unit's marker at the revision it names.
        yield* context.build(OLD_REVISION, { marker: 'e'.repeat(64) });
        expect(yield* refused(context.resolve())).toBe(true);
      }),
    ),
  30_000,
);
