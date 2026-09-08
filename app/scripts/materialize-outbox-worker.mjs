import { isBuiltin } from 'node:module';

import { NodeServices } from '@effect/platform-node';
import { Config, Effect, FileSystem, ManagedRuntime, Path, Schema } from 'effect';
import { build } from 'esbuild';

import { outboxWorkerDelivery } from './outbox-worker-delivery.mjs';

const TopologySchema = Schema.fromJsonString(
  Schema.Struct({
    verticals: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        moduleFederation: Schema.Struct({ manifestUrl: Schema.String }),
        package: Schema.String,
        path: Schema.String,
      }),
    ),
  }),
);

const PackageManifestSchema = Schema.fromJsonString(
  Schema.Struct({
    dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    name: Schema.String,
  }),
);

const MetafileInputsSchema = Schema.Struct({
  inputs: Schema.Record(Schema.String, Schema.Unknown),
});

const WORKER_ENTRY = 'worker.mjs';
const AppIdSchema = Schema.String.pipe(Schema.brand('AppId'));
const ServiceIdSchema = Schema.String.pipe(Schema.brand('ServiceId'));

const WorkerArtifactSchema = Schema.fromJsonString(
  Schema.Struct({
    appId: AppIdSchema,
    entry: Schema.Literal(WORKER_ENTRY),
    schemaVersion: Schema.Literal(1),
    serviceId: ServiceIdSchema,
    sourceInputs: Schema.Array(Schema.String),
    sourceRevision: Schema.OptionFromNullOr(Schema.String),
  }),
  { space: 2 },
);

class OutboxWorkerMaterializationError extends Error {
  /** @param {string} message Error detail. */
  constructor(message) {
    super(message);
    this.name = 'OutboxWorkerMaterializationError';
    this._tag = 'OutboxWorkerMaterializationError';
  }
}

/** @param {string} message Error detail. */
const failure = (message) => new OutboxWorkerMaterializationError(message);

const nodeRuntime = ManagedRuntime.make(NodeServices.layer);

/**
 * esbuild compiles filters with Go regular expressions, where Unicode semantics are implicit and
 * the JavaScript `u` flag is rejected. Author filters as Unicode-aware JavaScript expressions and
 * remove only that transport-only flag at the esbuild boundary.
 * @param {RegExp} pattern Unicode-aware source expression.
 * @returns {RegExp} Equivalent esbuild-compatible filter.
 */
const esbuildFilter = (pattern) => new RegExp(pattern.source, pattern.flags.replaceAll('u', ''));

/**
 * @param {{
 *   packages: Map<string, { manifest: Schema.Schema.Type<typeof PackageManifestSchema> }>,
 *   path: import('effect/Path').Path,
 *   workspaceRoot: string,
 * }} context Plugin dependencies.
 * @returns {import('esbuild').Plugin} Production dependency externalization plugin.
 */
const makeProductionDependenciesPlugin = ({ packages, path, workspaceRoot }) => ({
  name: 'worker-production-dependencies',
  setup(builder) {
    builder.onResolve({ filter: esbuildFilter(/^@effect\/platform-node$/u) }, () => ({
      namespace: 'worker-platform-node',
      path: '@effect/platform-node',
    }));
    builder.onLoad(
      {
        filter: esbuildFilter(/.*/u),
        namespace: 'worker-platform-node',
      },
      () => ({
        contents: [
          "import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';",
          "import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';",
          "import * as NodePath from '@effect/platform-node/NodePath';",
          'export { NodeFileSystem, NodeHttpServer, NodePath };',
        ].join('\n'),
        loader: 'js',
        resolveDir: workspaceRoot,
      }),
    );
    builder.onResolve({ filter: esbuildFilter(/^[^./]/u) }, (args) => {
      if (isBuiltin(args.path)) {
        return { external: true, path: args.path };
      }
      const name = args.path.startsWith('@')
        ? args.path.split('/').slice(0, 2).join('/')
        : args.path.split('/').at(0);
      if (args.path === '@app/core-runtime') {
        return {
          path: path.join(workspaceRoot, 'packages/core-runtime/src/outbox/worker-entrypoint.ts'),
        };
      }
      if (name !== undefined && packages.has(name)) {
        return null;
      }
      return { external: true, path: args.path };
    });
  },
});

/**
 * @param {string} importedPath External dependency specifier.
 * @param {Map<string, { manifest: Schema.Schema.Type<typeof PackageManifestSchema> }>} packages Workspace manifests.
 * @param {Record<string, string>} dependencies Collected production versions.
 */
const collectProductionDependency = (importedPath, packages, dependencies) =>
  Effect.gen(function* collectProductionDependencyEffect() {
    if (isBuiltin(importedPath)) {
      return null;
    }
    const name = importedPath.startsWith('@')
      ? importedPath.split('/').slice(0, 2).join('/')
      : importedPath.split('/').at(0);
    if (name === undefined) {
      return yield* Effect.fail(failure(`Invalid worker dependency ${importedPath}`));
    }
    const versions = [...packages.values()].flatMap(({ manifest }) => {
      const version = manifest.dependencies?.[name];
      return version !== undefined && !version.startsWith('workspace:') ? [version] : [];
    });
    const uniqueVersions = [...new Set(versions)];
    if (uniqueVersions.length !== 1) {
      return yield* Effect.fail(
        failure(`Worker dependency ${name} must have one declared production version`),
      );
    }
    const [version] = uniqueVersions;
    if (version === undefined) {
      return yield* Effect.fail(failure(`Worker dependency ${name} has no version`));
    }
    dependencies[name] = version;
    return null;
  });

/**
 * @typedef {{
 *   appId: string,
 *   packageDir: string,
 *   packageName: string,
 *   runtimeDir: string,
 *   workspaceRoot: string,
 * }} MaterializeOptions
 */

/**
 * Bundle owner + Core code; retain exact production dependencies, never workspace links.
 * @param {MaterializeOptions} options Materialization identity and paths.
 */
const materializeOutboxWorkerEffect = ({
  appId,
  packageDir,
  packageName,
  runtimeDir,
  workspaceRoot,
}) =>
  Effect.gen(function* materializeWorker() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const topologySource = yield* fs.readFileString(
      path.join(workspaceRoot, 'topology/reference-topology.json'),
    );
    const topology = yield* Schema.decodeUnknownEffect(TopologySchema)(topologySource);
    const vertical = topology.verticals.find((candidate) => candidate.id === appId);
    if (
      vertical === undefined ||
      vertical.package !== packageName ||
      vertical.path !== packageDir
    ) {
      return yield* Effect.fail(failure('Worker identity must match its topology owner'));
    }
    const delivery = yield* outboxWorkerDelivery(workspaceRoot, vertical).pipe(
      Effect.mapError(() => failure(`Invalid generated worker delivery for ${appId}`)),
    );
    if (delivery === undefined) {
      return yield* Effect.fail(failure(`${appId} has no generated Outbox Worker host`));
    }
    /** @type {Record<string, string>} */
    const dependencies = {};
    /** @type {Map<string, { manifest: Schema.Schema.Type<typeof PackageManifestSchema> }>} */
    const packages = new Map();
    const collectWorkspacePackages = Effect.gen(function* collectWorkspacePackagesEffect() {
      for (const directory of ['packages', 'apps', 'verticals']) {
        const parent = path.join(workspaceRoot, directory);
        if (!(yield* fs.exists(parent))) {
          continue;
        }
        for (const entry of yield* fs.readDirectory(parent)) {
          const manifestPath = path.join(parent, entry, 'package.json');
          if (!(yield* fs.exists(manifestPath))) {
            continue;
          }
          const manifestSource = yield* fs.readFileString(manifestPath);
          const manifest = yield* Schema.decodeUnknownEffect(PackageManifestSchema)(manifestSource);
          packages.set(manifest.name, { manifest });
        }
      }
    });
    yield* collectWorkspacePackages;
    const result = yield* Effect.tryPromise({
      catch: () => failure(`Unable to bundle the ${appId} Outbox Worker`),
      try: () =>
        /** @type {PromiseLike<import('esbuild').BuildResult<{ metafile: true }>>} */
        (
          build({
            absWorkingDir: workspaceRoot,
            banner: {
              js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
            },
            bundle: true,
            entryPoints: [path.join(packageDir, delivery.entry)],
            format: 'esm',
            metafile: true,
            outfile: path.join(runtimeDir, WORKER_ENTRY),
            platform: 'node',
            plugins: [
              makeProductionDependenciesPlugin({
                packages,
                path,
                workspaceRoot,
              }),
            ],
            target: 'node26',
          })
        ),
    });
    const { metafile } = result;
    const externalImports = Object.values(metafile.outputs).flatMap((output) =>
      output.imports.filter((item) => item.external === true),
    );
    for (const imported of externalImports) {
      yield* collectProductionDependency(imported.path, packages, dependencies);
    }
    yield* fs.copyFile(
      path.join(workspaceRoot, 'topology/reference-topology.json'),
      path.join(runtimeDir, 'topology.json'),
    );
    const sourceRevision = yield* Config.option(Config.string('ULTRAMODERN_SOURCE_REVISION'));
    const artifactAppId = yield* Schema.decodeUnknownEffect(AppIdSchema)(appId);
    const artifactServiceId = yield* Schema.decodeUnknownEffect(ServiceIdSchema)(delivery.id);
    const { inputs: sourceInputMetadata } =
      yield* Schema.decodeUnknownEffect(MetafileInputsSchema)(metafile);
    /** @type {string[]} */
    const sourceInputs = [];
    for (const sourceInput in sourceInputMetadata) {
      if (Object.hasOwn(sourceInputMetadata, sourceInput)) {
        sourceInputs.push(sourceInput);
      }
    }
    sourceInputs.sort();
    const artifactSource = yield* Schema.encodeEffect(WorkerArtifactSchema)({
      appId: artifactAppId,
      entry: WORKER_ENTRY,
      schemaVersion: 1,
      serviceId: artifactServiceId,
      sourceInputs,
      sourceRevision,
    });
    yield* fs.writeFileString(path.join(runtimeDir, 'worker-artifact.json'), `${artifactSource}\n`);
    return {
      dependencies,
      name: `${delivery.id}-runtime`,
      private: true,
      scripts: { serve: `node ${WORKER_ENTRY}` },
      type: 'module',
    };
  });

/**
 * @param {MaterializeOptions} options Materialization identity and paths.
 * @returns {PromiseLike<{
 *   dependencies: Record<string, string>,
 *   name: string,
 *   private: boolean,
 *   scripts: { serve: string },
 *   type: string,
 * }>} Materialized runtime package manifest.
 */
export const materializeOutboxWorker = (options) =>
  nodeRuntime.runPromise(materializeOutboxWorkerEffect(options));
