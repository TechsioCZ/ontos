import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';

import { collectToolingProcess } from './tooling-process-fixture.mts';

interface WorkspaceApp {
  readonly id: string;
  readonly kind: 'shell' | 'vertical';
}

interface WorkspaceInputs {
  readonly apps: readonly WorkspaceApp[];
  readonly config: { readonly workspace: { readonly packageScope: string } };
}

type BuildFactory = (scope: string, app: WorkspaceApp) => string;
type WorkspaceReader = (root: string) => WorkspaceInputs;

const callable = <Callable extends (...argumentsList: never[]) => void>() =>
  Schema.Opaque<Callable>()(Schema.Unknown.pipe(Schema.refine(Predicate.isFunction)));
const BuildModuleSchema = Schema.Struct({
  createUltramodernBuildArtifactJson: callable<BuildFactory>(),
  createUltramodernBuildModule: callable<BuildFactory>(),
});
const ConfigModuleSchema = Schema.Struct({
  readUltramodernWorkspaceInputs: callable<WorkspaceReader>(),
});
const ArtifactSchema = Schema.fromJsonString(
  Schema.Struct({
    deliveryUnit: Schema.Unknown,
    surfaces: Schema.Struct({ api: Schema.Unknown, ui: Schema.optional(Schema.Unknown) }),
  }),
);
const ExportsSchema = Schema.fromJsonString(
  Schema.Struct({
    ultramodernApiMarker: Schema.optional(Schema.Unknown),
    ultramodernDeliveryUnit: Schema.Unknown,
    ultramodernUiMarker: Schema.optional(Schema.Unknown),
  }),
);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const generatorRoot = path.join(workspaceRoot, 'node_modules/@modern-js/ultramodern-create');
const generatorRequire = createRequire(path.join(generatorRoot, 'package.json'));
const contractsPackage = '@modern-js/backend-federation-contracts';
const contractsRoot = fileURLToPath(new URL('../../..', pathToFileURL(generatorRequire.resolve(contractsPackage))));
const applicationIds = ['commerce-customer-context', 'party-registry', 'shell-super-app'];
const overrideMarker = 'generated-metadata-regression-build';
const overrideRevision = 'generated-metadata-regression-revision';
const buildFilename = 'ultramodern-build.ts';
const jsonFilename = 'ultramodern-build.json';

const makeFixture = Effect.fn(function* makeFixture() {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-generated-metadata-' });
  const dependencyScope = path.join(directory, 'node_modules/@modern-js');
  yield* fs.makeDirectory(dependencyScope, { recursive: true });
  yield* fs.symlink(contractsRoot, path.join(dependencyScope, 'backend-federation-contracts'));
  yield* fs.writeFileString(path.join(directory, 'package.json'), encodeJson({ private: true, type: 'module' }));
  return directory;
});

const runNode = (directory: string, source: string) =>
  collectToolingProcess(
    ChildProcess.make(process.execPath, ['--input-type=module', '--eval', source], {
      cwd: directory,
      // Do not let an ambient transform-types option hide a strip-only regression.
      env: { NODE_OPTIONS: '' },
      extendEnv: true,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    }),
  );

for (const format of ['cjs', 'esm', 'esm-node']) {
  for (const override of [false, true]) {
    it.live(
      `${format} emitted metadata imports in raw Node with ${override ? 'marker overrides' : 'canonical JSON values'}`,
      Effect.fn(
        function* importsGeneratedMetadata() {
          const extension = format === 'cjs' ? 'cjs' : 'js';
          const loadModule = (relativePath: string) =>
            Effect.tryPromise(
              () =>
                import(pathToFileURL(path.join(generatorRoot, 'dist', format, `${relativePath}.${extension}`)).href),
            );
          const generator = Schema.decodeUnknownSync(BuildModuleSchema)(
            yield* loadModule('ultramodern-workspace/module-federation/reexport-module'),
          );
          const config = Schema.decodeUnknownSync(ConfigModuleSchema)(yield* loadModule('ultramodern-tooling/config'));
          const inputs = config.readUltramodernWorkspaceInputs(workspaceRoot);
          const scope = inputs.config.workspace.packageScope;
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* makeFixture();
          for (const id of applicationIds) {
            const app = yield* Effect.fromNullishOr(inputs.apps.find((candidate) => candidate.id === id));
            const source = generator.createUltramodernBuildModule(scope, app);
            const json = generator.createUltramodernBuildArtifactJson(scope, app);
            const inlineArtifact = /const buildArtifact = (?<artifact>[\s\S]*?) as const;/u.exec(source)?.groups
              ?.artifact;
            expect(inlineArtifact).toBeDefined();
            expect(decodeJson(inlineArtifact)).toEqual(decodeJson(json));
            const canonical = Schema.decodeUnknownSync(ArtifactSchema)(json);
            const applicationDirectory = path.join(directory, id);
            yield* fs.makeDirectory(applicationDirectory);
            yield* fs.writeFileString(path.join(applicationDirectory, buildFilename), source);
            yield* fs.writeFileString(path.join(applicationDirectory, jsonFilename), json);
            const overrides = override
              ? `globalThis.ULTRAMODERN_BUILD_MARKER = ${encodeJson(overrideMarker)};
globalThis.ULTRAMODERN_SOURCE_REVISION = ${encodeJson(overrideRevision)};`
              : '';
            const result = yield* runNode(
              directory,
              `${overrides}
const metadata = await import(${encodeJson(`./${id}/${buildFilename}`)});
console.log(JSON.stringify(metadata));`,
            );
            expect(result.status, result.stdout + result.stderr).toBe(0);
            const actual = Schema.decodeUnknownSync(ExportsSchema)(result.stdout.trim());
            if (override) {
              const expected = {
                appId: id,
                build: overrideMarker,
                buildMarker: overrideMarker,
                sourceRevision: overrideRevision,
              };
              expect(actual.ultramodernDeliveryUnit).toMatchObject(expected);
              if (app.kind !== 'shell') {
                expect(actual.ultramodernApiMarker).toMatchObject(expected);
              }
              if (canonical.surfaces.ui !== undefined) {
                expect(actual.ultramodernUiMarker).toMatchObject({
                  ...expected,
                  rendererIdentity: { appId: id, buildId: overrideMarker },
                });
              }
            } else {
              expect(actual.ultramodernDeliveryUnit).toEqual(canonical.deliveryUnit);
              expect(actual.ultramodernApiMarker).toEqual(app.kind === 'shell' ? undefined : canonical.surfaces.api);
              expect(actual.ultramodernUiMarker).toEqual(canonical.surfaces.ui);
            }
            expect(yield* fs.readFileString(path.join(applicationDirectory, jsonFilename))).toBe(json);
          }
        },
        Effect.scoped,
        Effect.provide(NodeServices.layer),
      ),
    );
  }
}

it.live(
  'raw Node rejects the adjacent import-equals control instead of silently transforming it',
  Effect.fn(
    function* rejectsImportEquals() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* makeFixture();
      yield* fs.writeFileString(path.join(directory, jsonFilename), encodeJson({ appId: 'invalid-control' }));
      yield* fs.writeFileString(
        path.join(directory, buildFilename),
        `import buildArtifact = require('./${jsonFilename}');
export const ultramodernApiMarker = buildArtifact;
`,
      );
      const result = yield* runNode(directory, `await import('./${buildFilename}');`);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX');
      expect(result.stderr).toContain('TypeScript import equals declaration');
    },
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);
