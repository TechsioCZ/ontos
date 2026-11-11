/// <reference types="node" />

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  emitFrameworkMicroVerticalReleaseEnvelope,
  emitNodeStagedReleaseEnvelope,
  verifyNodeReleaseEnvelopeStaging,
} from '@modern-js/app-tools-extensions/release-envelope/framework-output';
import { Effect, FileSystem, Schema } from 'effect';

const require = createRequire(fileURLToPath(new URL('../../../package.json', import.meta.url)));
const metadataFile = require.resolve('@modern-js/ultramodern-app-tools/react-build-metadata-server');
const fixtureRevision = 'a'.repeat(40);
const PACKAGE_JSON = 'package.json';
const METADATA_PACKAGE = '@bleedingdev/modern-js-ultramodern-app-tools';
const FixtureJsonObjectSchema = Schema.Record(Schema.String, Schema.Json);
const FixtureJsonDocumentSchema = Schema.fromJsonString(FixtureJsonObjectSchema);
type FixtureJsonObject = typeof FixtureJsonObjectSchema.Type;
const FixturePackageSchema = Schema.StructWithRest(
  Schema.Struct({
    modernjs: Schema.optionalKey(Schema.Json),
    name: Schema.optionalKey(Schema.Json),
    version: Schema.optionalKey(Schema.Json),
  }),
  [FixtureJsonObjectSchema],
);
const FixtureTopologySchema = Schema.StructWithRest(
  Schema.Struct({ shell: Schema.optionalKey(Schema.Json), verticals: Schema.optionalKey(Schema.Json) }),
  [FixtureJsonObjectSchema],
);
const FixtureTopologyUnitSchema = Schema.StructWithRest(Schema.Struct({ id: Schema.optionalKey(Schema.Json) }), [
  FixtureJsonObjectSchema,
]);

interface SealedNodeBuildFixtureInput {
  readonly appId: string;
  readonly declaredPublicAsset?: boolean;
  readonly entry?: string;
  readonly metadataBinding?: boolean;
  readonly packageDir: string;
  readonly packageName: string;
  readonly workspaceRoot: string;
}

class NodeBuildFixtureError extends Schema.TaggedError<NodeBuildFixtureError>()('NodeBuildFixtureError', {
  reason: Schema.String,
}) {}

const writeFixtureJson = Effect.fn('NodeBuildFixture.writeJson')(function* writeFixtureJson(
  filename: string,
  value: FixtureJsonObject,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(path.dirname(filename), { recursive: true });
  const encoded = yield* Schema.encodeEffect(FixtureJsonDocumentSchema)(value);
  yield* fs.writeFileString(filename, `${encoded}\n`);
});

const readFixtureJson = Effect.fn('NodeBuildFixture.readJson')(function* readFixtureJson(filename: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(filename).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(FixtureJsonDocumentSchema)),
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed<FixtureJsonObject>({})),
  );
});

const findMetadataPackage = Effect.fn('NodeBuildFixture.findMetadataPackage')(function* findMetadataPackage() {
  let directory = path.dirname(metadataFile);
  for (;;) {
    const manifest = yield* readFixtureJson(path.join(directory, PACKAGE_JSON)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(FixturePackageSchema)),
    );
    if (manifest.name === METADATA_PACKAGE) {
      const version = yield* Schema.decodeUnknownEffect(Schema.String)(manifest.version);
      return { directory, version };
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return yield* new NodeBuildFixtureError({ reason: 'Published fixture metadata package is unavailable' });
    }
    directory = parent;
  }
});

/** Synthetic infrastructure fixture; all hashes/carriers are produced by the actual public SDK. */
export const makeSealedNodeBuildFixture = Effect.fn('NodeBuildFixture.makeSealedNodeBuildFixture')(
  function* makeSealedNodeBuildFixture(input: SealedNodeBuildFixtureInput) {
    const fs = yield* FileSystem.FileSystem;
    const packageRoot = path.join(input.workspaceRoot, input.packageDir);
    const dist = path.join(packageRoot, 'dist');
    const output = path.join(packageRoot, '.output');
    const packageFile = path.join(packageRoot, PACKAGE_JSON);
    const existingPackage = yield* readFixtureJson(packageFile).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(FixturePackageSchema)),
    );
    const modernjs = yield* Schema.decodeUnknownEffect(FixtureJsonObjectSchema)(existingPackage.modernjs ?? {});
    yield* writeFixtureJson(packageFile, {
      ...existingPackage,
      modernjs: { ...modernjs, appId: input.appId, role: 'api-only' },
      name: input.packageName,
      version: '0.1.0',
    });
    const identity = {
      appId: input.appId,
      build: '1234567890abcdef',
      buildMarker: '1234567890abcdef',
      deployProfile: 'cloudflare-ssr-mf-effect-v1',
      kind: 'microvertical-delivery-unit',
      packageName: input.packageName,
      schemaVersion: 1,
      sourceRevision: fixtureRevision,
      unitId: `app/${input.appId}`,
      version: '0.1.0',
    };
    const topologyFile = path.join(input.workspaceRoot, 'topology/reference-topology.json');
    const existing = yield* readFixtureJson(topologyFile).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(FixtureTopologySchema)),
    );
    const verticals = yield* Schema.decodeUnknownEffect(Schema.Array(FixtureTopologyUnitSchema))(
      existing.verticals ?? [],
    );
    yield* writeFixtureJson(topologyFile, {
      ...existing,
      shell: existing.shell ?? {
        id: 'shell-super-app',
        kind: 'shell',
        package: '@app/shell-super-app',
        path: 'apps/shell-super-app',
      },
      verticals: [
        ...verticals.filter((unit) => unit.id !== input.appId),
        {
          deliveryUnit: identity,
          id: input.appId,
          kind: 'vertical',
          package: input.packageName,
          path: input.packageDir,
          surfaceProfile: 'api-only',
        },
      ],
    });
    yield* fs.makeDirectory(path.join(dist, 'api'), { recursive: true });
    const encodedIdentity = yield* Schema.encodeEffect(FixtureJsonDocumentSchema)(identity);
    yield* fs.writeFileString(path.join(dist, 'api/index.js'), `exports.identity = ${encodedIdentity};\n`);
    yield* fs.writeFileString(path.join(dist, 'backendRemoteEntry.cjs'), `module.exports = ${encodedIdentity};\n`);
    yield* writeFixtureJson(path.join(dist, 'backend-mf-manifest.json'), {
      backendFederation: { deliveryUnit: identity, versionBoundary: { deliveryUnit: identity } },
    });
    yield* writeFixtureJson(path.join(dist, 'ultramodern-build.json'), {
      deliveryUnit: identity,
      kind: 'ultramodern-build-artifact',
      schemaVersion: 2,
      surfaces: { api: { ...identity, surface: 'api' } },
    });
    yield* Effect.tryPromise(
      async () =>
        await emitFrameworkMicroVerticalReleaseEnvelope({
          apiOnly: true,
          appDirectory: packageRoot,
          distDirectory: dist,
          target: 'node',
        }),
    );
    yield* fs.copy(dist, output, { overwrite: true });
    let entry = input.entry ?? 'console.log("built output");\n';
    let metadataVersion: string | undefined;
    if (input.metadataBinding === true) {
      const encodedMetadataFile = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(metadataFile);
      entry = `const plugin_0_ns = require(${encodedMetadataFile});\nconst plugin_0 = plugin_0_ns.default;\n${entry}`;
      const metadata = yield* findMetadataPackage();
      metadataVersion = metadata.version;
      const alias = path.join(packageRoot, 'node_modules/@modern-js/ultramodern-app-tools');
      yield* fs.makeDirectory(path.dirname(alias), { recursive: true });
      yield* fs.symlink(metadata.directory, alias);
      const stagedPackage = path.join(output, 'node_modules/@bleedingdev/modern-js-ultramodern-app-tools');
      yield* fs.makeDirectory(path.join(stagedPackage, 'dist/cjs/renderers/react'), { recursive: true });
      yield* fs.copy(path.join(metadata.directory, PACKAGE_JSON), path.join(stagedPackage, PACKAGE_JSON));
      yield* writeFixtureJson(path.join(stagedPackage, 'dist/cjs/package.json'), { type: 'commonjs' });
      yield* fs.copy(metadataFile, path.join(stagedPackage, 'dist/cjs/renderers/react/build-metadata-server.js'));
    }
    yield* fs.writeFileString(path.join(output, 'index.js'), entry);
    let runtimePackage: FixtureJsonObject = { name: `${input.packageName}-prod`, type: 'commonjs' };
    if (metadataVersion !== undefined) {
      runtimePackage = { ...runtimePackage, dependencies: { [METADATA_PACKAGE]: metadataVersion } };
    }
    yield* writeFixtureJson(path.join(output, PACKAGE_JSON), runtimePackage);
    const declaredPublicAssets = input.declaredPublicAsset === true ? ['public/fixture-public.txt'] : [];
    if (input.declaredPublicAsset === true) {
      yield* fs.makeDirectory(path.join(output, 'public'), { recursive: true });
      yield* fs.writeFileString(path.join(output, 'public/fixture-public.txt'), 'declared provider asset\n');
    }
    yield* Effect.tryPromise(
      async () =>
        await emitNodeStagedReleaseEnvelope({ declaredPublicAssets, distDirectory: dist, outputDirectory: output }),
    );
    yield* Effect.tryPromise(async () => await verifyNodeReleaseEnvelopeStaging({ outputDirectory: output }));
    return { dist, metadataFile, output, packageRoot, sourceRevision: fixtureRevision };
  },
);
