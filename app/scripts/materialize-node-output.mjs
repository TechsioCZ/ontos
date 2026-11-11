import { Effect, FileSystem, Option, Path, Schema } from 'effect';

export class NodeOutputMaterializationError extends Schema.TaggedError()('NodeOutputMaterializationError', {
  message: Schema.String,
}) {}

/** @param {string} message Invalid staging boundary. */
const failure = (message) => new NodeOutputMaterializationError({ message });
const PACKAGE_JSON = 'package.json';
const AppIdSchema = Schema.String.pipe(Schema.brand('AppId'));
const SourcePackageSchema = Schema.fromJsonString(
  Schema.Struct({ modernjs: Schema.Struct({ appId: AppIdSchema }), name: Schema.String }),
);
const JsonObjectSchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown), { space: 2 });
const OutputPackageSchema = Schema.Struct({
  scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

/** @param {string} target Optional staging ancestor or required output entry. */
const optionalInfo = (target) =>
  Effect.gen(function* inspectPath() {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.lstat(target).pipe(
      Effect.map(Option.some),
      Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(Option.none())),
    );
  });

/** @param {string} target Required regular metadata or executable entry. */
const requireRegularFile = (target) =>
  Effect.gen(function* requireFile() {
    const info = yield* optionalInfo(target);
    if (Option.isNone(info) || info.value.type !== 'File') {
      yield* Effect.fail(failure('Node staging metadata and index.js must be regular files'));
    }
  });

/** @param {string} workspace Canonical workspace. @param {string} target Guarded staging path. */
const rejectSymlinkAncestors = (workspace, target) =>
  Effect.gen(function* rejectSymlinks() {
    const path = yield* Path.Path;
    let ancestor = target;
    while (ancestor !== workspace) {
      const info = yield* optionalInfo(ancestor);
      if (Option.isSome(info) && info.value.type === 'SymbolicLink') {
        yield* Effect.fail(failure('Package, output and runtime paths must not contain symlinks'));
      }
      ancestor = path.dirname(ancestor);
    }
  });

/**
 * Stages the normal Node build's output for the published runtime finalizer. The provider build has
 * already run Modern's real deploy step; no package-level deploy script exists in this cohort.
 * @param {{workspaceRoot: string, appId: string, packageDir: string, packageName: string}} options Normal materializer identity.
 */
export const stageNodeOutput = ({ appId, packageDir, packageName, workspaceRoot }) =>
  Effect.gen(function* stageBuiltNodeOutput() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(appId) ||
      !packageDir ||
      path.isAbsolute(packageDir) ||
      packageDir.split(/[\\/]/u).includes('..')
    ) {
      return yield* Effect.fail(failure('App and package directory must be workspace-relative identifiers'));
    }
    const workspace = yield* fs.realPath(workspaceRoot);
    const packageRoot = path.resolve(workspace, packageDir);
    const relative = path.relative(workspace, packageRoot);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return yield* Effect.fail(failure('Package directory must be inside the workspace'));
    }
    const output = path.join(packageRoot, '.output');
    const relativeRuntime = `.zerops/runtime/${appId}`;
    const runtime = path.join(workspace, relativeRuntime);
    for (const target of [packageRoot, output, runtime]) {
      yield* rejectSymlinkAncestors(workspace, target);
    }
    yield* requireRegularFile(path.join(packageRoot, PACKAGE_JSON));
    const source = yield* fs
      .readFileString(path.join(packageRoot, PACKAGE_JSON))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(SourcePackageSchema)));
    if (source.name !== packageName || source.modernjs.appId !== appId) {
      return yield* Effect.fail(failure('Requested app and package must match source package metadata'));
    }
    const outputInfo = yield* optionalInfo(output);
    if (Option.isNone(outputInfo) || outputInfo.value.type !== 'Directory') {
      return yield* Effect.fail(failure('Normal Modern.js Node build output is required before materialization'));
    }
    for (const entry of [PACKAGE_JSON, 'index.js']) {
      yield* requireRegularFile(path.join(output, entry));
    }
    const outputPackage = yield* fs
      .readFileString(path.join(output, PACKAGE_JSON))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(JsonObjectSchema)));
    const declared = yield* Schema.decodeUnknownEffect(OutputPackageSchema)(outputPackage);
    if (declared.scripts?.serve !== undefined && !declared.scripts.serve.trim()) {
      return yield* Effect.fail(failure('An existing runtime serve script must not be empty'));
    }
    // Match the published default materializer. Raw output intentionally has no serve script.
    const stagedPackage = {
      ...outputPackage,
      scripts: { ...declared.scripts, serve: declared.scripts?.serve ?? 'node index.js' },
    };
    const encodedPackage = yield* Schema.encodeEffect(JsonObjectSchema)(stagedPackage);
    yield* fs.remove(runtime, { force: true, recursive: true });
    yield* fs.makeDirectory(path.dirname(runtime), { recursive: true });
    yield* fs.copy(output, runtime, { overwrite: true, preserveTimestamps: true });
    yield* fs.writeFileString(path.join(runtime, PACKAGE_JSON), `${encodedPackage}\n`);
    return relativeRuntime;
  });
