import { isBuiltin } from 'node:module';

import { NodeServices } from '@effect/platform-node';
import { Config, Effect, FileSystem, ManagedRuntime, Path, Schema } from 'effect';
import { build } from 'esbuild';
import { parseSync } from 'oxc-parser';

import { readOutboxWorkerHost, renderOutboxWorkerHostEntry } from './generate-outbox-worker-deployment.mjs';
import { OUTBOX_WORKER_HOST, outboxWorkerDelivery } from './outbox-worker-delivery.mjs';

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
      return { entryPoint: host.entry, serviceId: host.id };
    }
    const topologySource = yield* fs.readFileString(path.join(workspaceRoot, 'topology/reference-topology.json'));
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
    return { entryPoint: path.join(packageDir, delivery.entry), serviceId: delivery.id };
  });

/**
 * @param {WorkerIdentity} identity Materialization identity.
 * @returns {PromiseLike<{ entryPoint: string, serviceId: string }>} The worker's bundle entry and service id.
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
    yield* fs.copyFile(
      path.join(workspaceRoot, 'topology/reference-topology.json'),
      path.join(runtimeDir, 'topology.json'),
    );
    const sourceRevision = yield* Config.option(Config.String('ULTRAMODERN_SOURCE_REVISION'));
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
      schemaVersion: 1,
      serviceId: artifactServiceId,
      sourceInputs,
      sourceRevision,
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
