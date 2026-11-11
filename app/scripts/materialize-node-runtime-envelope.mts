import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { resolveUltramodernSourceRevision } from '@modern-js/app-tools-extensions/release-identity';
import type { MicroVerticalReleaseIdentity } from '@modern-js/app-tools-extensions/release-envelope';
import {
  emitNodeStagedReleaseEnvelope,
  verifyBuildOutputReleaseEnvelope,
  verifyNodeReleaseEnvelopeStaging,
} from '@modern-js/app-tools-extensions/release-envelope/framework-output';
import { Array as EffectArray, Effect, FileSystem, Option, Order, Path, Schema } from 'effect';
import { parseSync, Visitor } from 'oxc-parser';
import type { Program, VariableDeclarator } from 'oxc-parser';

export class NodeRuntimeEnvelopeError extends Schema.TaggedError<NodeRuntimeEnvelopeError>()(
  'NodeRuntimeEnvelopeError',
  {
    cause: Schema.optionalKey(Schema.Unknown),
    reason: Schema.String,
  },
) {}

const METADATA_PACKAGE = '@bleedingdev/modern-js-ultramodern-app-tools';
const PUBLIC_METADATA = `${METADATA_PACKAGE}/react-build-metadata-server`;
const SOURCE_METADATA = '@modern-js/ultramodern-app-tools/react-build-metadata-server';
const ENVELOPE = 'release/microvertical-release-envelope.json';
const PACKAGE_JSON = 'package.json';
const UnitSchema = Schema.Struct({ id: Schema.String, package: Schema.String, path: Schema.String });
const TopologySchema = Schema.fromJsonString(Schema.Struct({ shell: UnitSchema, verticals: Schema.Array(UnitSchema) }));
const PackageSchema = Schema.fromJsonString(Schema.Struct({ name: Schema.String, version: Schema.String }));
const PackageScopeSchema = Schema.fromJsonString(
  Schema.Struct({ name: Schema.optionalKey(Schema.String), version: Schema.optionalKey(Schema.String) }),
);
const StagedPackageSchema = Schema.fromJsonString(
  Schema.Struct({ dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)) }),
);
type Unit = typeof UnitSchema.Type;
interface Target {
  readonly output: string;
  readonly owner: Unit;
  readonly source: string;
}
interface VerifiedTarget extends Target {
  readonly declaredPublicAssets: readonly string[];
}
interface BootstrapBinding {
  readonly end: number;
  readonly start: number;
  readonly value: string;
  readonly variable: string | undefined;
}
interface Replacement {
  readonly end: number;
  readonly start: number;
  readonly value: string;
}
export interface NodeRuntimeEnvelopeInput {
  readonly packageDir: string;
  readonly packageName: string;
  readonly runtimeDir: string;
  readonly sourceRevision?: string;
  readonly workspaceRoot: string;
}
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const failure = (reason: string, cause?: unknown) => new NodeRuntimeEnvelopeError({ cause, reason });
const attempt = <Value,>(reason: string, operation: () => Value) =>
  Effect.try({ catch: (cause) => failure(reason, cause), try: operation });
const infoAt = (filename: string) =>
  Effect.gen(function* optionalMetadata() {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.lstat(filename).pipe(
      Effect.map(Option.some),
      Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(Option.none())),
    );
  });
const requireRegular = (filename: string) =>
  Effect.gen(function* requireRegularMetadata() {
    const info = yield* infoAt(filename);
    if (Option.isNone(info) || info.value.type !== 'File') {
      yield* Effect.fail(failure('Node materialization requires regular build metadata and bootstrap files'));
    }
  });
const isInside = (root: string, candidate: string, path: Path.Path): boolean => {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const contained = (root: string, candidate: string) =>
  Effect.gen(function* requireContainedPath() {
    const path = yield* Path.Path;
    if (!isInside(root, candidate, path)) {
      yield* Effect.fail(failure('Node materialization path escapes its declared root'));
    }
  });
const metadataPackage = (filename: string) =>
  Effect.gen(function* readMetadataPackage() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let directory = path.dirname(filename);
    while (path.dirname(directory) !== directory) {
      const manifest = path.join(directory, PACKAGE_JSON);
      const info = yield* infoAt(manifest);
      if (Option.isSome(info)) {
        yield* requireRegular(manifest);
        const scope = yield* fs
          .readFileString(manifest)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PackageScopeSchema)));
        if (scope.name !== undefined) {
          if (scope.name !== METADATA_PACKAGE || scope.version === undefined) {
            return yield* Effect.fail(failure('Renderer metadata export belongs to an unexpected package'));
          }
          return { name: scope.name, version: scope.version };
        }
      }
      directory = path.dirname(directory);
    }
    return yield* Effect.fail(failure('Published renderer metadata export has no owning package'));
  });
const bindingOf = (declaration: VariableDeclarator, path: Path.Path): BootstrapBinding | undefined => {
  const call = declaration.init;
  if (
    call?.type !== 'CallExpression' ||
    call.callee.type !== 'Identifier' ||
    call.callee.name !== 'require' ||
    call.arguments.length !== 1
  ) {
    return undefined;
  }
  const [argument] = call.arguments;
  if (argument.type !== 'Literal' || !Schema.is(Schema.String)(argument.value) || !path.isAbsolute(argument.value)) {
    return undefined;
  }
  return {
    end: argument.end,
    start: argument.start,
    value: argument.value,
    variable: declaration.id.type === 'Identifier' ? declaration.id.name : undefined,
  };
};
const absoluteBindings = (program: Program, path: Path.Path): readonly BootstrapBinding[] =>
  program.body.flatMap((statement) => {
    if (statement.type !== 'VariableDeclaration') {
      return [];
    }
    return statement.declarations.flatMap((declaration) => {
      const binding = bindingOf(declaration, path);
      return binding === undefined ? [] : [binding];
    });
  });
const unsupportedBindings = (program: Program, bindings: readonly BootstrapBinding[], path: Path.Path): boolean => {
  const approved = new Set(bindings.map((binding) => binding.start));
  let unsupported = false;
  new Visitor({
    CallExpression(node) {
      if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') {
        return;
      }
      for (const argument of node.arguments) {
        if (
          argument.type === 'Literal' &&
          Schema.is(Schema.String)(argument.value) &&
          path.isAbsolute(argument.value) &&
          !approved.has(argument.start)
        ) {
          unsupported = true;
        }
      }
    },
    ImportDeclaration() {
      unsupported = true;
    },
    ImportExpression(node) {
      if (
        node.source.type === 'Literal' &&
        Schema.is(Schema.String)(node.source.value) &&
        path.isAbsolute(node.source.value)
      ) {
        unsupported = true;
      }
    },
  }).visit(program);
  return unsupported;
};
const replacementFor = (binding: BootstrapBinding, target: Target, runtimeRoot: string) =>
  Effect.gen(function* validatePublishedMetadataReplacement() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sourceRequire = createRequire(path.join(target.source, PACKAGE_JSON));
    const sourceModule = yield* attempt('Published renderer metadata export cannot be resolved', () =>
      sourceRequire.resolve(SOURCE_METADATA),
    );
    const expected = yield* fs.realPath(sourceModule);
    if (binding.variable === undefined || !/^plugin_\d+_ns$/u.test(binding.variable) || binding.value !== expected) {
      return yield* Effect.fail(failure('Unexpected absolute Node bootstrap binding; refusing generic path rewriting'));
    }
    const runtimeRequire = createRequire(path.join(target.output, PACKAGE_JSON));
    const installed = yield* attempt('Staged renderer metadata public dependency is missing', () =>
      runtimeRequire.resolve(PUBLIC_METADATA),
    );
    const installedReal = yield* fs.realPath(installed);
    yield* contained(runtimeRoot, installedReal);
    const [sourcePackage, installedPackage, sourceBytes, installedBytes] = yield* Effect.all([
      metadataPackage(expected),
      metadataPackage(installedReal),
      fs.readFile(expected),
      fs.readFile(installedReal),
    ]);
    const stagedPackage = yield* fs
      .readFileString(path.join(target.output, PACKAGE_JSON))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(StagedPackageSchema)));
    if (
      sourcePackage.name !== METADATA_PACKAGE ||
      installedPackage.name !== sourcePackage.name ||
      installedPackage.version !== sourcePackage.version ||
      stagedPackage.dependencies?.[sourcePackage.name] !== sourcePackage.version ||
      digest(sourceBytes) !== digest(installedBytes)
    ) {
      return yield* Effect.fail(
        failure('Staged renderer metadata implementation differs from the published build dependency'),
      );
    }
    return {
      end: binding.end,
      start: binding.start,
      value: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(PUBLIC_METADATA),
    };
  });
/** Deliberately supports the generated CommonJS bootstrap, rejecting other module-binding shapes. */
const normalizeBootstrap = (target: Target, runtimeRoot: string) =>
  Effect.gen(function* normalizePublishedMetadataBinding() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filename = path.join(target.output, 'index.js');
    yield* requireRegular(filename);
    const source = yield* fs.readFileString(filename);
    const parsed = yield* attempt('Node bootstrap cannot be parsed', () => parseSync(filename, source));
    if (parsed.errors.length > 0) {
      yield* Effect.fail(failure('Node bootstrap contains parser errors'));
    }
    const bindings = absoluteBindings(parsed.program, path);
    if (unsupportedBindings(parsed.program, bindings, path)) {
      yield* Effect.fail(failure('Unsupported Node bootstrap module binding'));
    }
    const replacements: Replacement[] = [];
    for (const binding of bindings) {
      replacements.push(yield* replacementFor(binding, target, runtimeRoot));
    }
    let normalized = source;
    for (const replacement of EffectArray.sort(
      replacements,
      Order.mapInput(Order.Number, (item: Replacement) => -item.start),
    )) {
      normalized = normalized.slice(0, replacement.start) + replacement.value + normalized.slice(replacement.end);
    }
    if (normalized !== source) {
      yield* fs.writeFileString(filename, normalized);
    }
  });
const discoverTargets = (owners: readonly Unit[], owner: Unit, workspace: string, runtime: string) =>
  Effect.gen(function* discoverCopiedNodeOutputs() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const targets: Target[] = [{ output: runtime, owner, source: path.resolve(workspace, owner.path) }];
    const sourceRoots: string[] = [];
    for (const unit of owners) {
      const source = path.resolve(workspace, unit.path);
      if (Option.isSome(yield* infoAt(source))) {
        const real = yield* fs.realPath(source);
        yield* contained(workspace, real);
        sourceRoots.push(real);
      }
      const copied = path.join(runtime, 'node_modules', unit.package);
      const output = path.join(copied, '.output');
      const info = yield* infoAt(output);
      if (Option.isNone(info)) {
        continue;
      }
      if (info.value.type !== 'Directory') {
        return yield* Effect.fail(failure('Copied Node output must be a real directory'));
      }
      const copiedPackage = yield* fs
        .readFileString(path.join(copied, PACKAGE_JSON))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PackageSchema)));
      if (copiedPackage.name !== unit.package) {
        return yield* Effect.fail(failure('Copied workspace package identity differs from topology'));
      }
      targets.push({ output, owner: unit, source });
    }
    for (const target of targets) {
      yield* contained(workspace, target.source);
      const realOutput = yield* fs.realPath(target.output);
      yield* contained(runtime, realOutput);
      if (sourceRoots.some((source) => isInside(source, realOutput, path) || isInside(realOutput, source, path))) {
        return yield* Effect.fail(failure('Original source/build trees cannot overlap mutable staging'));
      }
    }
    return targets;
  });
const sameIdentity = (left: MicroVerticalReleaseIdentity, right: MicroVerticalReleaseIdentity): boolean =>
  left.unitId === right.unitId &&
  left.buildMarker === right.buildMarker &&
  left.sourceRevision === right.sourceRevision &&
  left.releaseVersion === right.releaseVersion;
const validateOriginal = (target: Target, revision: string) =>
  Effect.gen(function* verifyUnmodifiedOriginalBuild() {
    const path = yield* Path.Path;
    for (const directory of ['dist', '.output']) {
      yield* requireRegular(path.join(target.source, directory, ENVELOPE));
    }
    const build = yield* Effect.tryPromise({
      catch: (cause) => failure('Original Node build envelope verification failed', cause),
      try: async () => await verifyBuildOutputReleaseEnvelope(path.join(target.source, 'dist'), 'node'),
    });
    const raw = yield* Effect.tryPromise({
      catch: (cause) => failure('Original raw Node output envelope verification failed', cause),
      try: async () => await verifyNodeReleaseEnvelopeStaging({ outputDirectory: path.join(target.source, '.output') }),
    });
    if (
      build === undefined ||
      raw === undefined ||
      build.identity.sourceRevision !== revision ||
      raw.identity.sourceRevision !== revision ||
      build.identity.unitId !== `app/${target.owner.id}` ||
      !sameIdentity(build.identity, raw.identity)
    ) {
      return yield* Effect.fail(failure('Original Node output does not match the current producer identity'));
    }
    return {
      ...target,
      declaredPublicAssets: raw.artifacts
        .filter((artifact) => artifact.runtime === 'public-asset')
        .map((artifact) => artifact.logicalPath),
    };
  });
const sealTarget = (target: VerifiedTarget, runtime: string, revision: string) =>
  Effect.gen(function* publiclySealFinalTarget() {
    const path = yield* Path.Path;
    yield* normalizeBootstrap(target, runtime);
    const staged = yield* Effect.tryPromise({
      catch: (cause) => failure('Public Node staged envelope production failed', cause),
      try: async () =>
        await emitNodeStagedReleaseEnvelope({
          declaredPublicAssets: target.declaredPublicAssets,
          distDirectory: path.join(target.source, 'dist'),
          outputDirectory: target.output,
        }),
    });
    if (staged === undefined || staged.identity.sourceRevision !== revision) {
      yield* Effect.fail(failure('Public Node staged envelope production omitted current identity'));
    }
    yield* Effect.tryPromise({
      catch: (cause) => failure('Public Node staged envelope verification failed', cause),
      try: async () => await verifyNodeReleaseEnvelopeStaging({ outputDirectory: target.output }),
    });
  });
/** Call after all installation/rebuild and final provider staging mutations; originals stay read-only. */
export const normalizeAndSealNodeRuntime = (input: NodeRuntimeEnvelopeInput) =>
  Effect.gen(function* normalizeAndSealFinalNodeRuntime() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspace = yield* fs.realPath(input.workspaceRoot);
    const runtime = yield* fs.realPath(input.runtimeDir);
    const topology = yield* fs
      .readFileString(path.join(workspace, 'topology/reference-topology.json'))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(TopologySchema)));
    const owners = [topology.shell, ...topology.verticals];
    const owner = owners.find((unit) => unit.package === input.packageName && unit.path === input.packageDir);
    if (owner === undefined) {
      return yield* Effect.fail(failure('Node materialization identity does not match topology'));
    }
    const revision =
      input.sourceRevision ??
      (yield* attempt('Actual producer source revision is unavailable', () =>
        resolveUltramodernSourceRevision(workspace),
      ));
    if (!/^[0-9a-f]{40}$/u.test(revision)) {
      yield* Effect.fail(failure('A concrete actual producer source revision is required'));
    }
    const targets = yield* discoverTargets(owners, owner, workspace, runtime);
    const verified: VerifiedTarget[] = [];
    for (const target of targets) {
      verified.push(yield* validateOriginal(target, revision));
    }
    for (const target of EffectArray.sort(
      verified,
      Order.mapInput(Order.Number, (item: VerifiedTarget) => -item.output.length),
    )) {
      yield* sealTarget(target, runtime, revision);
    }
    return yield* Effect.void;
  }).pipe(
    Effect.mapError((cause) =>
      Schema.is(NodeRuntimeEnvelopeError)(cause)
        ? cause
        : failure('Node runtime normalization or sealing failed', cause),
    ),
  );
