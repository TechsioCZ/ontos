import { isBuiltin } from 'node:module';

import { NodeServices } from '@effect/platform-node';
import {
  resolveUltramodernReleaseIdentity,
  resolveUltramodernSourceRevision,
} from '@modern-js/app-tools-extensions/release-identity';
import { Effect, FileSystem, ManagedRuntime, Option, Path, Schema } from 'effect';
import { build, transform } from 'esbuild';
import { parseSync } from 'oxc-parser';

import { readOutboxWorkerHost, renderOutboxWorkerHostEntry } from './generate-outbox-worker-deployment.mjs';
import { OUTBOX_WORKER_BUNDLE, OUTBOX_WORKER_HOST, outboxWorkerDelivery } from './outbox-worker-delivery.mjs';

const TOPOLOGY_PATH = 'topology/reference-topology.json';
const UnitIdSchema = Schema.String.pipe(Schema.brand('UnitId'));
const BuildConstantSchema = Schema.fromJsonString(Schema.String);

const TopologySchema = Schema.fromJsonString(
  Schema.Struct({
    verticals: Schema.Array(
      Schema.Struct({
        deliveryUnit: Schema.optionalKey(
          Schema.Struct({
            buildMarker: Schema.String,
            packageName: Schema.String,
            sourceRevision: Schema.String,
            unitId: UnitIdSchema,
          }),
        ),
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

const WORKER_ENTRY = OUTBOX_WORKER_BUNDLE;
const CORE_WORKER_ENTRYPOINT = 'packages/core-runtime/src/outbox/worker-entrypoint.ts';

const CORE_WORKER_SPECIFIERS = new Set(['@app/core-runtime', '@app/core-runtime/outbox/worker']);

/**
 * Value names a TypeScript module re-exports from `@app/core-runtime` or its `outbox/worker` subpath (both
 * resolve to the focused worker entrypoint), read from the parsed module record so comments, strings, and
 * type-only specifiers never count. Named imports need no check: esbuild already rejects a missing one.
 * @param {string} filename Module path, which selects the TypeScript or TSX grammar.
 * @param {string} source Module source.
 * @returns {string[]} Re-exported entrypoint names.
 */
export const coreRuntimeValueReExports = (filename, source) =>
  parseSync(filename, source).module.staticExports.flatMap((statement) =>
    statement.entries
      .filter(
        (entry) =>
          !entry.isType &&
          entry.importName.name !== null &&
          entry.moduleRequest !== null &&
          CORE_WORKER_SPECIFIERS.has(entry.moduleRequest.value),
      )
      .map((entry) => entry.importName.name ?? ''),
  );

/**
 * Value names the focused Core worker entrypoint exports, read from its parsed module record.
 * @param {string} source Entrypoint source.
 * @returns {Set<string>} Exported value names.
 */
export const focusedEntrypointValueExports = (source) =>
  new Set(
    parseSync(CORE_WORKER_ENTRYPOINT, source).module.staticExports.flatMap((statement) =>
      statement.entries.filter((entry) => !entry.isType).map((entry) => entry.exportName.name ?? ''),
    ),
  );
const AppIdSchema = Schema.String.pipe(Schema.brand('AppId'));
const ServiceIdSchema = Schema.String.pipe(Schema.brand('ServiceId'));
const OwnerBuildIdentitySchema = Schema.Struct({
  appId: AppIdSchema,
  buildMarker: Schema.String,
  sourceRevision: Schema.String,
  unitId: UnitIdSchema,
});

const WorkerArtifactSchema = Schema.fromJsonString(
  Schema.Struct({
    appId: AppIdSchema,
    entry: Schema.Literal(WORKER_ENTRY),
    ownerBuildIdentities: Schema.Array(OwnerBuildIdentitySchema),
    schemaVersion: Schema.Literal(2),
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
 * @param {string} markerPath Original owner-local generated source path.
 * @param {{ identity: Schema.Schema.Type<typeof OwnerBuildIdentitySchema>, source: string }} marker Resolved identity and source.
 * @param {import('effect/Path').Path} path Platform paths.
 * @param {Set<string>} compiledMarkers Successfully compiled source paths.
 * @returns {Effect.Effect<import('esbuild').OnLoadResult, OutboxWorkerMaterializationError | Schema.SchemaError>} Compiled owner marker source.
 */
const compileOwnerBuildIdentityEffect = (markerPath, marker, path, compiledMarkers) =>
  Effect.gen(function* compileOwnerBuildIdentity() {
    const buildMarker = yield* Schema.encodeEffect(BuildConstantSchema)(marker.identity.buildMarker);
    const sourceRevision = yield* Schema.encodeEffect(BuildConstantSchema)(marker.identity.sourceRevision);
    const result = yield* Effect.tryPromise({
      catch: () => failure(`Unable to compile the ${marker.identity.appId} Outbox Worker build identity`),
      try: () =>
        /** @type {PromiseLike<import('esbuild').TransformResult>} */
        (
          transform(marker.source, {
            define: {
              ULTRAMODERN_BUILD_MARKER: buildMarker,
              ULTRAMODERN_SOURCE_REVISION: sourceRevision,
            },
            loader: 'ts',
            sourcefile: markerPath,
            target: 'node26',
          })
        ),
    });
    compiledMarkers.add(markerPath);
    /** @type {import('esbuild').OnLoadResult} */
    const loaded = { contents: result.code, loader: 'js', resolveDir: path.dirname(markerPath) };
    return loaded;
  });

/**
 * Compile each owner's generated marker at its original source path. A combined worker cannot use
 * global esbuild defines because its owners have different delivery-unit release identities.
 * @param {{
 *   compiledMarkers: Set<string>,
 *   markers: Map<string, { identity: Schema.Schema.Type<typeof OwnerBuildIdentitySchema>, source: string }>,
 *   path: import('effect/Path').Path,
 * }} context Owner-local sources and resolved release identities.
 * @returns {import('esbuild').Plugin} Owner-local build constant injection.
 */
const makeOwnerBuildIdentityPlugin = ({ compiledMarkers, markers, path }) => ({
  name: 'worker-owner-build-identities',
  setup(builder) {
    builder.onLoad(
      { filter: esbuildFilter(/[/\\]shared[/\\]ultramodern-build\.ts$/u) },
      /** @returns {PromiseLike<import('esbuild').OnLoadResult> | null} Loaded owner source when selected. */
      (args) => {
        const marker = markers.get(args.path);
        return marker === undefined
          ? null
          : nodeRuntime.runPromise(compileOwnerBuildIdentityEffect(args.path, marker, path, compiledMarkers));
      },
    );
  },
});

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
    // Package specifiers only: relative paths and `#` package imports (a package's own
    // condition-mapped modules, such as Core's `#spicedb-transport`) resolve through esbuild.
    builder.onResolve({ filter: esbuildFilter(/^[^./#]/u) }, (args) => {
      if (isBuiltin(args.path)) {
        return { external: true, path: args.path };
      }
      const name = args.path.startsWith('@') ? args.path.split('/').slice(0, 2).join('/') : args.path.split('/').at(0);
      if (args.path === '@app/core-runtime') {
        return {
          path: path.join(workspaceRoot, CORE_WORKER_ENTRYPOINT),
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
      return yield* Effect.fail(failure(`Worker dependency ${name} must have one declared production version`));
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
 * @typedef {{
 *   appId: string,
 *   packageDir: string,
 *   packageName: string,
 *   workspaceRoot: string,
 * }} WorkerIdentity
 */

/**
 * The deployable worker an identity names: one topology owner's dedicated worker, or the Outbox Worker
 * host that runs every owner's entry. Its service id names the runtime directory and the artifact.
 * @param {WorkerIdentity} identity Materialization identity.
 */
const resolveOutboxWorkerEffect = ({ appId, packageDir, packageName, workspaceRoot }) =>
  Effect.gen(function* resolveWorker() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (appId === OUTBOX_WORKER_HOST.id) {
      const rootPackage = yield* Schema.decodeUnknownEffect(PackageManifestSchema)(
        yield* fs.readFileString(path.join(workspaceRoot, 'package.json')),
      );
      if (packageDir !== '.' || packageName !== rootPackage.name) {
        return yield* Effect.fail(failure('Worker identity must match the generated Outbox Worker host'));
      }
      const host = yield* readOutboxWorkerHost(workspaceRoot);
      if (host === undefined) {
        return yield* Effect.fail(failure('No MicroVertical has a generated Outbox Worker entry'));
      }
      const hostEntryPath = path.join(workspaceRoot, host.entry);
      const hostEntry = (yield* fs.exists(hostEntryPath)) ? yield* fs.readFileString(hostEntryPath) : null;
      if (hostEntry !== renderOutboxWorkerHostEntry(host)) {
        return yield* Effect.fail(
          failure('Outbox Worker host entry drift: run node scripts/generate-outbox-worker-deployment.mjs --write'),
        );
      }
      return { entryPoint: host.entry, owners: host.owners, serviceId: host.id };
    }
    const topologySource = yield* fs.readFileString(path.join(workspaceRoot, TOPOLOGY_PATH));
    const topology = yield* Schema.decodeUnknownEffect(TopologySchema)(topologySource);
    const vertical = topology.verticals.find((candidate) => candidate.id === appId);
    if (vertical === undefined || vertical.package !== packageName || vertical.path !== packageDir) {
      return yield* Effect.fail(failure('Worker identity must match its topology owner'));
    }
    const delivery = yield* outboxWorkerDelivery(workspaceRoot, vertical).pipe(
      Effect.mapError(() => failure(`Invalid generated worker delivery for ${appId}`)),
    );
    if (delivery === undefined) {
      return yield* Effect.fail(failure(`${appId} has no generated Outbox Worker host`));
    }
    return { entryPoint: path.join(packageDir, delivery.entry), owners: [delivery], serviceId: delivery.id };
  });

/**
 * @param {WorkerIdentity} identity Materialization identity.
 * @returns {PromiseLike<{ entryPoint: string, owners: readonly import('./outbox-worker-delivery.mjs').OutboxWorkerDelivery[], serviceId: string }>} The worker's bundle entry, hosted owners, and service id.
 */
export const resolveOutboxWorker = (identity) => nodeRuntime.runPromise(resolveOutboxWorkerEffect(identity));

/**
 * Bundle owner + Core code; retain exact production dependencies, never workspace links.
 * @param {MaterializeOptions} options Materialization identity and paths.
 */
const materializeOutboxWorkerEffect = ({ appId, packageDir, packageName, runtimeDir, workspaceRoot }) =>
  Effect.gen(function* materializeWorker() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const delivery = yield* resolveOutboxWorkerEffect({ appId, packageDir, packageName, workspaceRoot });
    const topology = yield* Schema.decodeUnknownEffect(TopologySchema)(
      yield* fs.readFileString(path.join(workspaceRoot, TOPOLOGY_PATH)),
    );
    const sourceRevision = yield* Effect.try({
      catch: () => failure('Unable to resolve the Outbox Worker source revision'),
      try: () => resolveUltramodernSourceRevision(workspaceRoot),
    });
    /** @type {Map<string, { identity: Schema.Schema.Type<typeof OwnerBuildIdentitySchema>, source: string }>} */
    const markers = new Map();
    for (const owner of delivery.owners) {
      const vertical = topology.verticals.find((candidate) => candidate.id === owner.ownerId);
      const declared = vertical?.deliveryUnit;
      const declaredMarkerPath = path.resolve(workspaceRoot, owner.path, 'shared/ultramodern-build.ts');
      if (!(yield* fs.exists(declaredMarkerPath))) {
        if (declared === undefined) {
          continue;
        }
        return yield* Effect.fail(failure(`Missing owner build identity source for ${owner.ownerId}`));
      }
      const markerPath = yield* fs.realPath(declaredMarkerPath);
      if (
        declared === undefined ||
        declared.packageName !== owner.packageName ||
        declared.buildMarker.length === 0 ||
        declared.unitId.length === 0
      ) {
        return yield* Effect.fail(failure(`Missing delivery-unit build identity for ${owner.ownerId}`));
      }
      const releaseIdentity = yield* Effect.try({
        catch: () => failure(`Unable to resolve the ${owner.ownerId} Outbox Worker release identity`),
        try: () =>
          resolveUltramodernReleaseIdentity({
            generationBuildMarker: declared.buildMarker,
            sourceRevision: declared.sourceRevision,
            unitId: declared.unitId,
            workspaceRoot,
          }),
      });
      markers.set(markerPath, {
        identity: {
          appId: yield* Schema.decodeUnknownEffect(AppIdSchema)(owner.ownerId),
          ...releaseIdentity,
          unitId: declared.unitId,
        },
        source: yield* fs.readFileString(markerPath),
      });
    }
    const ownerSourceRevisions = [...new Set([...markers.values()].map(({ identity }) => identity.sourceRevision))];
    if (ownerSourceRevisions.length > 1) {
      return yield* Effect.fail(failure('The Outbox Worker owner identities do not share one source revision'));
    }
    const artifactSourceRevision = ownerSourceRevisions[0] ?? sourceRevision;
    /** @type {Set<string>} */
    const compiledMarkers = new Set();
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
            entryPoints: [delivery.entryPoint],
            format: 'esm',
            metafile: true,
            outfile: path.join(runtimeDir, WORKER_ENTRY),
            platform: 'node',
            plugins: [
              makeOwnerBuildIdentityPlugin({ compiledMarkers, markers, path }),
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
    const missingMarkers = [...markers.entries()]
      .filter(([markerPath]) => !compiledMarkers.has(markerPath))
      .map(([, marker]) => marker.identity.appId);
    if (missingMarkers.length > 0) {
      return yield* Effect.fail(
        failure(`The Outbox Worker does not import its owner build identity: ${missingMarkers.join(', ')}`),
      );
    }
    const { metafile } = result;
    // esbuild rejects a missing named import from the focused Core entrypoint, but a TypeScript re-export of a
    // missing name may be a type, so it bundles as undefined and the worker crashes at start. Reject it here.
    const coreReExports = [];
    for (const input of Object.keys(metafile.inputs)) {
      if (input.startsWith('verticals/') && /\.(?:ts|tsx|mts)$/u.test(input)) {
        const source = yield* fs.readFileString(path.join(workspaceRoot, input));
        coreReExports.push(...coreRuntimeValueReExports(input, source).map((name) => ({ input, name })));
      }
    }
    const entrypointExports =
      coreReExports.length === 0
        ? new Set()
        : focusedEntrypointValueExports(yield* fs.readFileString(path.join(workspaceRoot, CORE_WORKER_ENTRYPOINT)));
    const missingReExports = coreReExports
      .filter(({ name }) => !entrypointExports.has(name))
      .map(({ input, name }) => `${input} re-exports ${name}`);
    if (missingReExports.length > 0) {
      return yield* Effect.fail(
        failure(`The Outbox Worker Core entrypoint does not export: ${missingReExports.join('; ')}`),
      );
    }
    const externalImports = Object.values(metafile.outputs).flatMap((output) =>
      output.imports.filter((item) => item.external === true),
    );
    for (const imported of externalImports) {
      yield* collectProductionDependency(imported.path, packages, dependencies);
    }
    yield* fs.copyFile(path.join(workspaceRoot, TOPOLOGY_PATH), path.join(runtimeDir, 'topology.json'));
    const artifactAppId = yield* Schema.decodeUnknownEffect(AppIdSchema)(appId);
    const artifactServiceId = yield* Schema.decodeUnknownEffect(ServiceIdSchema)(delivery.serviceId);
    const { inputs: sourceInputMetadata } = yield* Schema.decodeUnknownEffect(MetafileInputsSchema)(metafile);
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
      ownerBuildIdentities: [...markers.values()].map(({ identity }) => identity),
      schemaVersion: 2,
      serviceId: artifactServiceId,
      sourceInputs,
      sourceRevision: Option.some(artifactSourceRevision),
    });
    yield* fs.writeFileString(path.join(runtimeDir, 'worker-artifact.json'), `${artifactSource}\n`);
    return {
      dependencies,
      name: `${delivery.serviceId}-runtime`,
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
export const materializeOutboxWorker = (options) => nodeRuntime.runPromise(materializeOutboxWorkerEffect(options));
