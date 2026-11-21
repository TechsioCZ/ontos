import posixPath from 'node:path/posix';

import { NodeServices } from '@effect/platform-node';
import {
  Array as EffectArray,
  Cause,
  Console,
  Effect,
  Exit,
  FileSystem,
  ManagedRuntime,
  Option,
  Order,
  Path,
  Predicate,
  Schema,
  Stream,
} from 'effect';
import { systemError } from 'effect/PlatformError';
import type { PlatformError } from 'effect/PlatformError';
import { Command, Flag } from 'effect/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { parseSync, Visitor } from 'oxc-parser';
import type { Argument, Expression, ImportExpression, MemberExpression } from 'oxc-parser';

/**
 * Lean-Core gate: `packages/core-runtime` must never depend on Commerce,
 * Storefront or Better Auth (package.json or source import). Non-Commerce
 * apps/verticals must never take a mandatory runtime import of Commerce's
 * private implementation, only its published `shared/` contracts or a
 * documented composition seam. Package edges from a module (verticals/*) or a package (packages/*) to a
 * module or an app (apps/*) are frozen to the committed baseline, which may only shrink.
 */

export interface LeanCoreDependencyViolation {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
}

const sourceExtensions = new Set(['.ts', '.tsx', '.mts']);
const graphSourceExtensions = new Set([...sourceExtensions, '.js', '.mjs', '.cjs']);
const ignoredDirectories = new Set(['dist', 'dist-cloudflare', 'node_modules', 'repos', '.output', '.codex']);
const isTestSource = (relative: string): boolean => /(?:^|\/)(?:tests?|__tests__)\//u.test(relative);

const collectFiles = (
  directory: string,
): Effect.Effect<readonly string[], PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* collectFilesProgram() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fileSystem.readDirectory(directory);
    const discovered = yield* Effect.all(
      entries.map((entry) => {
        const candidate = path.join(directory, entry);
        return fileSystem
          .stat(candidate)
          .pipe(
            Effect.flatMap((info) =>
              info.type === 'Directory' ? collectFiles(candidate) : Effect.succeed<readonly string[]>([candidate]),
            ),
          );
      }),
      { concurrency: 32 },
    );
    return discovered.flat();
  });

/** The platform services a check reads the tree and Git with. */
type CheckServices = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path;

/** Lists the files a check reads under root: paths relative to root, with POSIX separators. */
export type SourceFileListing = (root: string) => Effect.Effect<readonly string[], PlatformError, CheckServices>;

/** Every file on disk under root: a fixture tree, or a commit's tree extracted from Git. */
export const filesOnDisk: SourceFileListing = (root) =>
  Effect.gen(function* filesOnDiskProgram() {
    const path = yield* Path.Path;
    const files = yield* collectFiles(root);
    return files.map((file) => path.relative(root, file).split(path.sep).join('/'));
  });

/**
 * The files Git tracks under root, staged ones included: exactly the commit under judgment. Files another
 * step creates and removes beside the check (module contract generation bundles each vertical in a
 * temporary directory inside it) are not part of that commit, so they are never listed or read.
 */
export const trackedFiles: SourceFileListing = (root) =>
  Effect.scoped(
    Effect.gen(function* trackedFilesProgram() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make('git', ['ls-files', '-z'], { cwd: root, stderr: 'inherit', stdin: 'ignore' }),
      );
      const [listed, exitCode] = yield* Effect.all(
        [Stream.mkString(handle.stdout.pipe(Stream.decodeText())), handle.exitCode],
        { concurrency: 2 },
      );
      if (exitCode !== 0) {
        return yield* Effect.fail(
          systemError({
            _tag: 'Unknown',
            description: `git ls-files exited with ${exitCode}, so the files of the commit under judgment are unknown`,
            method: 'ls-files',
            module: 'git',
            pathOrDescriptor: root,
          }),
        );
      }
      return listed.split('\0').filter((file) => file.length > 0);
    }),
  );

/** The listed files under `directory` (relative to root) with one of `extensions`, outside build output. */
const listedSources = (
  listed: readonly string[],
  directory: string,
  extensions: ReadonlySet<string>,
): readonly string[] =>
  EffectArray.sort(
    listed.filter(
      (file) =>
        (directory === '' || file.startsWith(`${directory}/`)) &&
        extensions.has(posixPath.extname(file)) &&
        !file
          .split('/')
          .slice(0, -1)
          .some((segment) => ignoredDirectories.has(segment)),
    ),
    Order.String,
  );

const sourceLine = (source: string, index: number): number => source.slice(0, index).split('\n').length;

interface ImportOccurrence {
  readonly index: number;
  readonly isTypeOnly: boolean;
  readonly specifier: string;
}

interface SourceImportAnalysis {
  readonly occurrences: readonly ImportOccurrence[];
  readonly unsupportedRuntimeImport: boolean;
}

type ProgramStatement = ReturnType<typeof parseSync>['program']['body'][number];

const occurrenceForStatement = (statement: ProgramStatement): ImportOccurrence | undefined => {
  if (statement.type === 'ImportDeclaration') {
    return {
      index: statement.start,
      isTypeOnly: statement.importKind === 'type',
      specifier: statement.source.value,
    };
  }
  if (statement.type === 'ExportNamedDeclaration' && statement.source !== null) {
    return {
      index: statement.start,
      isTypeOnly: statement.exportKind === 'type',
      specifier: statement.source.value,
    };
  }
  if (statement.type === 'ExportAllDeclaration') {
    return {
      index: statement.start,
      isTypeOnly: statement.exportKind === 'type',
      specifier: statement.source.value,
    };
  }
  return undefined;
};

const staticMemberName = (node: MemberExpression): string | undefined => {
  if (!node.computed && node.property.type === 'Identifier') {
    return node.property.name;
  }
  if (node.property.type === 'Literal' && Predicate.isString(node.property.value)) {
    return node.property.value;
  }
  if (node.property.type === 'TemplateLiteral' && node.property.expressions.length === 0) {
    return node.property.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
};

/** All specifier-bearing import/export forms, including multi-line and dynamic `import(...)`. */
const analyzeImports = (file: string, source: string): SourceImportAnalysis => {
  const typedLanguage = file.endsWith('.tsx') ? 'tsx' : 'ts';
  const parsed = parseSync(file, source, {
    astType: 'ts',
    lang: sourceExtensions.has(posixPath.extname(file)) ? typedLanguage : 'js',
    sourceType: file.endsWith('.cjs') ? 'script' : 'module',
  });
  if (parsed.errors.length > 0) {
    return { occurrences: [], unsupportedRuntimeImport: true };
  }
  const occurrences = parsed.program.body.flatMap((statement) => {
    const occurrence = occurrenceForStatement(statement);
    return occurrence === undefined ? [] : [occurrence];
  });
  const dynamicOccurrences: ImportOccurrence[] = [];
  let unsupportedRuntimeImport = parsed.program.body.some(
    (statement) => statement.type === 'TSImportEqualsDeclaration' && statement.importKind !== 'type',
  );
  const recordDynamicImportExpression = (node: ImportExpression): void => {
    if (node.source.type === 'Literal' && Predicate.isString(node.source.value)) {
      dynamicOccurrences.push({ index: node.start, isTypeOnly: false, specifier: node.source.value });
    } else if (node.source.type === 'TemplateLiteral' && node.source.expressions.length === 0) {
      const specifier = node.source.quasis[0]?.value.cooked;
      if (specifier !== undefined && specifier !== null) {
        dynamicOccurrences.push({ index: node.start, isTypeOnly: false, specifier });
      } else {
        unsupportedRuntimeImport = true;
      }
    } else {
      unsupportedRuntimeImport = true;
    }
  };
  new Visitor({
    CallExpression: (node) => {
      if (node.callee.type !== 'MemberExpression' || staticMemberName(node.callee) !== 'getBuiltinModule') {
        return;
      }
      const [target] = node.arguments;
      const nativeModule = target?.type === 'Literal' ? target.value : undefined;
      if (nativeModule === undefined || nativeModule === 'module' || nativeModule === 'node:module') {
        unsupportedRuntimeImport = true;
      }
    },
    Identifier: (node) => {
      if (node.name === 'require' || node.name === 'createRequire') {
        unsupportedRuntimeImport = true;
      }
    },
    ImportExpression: recordDynamicImportExpression,
    MemberExpression: (node) => {
      const name = staticMemberName(node);
      if (
        name === 'require' ||
        name === 'createRequire' ||
        (node.computed && node.object.type === 'Identifier' && node.object.name === 'module')
      ) {
        unsupportedRuntimeImport = true;
      }
    },
  }).visit(parsed.program);
  unsupportedRuntimeImport ||= occurrences.some(
    ({ specifier }) => specifier === 'module' || specifier === 'node:module',
  );
  return {
    occurrences: EffectArray.sort(
      [...occurrences, ...dynamicOccurrences],
      Order.mapInput(Order.Number, (occurrence: ImportOccurrence) => occurrence.index),
    ),
    unsupportedRuntimeImport,
  };
};

const importsIn = (file: string, source: string): readonly ImportOccurrence[] =>
  analyzeImports(file, source).occurrences;

// --- Core: package.json + source imports must stay provider-neutral ------

const coreSourceRoot = 'packages/core-runtime/src';
const corePackageJsonRelative = 'packages/core-runtime/package.json';
const commerceVocabulary = /commerce|storefront|better[-_]?auth/iu;

const allowedCoreExternalSpecifiers = new Set([
  '@authzed/authzed-node',
  '@effect/platform-node',
  // The one Node HTTP server module, so a bundle reaching the outbox health server leaves the rest of
  // the platform package (its Redis and websocket clients) out.
  '@effect/platform-node/NodeHttpServer',
  '@effect/sql-pg',
  '@noble/hashes/sha2.js',
  '@noble/hashes/utils.js',
  'drizzle-kit',
  'drizzle-orm',
  'drizzle-orm/effect-core',
  'drizzle-orm/effect-postgres',
  'drizzle-orm/effect-postgres/migrator',
  'drizzle-orm/pg-core',
  'cloudflare:workers',
  'effect',
  'pg',
]);

// Effect 4 platform modules (formerly `effect/unstable/*`) are published as top-level subpaths.
const effectPlatformSubpath =
  /^effect\/(?:ai|cli|cluster|devtools|encoding|eventlog|http|http-api|net|observability|persistence|process|reactivity|rpc|schema|socket|sql|workers|workflow)(?:\/|$)/u;

const isAllowedCoreExternalSpecifier = (specifier: string): boolean =>
  allowedCoreExternalSpecifiers.has(specifier) || effectPlatformSubpath.test(specifier);

const coreExternalDependencyReason = (specifier: string): string =>
  commerceVocabulary.test(specifier)
    ? `Core runtime source imports Commerce/Storefront/Better Auth package "${specifier}"`
    : `Core runtime source imports a dependency outside the pinned external specifier set: "${specifier}"`;

/** Resolve a relative specifier against its importing file's directory, POSIX-style. */
const resolveRelativeSpecifier = (importer: string, specifier: string): string =>
  posixPath.normalize(posixPath.join(posixPath.dirname(importer), specifier));

const coreRelativeEscapeReason = (specifier: string, resolved: string): string =>
  commerceVocabulary.test(resolved)
    ? `Core runtime source imports Commerce/Storefront/Better Auth via relative specifier "${specifier}" (resolves to "${resolved}")`
    : `Core runtime source imports outside packages/core-runtime/src via relative specifier "${specifier}" (resolves to "${resolved}")`;

const isInsideCoreSource = (resolved: string): boolean =>
  resolved === coreSourceRoot || resolved.startsWith(`${coreSourceRoot}/`);

// These native dependencies are admitted only behind a proven Node condition, never in the shared set.
const nodeTransportSpecifiers = new Set(['@effect/platform-node/NodeStream', '@effect/platform-node/Undici']);

const recordCoreSourceViolations = (
  record: (violation: LeanCoreDependencyViolation) => void,
  relative: string,
  source: string,
  corePackageImports: ReadonlySet<string>,
  nodeOnlyFiles: ReadonlySet<string>,
): void => {
  if (!relative.startsWith(`${coreSourceRoot}/`)) {
    return;
  }
  for (const { index, specifier } of importsIn(relative, source)) {
    const isRelative = specifier.startsWith('.');
    const resolved = isRelative ? resolveRelativeSpecifier(relative, specifier) : undefined;
    // A `#` specifier is Core's own package import; checkCorePackageJson admits only those whose
    // every condition target stays inside Core source.
    const isExempt = isRelative
      ? resolved !== undefined && isInsideCoreSource(resolved)
      : corePackageImports.has(specifier) ||
        isAllowedCoreExternalSpecifier(specifier) ||
        (nodeOnlyFiles.has(relative) && nodeTransportSpecifiers.has(specifier));
    if (isExempt) {
      continue;
    }
    record({
      file: relative,
      line: sourceLine(source, index),
      reason:
        isRelative && resolved !== undefined
          ? coreRelativeEscapeReason(specifier, resolved)
          : coreExternalDependencyReason(specifier),
    });
  }
};

const PackageImportTargetSchema = Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)]);
const WorkspacePackageManifestSchema = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  exports: Schema.optional(Schema.Record(Schema.String, PackageImportTargetSchema)),
  imports: Schema.optional(Schema.Record(Schema.String, PackageImportTargetSchema)),
});

const packageImportTargets = (target: typeof PackageImportTargetSchema.Type): readonly string[] =>
  Predicate.isString(target) ? [target] : Object.values(target);
const WorkspacePackageManifestFromJson = Schema.fromJsonString(WorkspacePackageManifestSchema);

type PackageImportTarget = typeof PackageImportTargetSchema.Type;
interface CorePackageBoundary {
  readonly exports: ReadonlyMap<string, PackageImportTarget>;
  readonly imports: ReadonlyMap<string, PackageImportTarget>;
  readonly nodeDriverDeclared: boolean;
}

const SourceHostSchema = Schema.Literals(['node', 'workerd', 'browser']);
type SourceHost = typeof SourceHostSchema.Type;

const hasSupportedConditions = (target: PackageImportTarget): boolean =>
  Predicate.isString(target) ||
  Object.keys(target).every(
    (condition) => Schema.is(SourceHostSchema)(condition) || condition === 'import' || condition === 'default',
  );

/** Native conditional maps select the first matching property; default is not a fallback reordered by this gate. */
const selectHostTarget = (target: PackageImportTarget, host: SourceHost): string | undefined => {
  if (Predicate.isString(target)) {
    return target;
  }
  return Object.entries(target).find(
    ([condition]) => condition === host || condition === 'import' || condition === 'default',
  )?.[1];
};

const resolveCoreTarget = (target: string): string =>
  posixPath.normalize(posixPath.join(posixPath.dirname(corePackageJsonRelative), target));

/** Resolve actual indexed files; an ambiguous extensionless import supplies no isolation evidence. */
const resolveIndexedSource = (
  target: string,
  sources: ReadonlyMap<string, SourceImportAnalysis>,
): string | undefined => {
  if (sources.has(target)) {
    return target;
  }
  const extension = posixPath.extname(target);
  const candidates =
    extension === ''
      ? [...sourceExtensions]
          .map((sourceExtension) => `${target}${sourceExtension}`)
          .filter((file) => sources.has(file))
      : [];
  return candidates.length === 1 ? candidates[0] : undefined;
};

const resolveManifestSource = (
  target: string,
  sources: ReadonlyMap<string, SourceImportAnalysis>,
): string | undefined => {
  const file = resolveCoreTarget(target);
  return sources.has(file) ? file : undefined;
};

interface HostEdges {
  readonly files: readonly string[];
  readonly unsupported: boolean;
}

const sourceHostEdges = (
  file: string,
  host: SourceHost,
  sources: ReadonlyMap<string, SourceImportAnalysis>,
  boundary: CorePackageBoundary,
): HostEdges => {
  const source = sources.get(file);
  if (source === undefined) {
    return { files: [], unsupported: true };
  }
  const edges = source.occurrences
    .filter(({ isTypeOnly }) => !isTypeOnly)
    .map((occurrence): HostEdges => {
      let target: string | undefined;
      if (occurrence.specifier.startsWith('.')) {
        target = resolveRelativeSpecifier(file, occurrence.specifier);
      } else if (occurrence.specifier.startsWith('#')) {
        const condition = boundary.imports.get(occurrence.specifier);
        if (condition === undefined || !hasSupportedConditions(condition)) {
          return { files: [], unsupported: true };
        }
        const selected = selectHostTarget(condition, host);
        if (selected === undefined) {
          return { files: [], unsupported: false };
        }
        const resolvedManifestFile = resolveManifestSource(selected, sources);
        return resolvedManifestFile === undefined
          ? { files: [], unsupported: true }
          : { files: [resolvedManifestFile], unsupported: false };
      } else {
        return { files: [], unsupported: false };
      }
      if (target === undefined) {
        return { files: [], unsupported: false };
      }
      const resolved = resolveIndexedSource(target, sources);
      if (resolved === undefined || !isInsideCoreSource(resolved)) {
        return { files: [], unsupported: true };
      }
      return { files: [resolved], unsupported: false };
    });
  return {
    files: edges.flatMap(({ files }) => files),
    unsupported: source.unsupportedRuntimeImport || edges.some(({ unsupported }) => unsupported),
  };
};

interface HostClosure {
  readonly files: ReadonlySet<string>;
  readonly unsupported: boolean;
}

const hostClosure = (
  roots: readonly string[],
  host: SourceHost,
  sources: ReadonlyMap<string, SourceImportAnalysis>,
  boundary: CorePackageBoundary,
): HostClosure => {
  const files = new Set<string>();
  const pending = [...roots];
  let unsupported = false;
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || files.has(file)) {
      continue;
    }
    files.add(file);
    const edges = sourceHostEdges(file, host, sources, boundary);
    unsupported ||= edges.unsupported;
    pending.push(...edges.files);
  }
  return { files, unsupported };
};

/** Host isolation comes from consumed native conditions and runtime edges, never a filename suffix. */
const nodeOnlyCoreSources = (
  sources: ReadonlyMap<string, SourceImportAnalysis>,
  boundary: CorePackageBoundary,
): ReadonlySet<string> => {
  if (!boundary.nodeDriverDeclared) {
    return new Set();
  }
  const consumedImports = new Set(
    [...sources.values()].flatMap(({ occurrences }) =>
      occurrences.filter(({ isTypeOnly }) => !isTypeOnly).map(({ specifier }) => specifier),
    ),
  );
  const conditions = [
    ...boundary.exports.values(),
    ...[...boundary.imports].filter(([name]) => consumedImports.has(name)).map(([, target]) => target),
  ];
  const nodeRoots = conditions.flatMap((target) => {
    if (
      Predicate.isString(target) ||
      !hasSupportedConditions(target) ||
      target.node === undefined ||
      selectHostTarget(target, 'node') !== target.node
    ) {
      return [];
    }
    const file = resolveManifestSource(target.node, sources);
    return file === undefined ? [] : [file];
  });
  const node = hostClosure(nodeRoots, 'node', sources, boundary);
  if (node.unsupported) {
    return new Set();
  }
  const sharedRoots = [...sources.keys()].filter((file) => !node.files.has(file));
  const allConditions = [...boundary.exports.values(), ...boundary.imports.values()];
  const nonNode = new Set<string>();
  for (const host of ['workerd', 'browser'] satisfies readonly SourceHost[]) {
    let unsupportedTarget = false;
    const roots = allConditions.flatMap((target) => {
      const targets = hasSupportedConditions(target) ? [selectHostTarget(target, host)] : packageImportTargets(target);
      return targets.flatMap((selected) => {
        if (selected === undefined) {
          return [];
        }
        const file = resolveManifestSource(selected, sources);
        if (file === undefined) {
          unsupportedTarget = true;
          return [];
        }
        return [file];
      });
    });
    if (unsupportedTarget) {
      return new Set();
    }
    const closure = hostClosure([...sharedRoots, ...roots], host, sources, boundary);
    if (closure.unsupported) {
      return new Set();
    }
    for (const file of closure.files) {
      nonNode.add(file);
    }
  }
  return new Set([...node.files].filter((file) => !nonNode.has(file)));
};

const allowedCorePackageDependencies = new Set([
  '@authzed/authzed-node',
  '@effect/platform-node',
  '@effect/sql-pg',
  '@noble/hashes',
  'drizzle-kit',
  'drizzle-orm',
  'effect',
  'pg',
]);

const checkCorePackageJson = (
  fileSystem: FileSystem.FileSystem,
  root: string,
  path: Path.Path,
  record: (violation: LeanCoreDependencyViolation) => void,
): Effect.Effect<CorePackageBoundary, PlatformError> =>
  Effect.gen(function* checkCorePackageJsonProgram() {
    const file = path.join(root, corePackageJsonRelative);
    const exists = yield* fileSystem.exists(file);
    if (!exists) {
      return { exports: new Map(), imports: new Map(), nodeDriverDeclared: false };
    }
    const raw = yield* fileSystem.readFileString(file, 'utf-8');
    const parsed = yield* Schema.decodeUnknownEffect(WorkspacePackageManifestFromJson)(raw).pipe(Effect.orDie);
    const corePackageImports = new Map<string, PackageImportTarget>();
    for (const [name, target] of Object.entries(parsed.imports ?? {})) {
      const escaping = packageImportTargets(target).filter(
        (targetPath) =>
          !isInsideCoreSource(
            posixPath.normalize(posixPath.join(posixPath.dirname(corePackageJsonRelative), targetPath)),
          ),
      );
      if (escaping.length === 0) {
        corePackageImports.set(name, target);
        continue;
      }
      record({
        file: corePackageJsonRelative,
        line: 1,
        reason: `Core runtime package.json maps package import "${name}" outside packages/core-runtime/src: "${escaping.join('", "')}"`,
      });
    }
    for (const [name] of Object.entries(parsed.dependencies ?? {})) {
      if (!allowedCorePackageDependencies.has(name)) {
        record({
          file: corePackageJsonRelative,
          line: 1,
          reason: commerceVocabulary.test(name)
            ? `Core runtime package.json declares a Commerce/Storefront/Better Auth dependency "${name}"`
            : `Core runtime package.json declares a dependency outside the pinned external specifier set: "${name}"`,
        });
      }
    }
    for (const [name] of Object.entries(parsed.devDependencies ?? {})) {
      if (commerceVocabulary.test(name)) {
        record({
          file: corePackageJsonRelative,
          line: 1,
          reason: `Core runtime package.json declares a Commerce/Storefront/Better Auth devDependency "${name}"`,
        });
      }
    }
    return {
      exports: new Map(Object.entries(parsed.exports ?? {})),
      imports: corePackageImports,
      nodeDriverDeclared: parsed.dependencies?.['@effect/platform-node'] !== undefined,
    };
  });

// --- Non-Commerce apps/verticals must not import Commerce private impl ---

const commerceVerticalRoot = 'verticals/commerce-customer-context';
const nonCommerceOwnerParents = ['apps', 'verticals'];
const commercePackageSpecifierPrefix = '@app/commerce-customer-context';
const commercePrivateImplementation = /(?:^|\/)verticals\/commerce-customer-context\/(?:src|api)\//u;

/** Every directory under `apps/` and `verticals/` owns a unit, except Commerce's own (the thing being bounded). */
const ownerRootsUnderParent = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  parent: string,
): Effect.Effect<readonly string[], PlatformError> =>
  Effect.gen(function* ownerRootsUnderParentProgram() {
    const parentPath = path.join(root, parent);
    const exists = yield* fileSystem.exists(parentPath);
    if (!exists) {
      return [];
    }
    const entries = yield* fileSystem.readDirectory(parentPath);
    const ownerRoots = yield* Effect.all(
      entries.map((entry) =>
        Effect.gen(function* ownerRootUnderParentProgram() {
          const relative = `${parent}/${entry}`;
          if (relative === commerceVerticalRoot) {
            return Option.none();
          }
          const info = yield* fileSystem.stat(path.join(parentPath, entry));
          return info.type === 'Directory' ? Option.some(relative) : Option.none();
        }),
      ),
      { concurrency: 32 },
    );
    return EffectArray.getSomes(ownerRoots);
  });

const discoverNonCommerceOwnerRoots = (
  fileSystem: FileSystem.FileSystem,
  root: string,
  path: Path.Path,
): Effect.Effect<readonly string[], PlatformError> =>
  Effect.gen(function* discoverNonCommerceOwnerRootsProgram() {
    const rootsByParent = yield* Effect.all(
      nonCommerceOwnerParents.map((parent) => ownerRootsUnderParent(fileSystem, path, root, parent)),
      { concurrency: 32 },
    );
    return EffectArray.sort(rootsByParent.flat(), Order.String);
  });

const CommercePackageExportsSchema = Schema.Struct({
  exports: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const CommercePackageExportsFromJson = Schema.fromJsonString(CommercePackageExportsSchema);

/** Commerce's package.json `exports` map: subpath -> published target file. */
const readCommerceExportsMap = (
  fileSystem: FileSystem.FileSystem,
  root: string,
  path: Path.Path,
): Effect.Effect<ReadonlyMap<string, string>, PlatformError> =>
  Effect.gen(function* readCommerceExportsMapProgram() {
    const file = path.join(root, 'verticals/commerce-customer-context/package.json');
    const exists = yield* fileSystem.exists(file);
    if (!exists) {
      return new Map<string, string>();
    }
    const raw = yield* fileSystem.readFileString(file, 'utf-8');
    const parsed = yield* Schema.decodeUnknownEffect(CommercePackageExportsFromJson)(raw).pipe(Effect.orDie);
    const exportsField = parsed.exports ?? {};
    return new Map(
      Object.entries(exportsField).map(([subpath, target]) => [
        subpath === '.'
          ? commercePackageSpecifierPrefix
          : `${commercePackageSpecifierPrefix}/${subpath.replace(/^\.\//u, '')}`,
        target.replace(/^\.\//u, 'verticals/commerce-customer-context/'),
      ]),
    );
  });

/** Explicitly accepted (specifier, importer) pairs into Commerce's private src; any other pair is a violation. */
interface AllowedCompositionSeam {
  readonly importer: string;
  readonly reason: string;
  readonly specifier: string;
}

const orderApprovalOwnerGateway = 'verticals/commerce-order/src/services/approval-owner-gateway.ts';
const privacyConsentProfileAuthority =
  'verticals/privacy/src/integrations/commerce-customer-context/commerce-customer-context-consent-withdrawal.service.ts';
const privacyNoticeProfileAuthority =
  'verticals/privacy/src/integrations/commerce-customer-context/commerce-customer-context-notice-subject-authority.service.ts';

const allowedCompositionSeams: readonly AllowedCompositionSeam[] = [
  ...[
    '/api/client',
    '/api/customer-group-definition-source/client',
    '/api/customer-group-membership-source-receipt/client',
    '/api/customer-profile-ico/client',
    '/api/organization-customer-profile-ico/client',
    '/api/change-organization-customer-profile-ico-action/client',
    '/api/migrate-organization-customer-profile-ico-action/client',
    '/api/customer-profile-source/client',
    '/api/customer-price-group-assignment-receipt/client',
    '/api/add-saved-address-action/client',
    '/api/update-saved-address-action/client',
    '/api/remove-saved-address-action/client',
    '/api/saved-address-source-receipt/client',
  ].map((suffix) => ({
    importer: 'verticals/symmy-integration/src/services/symmy-party-commerce-adapters.ts',
    reason:
      'Approved C14 source orchestration calls the governed Commerce owner clients for separate native effects and exact recovery.',
    specifier: `${commercePackageSpecifierPrefix}${suffix}`,
  })),
  ...[
    '/api/customer-profile-ico/client',
    '/api/customer-profile-source-page/client',
    '/api/customer-profile-source-parties/client',
    '/api/organization-customer-profile-ico/client',
  ].map((suffix) => ({
    importer: 'apps/shell-super-app/api/symmy/source-read-projections.ts',
    reason: 'Approved C14 customer export projects current qualified profiles and IČO through governed Commerce Reads.',
    specifier: `${commercePackageSpecifierPrefix}${suffix}`,
  })),
  ...[
    'verticals/privacy/src/services/organization-profile-ico-applicability.service.ts',
    'verticals/privacy/src/services/organization-business-applicability.service.ts',
  ].flatMap((importer) =>
    ['/api/customer-profile-organization-ico-facts', '/api/customer-profile-organization-ico-facts/client'].map(
      (suffix) => ({
        importer,
        reason:
          'Approved organization policy verifies the exact current profile through the governed owner projection.',
        specifier: `${commercePackageSpecifierPrefix}${suffix}`,
      }),
    ),
  ),
  {
    importer: privacyConsentProfileAuthority,
    reason:
      'Privacy Consent withdrawal verifies the exact customer profile through its existing governed Customer Context integration boundary.',
    specifier: `${commercePackageSpecifierPrefix}/api/customer-profile-read/client`,
  },
  {
    importer: privacyConsentProfileAuthority,
    reason:
      'Privacy Consent withdrawal verifies the profile-bound Principal through its existing governed Customer Context integration boundary.',
    specifier: `${commercePackageSpecifierPrefix}/api/retail-principal-resolution/client`,
  },
  {
    importer: privacyConsentProfileAuthority,
    reason:
      'Privacy Consent withdrawal verifies the exact portal profile binding through its existing governed Customer Context integration boundary.',
    specifier: `${commercePackageSpecifierPrefix}/api/retail-portal-profile-binding-read/client`,
  },
  {
    importer: privacyConsentProfileAuthority,
    reason:
      'Privacy Consent withdrawal verifies current Consent authority through its existing governed Customer Context integration boundary.',
    specifier: `${commercePackageSpecifierPrefix}/api/retail-access-decision/client`,
  },
  {
    importer: privacyNoticeProfileAuthority,
    reason:
      'Privacy Notice acknowledgement verifies the exact customer profile through its existing governed Customer Context integration boundary.',
    specifier: `${commercePackageSpecifierPrefix}/api/customer-profile-read/client`,
  },
  {
    importer: privacyNoticeProfileAuthority,
    reason:
      'Privacy Notice acknowledgement verifies the profile-bound Principal through its existing governed Customer Context integration boundary.',
    specifier: `${commercePackageSpecifierPrefix}/api/retail-principal-resolution/client`,
  },
  {
    importer: privacyNoticeProfileAuthority,
    reason:
      'Privacy Notice acknowledgement verifies the exact portal profile binding through its existing governed Customer Context integration boundary.',
    specifier: `${commercePackageSpecifierPrefix}/api/retail-portal-profile-binding-read/client`,
  },
  {
    importer: privacyNoticeProfileAuthority,
    reason:
      'Privacy Notice acknowledgement verifies current Consent authority through its existing governed Customer Context integration boundary.',
    specifier: `${commercePackageSpecifierPrefix}/api/retail-access-decision/client`,
  },
  {
    importer: 'verticals/commerce-cart/src/services/final-cart-candidate-owners.service.ts',
    reason:
      'Approved #1257 final Cart candidate obtains exact CCC approval evidence through the generated governed HTTP boundary.',
    specifier: `${commercePackageSpecifierPrefix}/api/order-service-approval-evidence/client`,
  },
  {
    importer: 'verticals/commerce-order/src/integrations/finalization-tax-payment-terms.ts',
    reason:
      'Approved #1257 final Order fence resolves exact approved Payment Terms through the CCC governed owner client.',
    specifier: `${commercePackageSpecifierPrefix}/api/order-service-approval-evidence/client`,
  },
  {
    importer: orderApprovalOwnerGateway,
    reason:
      'Approved #1257 Order owner gateway reads and recovers exact CCC approval evidence; it does not import owner persistence.',
    specifier: `${commercePackageSpecifierPrefix}/api/order-service-approval-evidence/client`,
  },
  {
    importer: orderApprovalOwnerGateway,
    reason:
      'Approved #1257 Order finalization revalidates its exact CCC approval binding through the generated governed Action client.',
    specifier: `${commercePackageSpecifierPrefix}/api/revalidate-order-purchase-approval-action/client`,
  },
  {
    importer: orderApprovalOwnerGateway,
    reason:
      'Approved #1257 Order finalization consumes its exact CCC approval through the generated governed Action client.',
    specifier: `${commercePackageSpecifierPrefix}/api/consume-order-purchase-approval-action/client`,
  },
  {
    importer: 'verticals/pricing/src/services/preapproval-quotation-verification.service.ts',
    reason:
      'Approved #1257 preproposal basis verifies the exact CCC buyer context before retaining the pre-Tax Pricing quotation.',
    specifier: `${commercePackageSpecifierPrefix}/api/purchase-proposal-basis/client`,
  },
  {
    importer: 'verticals/pricing/src/integrations/commerce-price-group-resolution.ts',
    reason:
      'Pricing composes the narrow Customer Context price-group resolution owner client at its explicit integration boundary.',
    specifier: `${commercePackageSpecifierPrefix}/api/customer-price-group-resolution/client`,
  },
  {
    importer: 'verticals/pricing/src/integrations/current-pricing-decision-external-owner-evidence-live.ts',
    reason:
      'Pricing composes the narrow Customer Context price-group resolution owner client for external-owner evidence validation.',
    specifier: `${commercePackageSpecifierPrefix}/api/customer-price-group-resolution/client`,
  },
  {
    importer: 'verticals/pricing/src/integrations/current-pricing-decision-owner-final-fence.ts',
    reason:
      'Pricing composes the narrow Customer Context price-group resolution owner client for the final owner-authority fence.',
    specifier: `${commercePackageSpecifierPrefix}/api/customer-price-group-resolution/client`,
  },
  {
    importer: 'verticals/pricing/src/integrations/current-pricing-decision-owner-final-fence.ts',
    reason:
      'Pricing replays the narrow Customer Context purchase-context verification owner client at the final owner-authority fence, so the retained Purchase Context is verified in the same Attempt.',
    specifier: `${commercePackageSpecifierPrefix}/api/pricing-purchase-context-verification/client`,
  },
  {
    importer: 'verticals/pricing/src/integrations/customer-context-subject-authority.ts',
    reason:
      'Pricing composes the narrow Customer Context purchase-context verification owner client at its subject-authority integration boundary.',
    specifier: `${commercePackageSpecifierPrefix}/api/pricing-purchase-context-verification/client`,
  },
  {
    importer: 'apps/shell-super-app/src/api/vertical-clients.ts',
    reason: 'Commerce publishes this as its sanctioned read-only API client for Shell composition.',
    specifier: `${commercePackageSpecifierPrefix}/api/client`,
  },
  {
    importer: 'apps/shell-super-app/api/auth/commerce-external-identity.ts',
    reason:
      'Shell composition seam for Commerce portal-auth verification during external-identity admission; scoped to the verification client only.',
    specifier: `${commercePackageSpecifierPrefix}/portal-auth/verification/client`,
  },
  {
    importer: 'apps/shell-super-app/api/auth/external-identity/commerce-admission-observation.ts',
    reason:
      'Shell composition seam for Commerce portal-auth verification during external-identity admission; scoped to the verification client only.',
    specifier: `${commercePackageSpecifierPrefix}/portal-auth/verification/client`,
  },
];

export const isAllowedCompositionSeam = (importer: string, specifier: string): boolean =>
  allowedCompositionSeams.some((seam) => seam.importer === importer && seam.specifier === specifier);

const recordNonCommerceImportViolations = (
  record: (violation: LeanCoreDependencyViolation) => void,
  relative: string,
  source: string,
  commerceExports: ReadonlyMap<string, string>,
  nonCommerceOwnerRoots: readonly string[],
): void => {
  const isOwnedByNonCommerceUnit = nonCommerceOwnerRoots.some((ownerRoot) => relative.startsWith(`${ownerRoot}/`));
  if (!isOwnedByNonCommerceUnit || isTestSource(relative)) {
    return;
  }
  const underSrcOrApi = /(?:^|\/)(?:src|api)\//u.test(relative);
  if (!underSrcOrApi) {
    return;
  }
  for (const { index, isTypeOnly, specifier } of importsIn(relative, source)) {
    const resolvedTarget = commerceExports.get(specifier);
    const resolvedRelativeSpecifier = specifier.startsWith('.')
      ? posixPath.normalize(posixPath.join(posixPath.dirname(relative), specifier))
      : undefined;
    const isCommercePackageSpecifier =
      specifier === commercePackageSpecifierPrefix || specifier.startsWith(`${commercePackageSpecifierPrefix}/`);
    const targetsCommercePrivateImplementation = isCommercePackageSpecifier
      ? resolvedTarget !== undefined && commercePrivateImplementation.test(resolvedTarget)
      : commercePrivateImplementation.test(resolvedRelativeSpecifier ?? specifier);
    const isViolation =
      !isTypeOnly && targetsCommercePrivateImplementation && !isAllowedCompositionSeam(relative, specifier);
    if (!isViolation) {
      continue;
    }
    record({
      file: relative,
      line: sourceLine(source, index),
      reason: `Non-Commerce unit takes a mandatory runtime import of Commerce's private implementation "${specifier}" (only published shared/ contracts and documented composition seams are allowed)`,
    });
  }
};

const byField = <K extends keyof LeanCoreDependencyViolation>(
  key: K,
  order: Order.Order<LeanCoreDependencyViolation[K]>,
) => Order.mapInput(order, (violation: LeanCoreDependencyViolation) => violation[key]);

const ViolationOrder = Order.combine(
  byField('file', Order.String),
  Order.combine(byField('line', Order.Number), byField('reason', Order.String)),
);

export const checkLeanCoreDependencies = (
  root: string,
  listing: SourceFileListing,
): Effect.Effect<readonly LeanCoreDependencyViolation[], PlatformError, CheckServices> =>
  Effect.gen(function* checkLeanCoreDependenciesProgram() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const violations: LeanCoreDependencyViolation[] = [];
    const recorded = new Set<string>();
    const record = (violation: LeanCoreDependencyViolation): void => {
      const key = `${violation.file}:${violation.line}:${violation.reason}`;
      if (recorded.has(key)) {
        return;
      }
      recorded.add(key);
      violations.push(violation);
    };

    const [listed, commerceExports, nonCommerceOwnerRoots, coreBoundary] = yield* Effect.all([
      listing(root),
      readCommerceExportsMap(fileSystem, root, path),
      discoverNonCommerceOwnerRoots(fileSystem, root, path),
      checkCorePackageJson(fileSystem, root, path, record),
    ]);
    const files = listedSources(listed, '', sourceExtensions).map((file) => path.join(root, file));
    const sourcePairs = yield* Effect.all(
      files.map((file) =>
        fileSystem.readFileString(file, 'utf-8').pipe(Effect.map((source) => [file, source] as const)),
      ),
      { concurrency: 32 },
    );

    // Source policy retains its original TS inventory. Native JS/CJS is indexed only to prove graph edges.
    const coreGraphFiles = listedSources(listed, coreSourceRoot, graphSourceExtensions).map((file) =>
      path.join(root, file),
    );
    const sourceFiles = new Set(files);
    const additionalGraphSources = yield* Effect.all(
      coreGraphFiles
        .filter((file) => !sourceFiles.has(file))
        .map((file) => fileSystem.readFileString(file, 'utf-8').pipe(Effect.map((source) => [file, source] as const))),
      { concurrency: 32 },
    );

    const coreSources = new Map(
      [...sourcePairs, ...additionalGraphSources].flatMap(([file, source]) => {
        const relative = path.relative(root, file).split(path.sep).join('/');
        return isInsideCoreSource(relative) ? [[relative, analyzeImports(relative, source)] as const] : [];
      }),
    );
    const nodeOnlyFiles = nodeOnlyCoreSources(coreSources, coreBoundary);
    const corePackageImports = new Set(coreBoundary.imports.keys());

    for (const [file, source] of sourcePairs) {
      const relative = path.relative(root, file).split(path.sep).join('/');
      recordCoreSourceViolations(record, relative, source, corePackageImports, nodeOnlyFiles);
      recordNonCommerceImportViolations(record, relative, source, commerceExports, nonCommerceOwnerRoots);
    }

    return EffectArray.sort(violations, ViolationOrder);
  });

// --- Module boundary freeze: package edges into modules and apps ----------

/**
 * Every workspace package is a node: the package.json directories under apps/, packages/ and verticals/
 * (modules). An edge from one package to another is the union of a declaration in any dependency field, a
 * source specifier that names the other package, and a relative specifier that leaves the package for a
 * file the other package owns. Its class is runtime when a runtime field declares it or a non-test source
 * imports it, and test when only devDependencies and test sources make it.
 *
 * The frozen edges run from a module or a package to a module or an app: a module to another module
 * (rule 1), a package to a module or an app (rule 2), and a module to an app (rule 3). Each one exists only
 * as an entry of the committed baseline with its class, and every entry is such an edge of the tree with
 * that class (rule 4). Given the run's comparison base, the baseline may only shrink: a baseline that is not
 * the one at the base names only edges the base tree has, with the same or a wider class (rule 5).
 */

const workspacePackageParents = [
  ['apps', 'app'],
  ['packages', 'package'],
  ['verticals', 'module'],
] as const;
type WorkspacePackageKind = (typeof workspacePackageParents)[number][1];

export const moduleEdgeBaselineRelative = 'scripts/lean-core-dependency-baseline.json';

const EdgeClassSchema = Schema.Literals(['runtime', 'test']);
type EdgeClass = typeof EdgeClassSchema.Type;

const ModuleEdgeBaselineEntrySchema = Schema.Struct({
  class: EdgeClassSchema,
  from: Schema.String,
  to: Schema.String,
});
type ModuleEdgeBaselineEntry = typeof ModuleEdgeBaselineEntrySchema.Type;
const ModuleEdgeBaselineFromJson = Schema.fromJsonString(Schema.Array(ModuleEdgeBaselineEntrySchema));
const BaselineEntryOrder = Order.combine(
  Order.mapInput(Order.String, (entry: ModuleEdgeBaselineEntry) => entry.from),
  Order.mapInput(Order.String, (entry: ModuleEdgeBaselineEntry) => entry.to),
);

/** A target of a package `imports` entry: a path or package, null, or nested conditions and fallbacks. */
type PackageImportsTarget =
  | string
  | null
  | readonly PackageImportsTarget[]
  | { readonly [condition: string]: PackageImportsTarget };
const PackageImportsTargetSchema: Schema.Codec<PackageImportsTarget> = Schema.Union([
  Schema.String,
  Schema.Null,
  Schema.Array(Schema.suspend((): Schema.Codec<PackageImportsTarget> => PackageImportsTargetSchema)),
  Schema.Record(
    Schema.String,
    Schema.suspend((): Schema.Codec<PackageImportsTarget> => PackageImportsTargetSchema),
  ),
]);

const dependencyFields = ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies'] as const;
const DependencyFieldSchema = Schema.optional(Schema.Record(Schema.String, Schema.String));
const PackageEdgeManifestFromJson = Schema.fromJsonString(
  Schema.Struct({
    dependencies: DependencyFieldSchema,
    devDependencies: DependencyFieldSchema,
    imports: Schema.optional(Schema.Record(Schema.String, PackageImportsTargetSchema)),
    name: Schema.optional(Schema.String),
    optionalDependencies: DependencyFieldSchema,
    peerDependencies: DependencyFieldSchema,
  }),
);
type PackageEdgeManifest = typeof PackageEdgeManifestFromJson.Type;

interface WorkspacePackage {
  readonly directory: string;
  readonly kind: WorkspacePackageKind;
  readonly manifest: PackageEdgeManifest;
}

/** One place that makes an edge: a dependency field of a manifest, or a specifier at a source line. */
interface EdgeSite {
  readonly class: EdgeClass;
  readonly field?: (typeof dependencyFields)[number];
  readonly file: string;
  readonly line: number;
}

interface PackageEdge {
  readonly class: EdgeClass;
  readonly from: string;
  readonly sites: readonly EdgeSite[];
  readonly to: string;
}

interface PackageGraph {
  readonly edges: ReadonlyMap<string, PackageEdge>;
  readonly packages: ReadonlyMap<string, WorkspacePackageKind>;
  readonly unparsable: readonly string[];
}

const edgeKey = (from: string, to: string): string => `${from} -> ${to}`;

const EdgeSiteOrder = Order.combine(
  Order.mapInput(Order.String, (site: EdgeSite) => site.file),
  Order.mapInput(Order.Number, (site: EdgeSite) => site.line),
);

/** The package a bare specifier names: its scope and name, without a subpath. */
const specifierPackageName = (specifier: string): string =>
  specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/');

const workspacePackageManifest = /^(?<parent>apps|packages|verticals)\/(?<entry>[^/]+)\/package\.json$/u;

const readEdgeManifest = (
  root: string,
  file: string,
): Effect.Effect<PackageEdgeManifest, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* readEdgeManifestProgram() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const raw = yield* fileSystem.readFileString(path.join(root, file), 'utf-8');
    return yield* Schema.decodeUnknownEffect(PackageEdgeManifestFromJson)(raw).pipe(Effect.orDie);
  });

/** The workspace packages among the listed files: each package.json one level under apps/, packages/, verticals/. */
const listedWorkspacePackages = (
  root: string,
  listed: readonly string[],
): Effect.Effect<readonly WorkspacePackage[], PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* listedWorkspacePackagesProgram() {
    const manifests = EffectArray.sort(listed, Order.String).flatMap((file) => {
      const groups = workspacePackageManifest.exec(file)?.groups;
      const kind = workspacePackageParents.find(([parent]) => parent === groups?.parent)?.[1];
      return groups === undefined || kind === undefined
        ? []
        : [{ directory: `${groups.parent}/${groups.entry}`, file, kind }];
    });
    return yield* Effect.all(
      manifests.map(({ directory, file, kind }) =>
        readEdgeManifest(root, file).pipe(Effect.map((manifest): WorkspacePackage => ({ directory, kind, manifest }))),
      ),
      { concurrency: 32 },
    );
  });

/** Every source format a workspace package can hold, each parsed in its own language. */
const moduleSourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

const moduleLanguage = (file: string): 'js' | 'jsx' | 'ts' | 'tsx' => {
  const extension = posixPath.extname(file);
  if (extension === '.tsx' || extension === '.jsx') {
    return extension === '.tsx' ? 'tsx' : 'jsx';
  }
  return extension === '.ts' || extension === '.mts' || extension === '.cts' ? 'ts' : 'js';
};

/** A specifier written in source, at the index of the construct that names it. */
interface ModuleReference {
  readonly index: number;
  readonly specifier: string;
}

const literalString = (node: Argument | Expression | undefined): string | undefined => {
  if (node?.type === 'Literal' && Predicate.isString(node.value)) {
    return node.value;
  }
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
};

const isCreateRequireCall = (node: Expression): boolean =>
  node.type === 'CallExpression' &&
  (node.callee.type === 'Identifier'
    ? node.callee.name === 'createRequire'
    : node.callee.type === 'MemberExpression' && staticMemberName(node.callee) === 'createRequire');

const isImportMeta = (node: Expression): boolean =>
  node.type === 'MetaProperty' && node.meta.name === 'import' && node.property.name === 'meta';

const referenceDirective = /^\/\s*<reference\s+(?<kind>path|types)\s*=\s*["'](?<target>[^"']+)["']/u;

/**
 * Every specifier the file names with a literal: static imports and re-exports at any depth, `import()`,
 * TypeScript import types and `import x = require()`, `require()` and `require.resolve()` (also through
 * `module.require`, `createRequire(...)` and a binding of its result), `import.meta.resolve()`, and
 * triple-slash reference directives. None when the file does not parse, so its edges are unknown.
 */
const moduleReferencesIn = (file: string, source: string): Option.Option<readonly ModuleReference[]> => {
  const parsed = parseSync(file, source, {
    astType: 'ts',
    lang: moduleLanguage(file),
    sourceType: file.endsWith('.cjs') ? 'script' : 'module',
  });
  if (parsed.errors.length > 0) {
    return Option.none();
  }
  const references: ModuleReference[] = [];
  const record = (index: number, specifier: string | null | undefined): void => {
    if (Predicate.isString(specifier)) {
      references.push({ index, specifier });
    }
  };
  const loaders = new Set(['require']);
  new Visitor({
    VariableDeclarator: (node) => {
      if (node.id.type === 'Identifier' && node.init !== null && isCreateRequireCall(node.init)) {
        loaders.add(node.id.name);
      }
    },
  }).visit(parsed.program);
  const isLoader = (node: Expression): boolean =>
    (node.type === 'Identifier' && loaders.has(node.name)) ||
    (node.type === 'MemberExpression' && staticMemberName(node) === 'require') ||
    isCreateRequireCall(node);
  new Visitor({
    CallExpression: (node) => {
      const { callee } = node;
      const resolves =
        callee.type === 'MemberExpression' &&
        staticMemberName(callee) === 'resolve' &&
        (isLoader(callee.object) || isImportMeta(callee.object));
      if (resolves || isLoader(callee)) {
        record(node.start, literalString(node.arguments[0]));
      }
    },
    ExportAllDeclaration: (node) => record(node.start, node.source.value),
    ExportNamedDeclaration: (node) => record(node.start, node.source?.value),
    ImportDeclaration: (node) => record(node.start, node.source.value),
    ImportExpression: (node) => record(node.start, literalString(node.source)),
    TSImportEqualsDeclaration: (node) =>
      record(
        node.start,
        node.moduleReference.type === 'TSExternalModuleReference' ? node.moduleReference.expression.value : undefined,
      ),
    TSImportType: (node) => record(node.start, node.source.value),
  }).visit(parsed.program);
  for (const comment of parsed.comments) {
    const directive = comment.type === 'Line' ? referenceDirective.exec(comment.value)?.groups : undefined;
    const target = directive?.target;
    if (target !== undefined) {
      // A path directive is relative to its file even without a leading dot.
      record(comment.start, directive?.kind === 'path' && !target.startsWith('.') ? `./${target}` : target);
    }
  }
  return Option.some(
    EffectArray.sort(
      references,
      Order.mapInput(Order.Number, (reference: ModuleReference) => reference.index),
    ),
  );
};

/** Every path or package an `imports` target can select, under any condition. */
const importsTargetStrings = (target: PackageImportsTarget): readonly string[] => {
  if (target === null) {
    return [];
  }
  if (Predicate.isString(target)) {
    return [target];
  }
  return (Array.isArray(target) ? target : Object.values(target)).flatMap(importsTargetStrings);
};

const versionProtocol = /^(?<protocol>[a-z][a-z+]*):(?<rest>.*)$/u;
const aliasedPackage = /^(?<name>@[^/@]+\/[^/@]+|[^/@]+)(?:@|$)/u;
const pathProtocols = new Set(['file', 'link', 'portal']);

/** Whether an `imports` key with one `*` matches specifier, as Node matches it. */
const matchesSubpathPattern = (key: string, specifier: string): boolean => {
  const star = key.indexOf('*');
  if (star === -1 || star !== key.lastIndexOf('*')) {
    return false;
  }
  const base = key.slice(0, star);
  return (
    specifier.startsWith(base) &&
    specifier !== base &&
    specifier.endsWith(key.slice(star + 1)) &&
    specifier.length >= key.length
  );
};

/** Node's order of `imports` patterns: the longer prefix before `*` first, then the longer key. */
const SubpathPatternOrder = Order.combine(
  Order.mapInput(Order.flip(Order.Number), ([key]: readonly [string, PackageImportsTarget]) => key.indexOf('*')),
  Order.mapInput(Order.flip(Order.Number), ([key]: readonly [string, PackageImportsTarget]) => key.length),
);

/** How specifiers and dependency declarations of the workspace at root land on its packages. */
const workspaceResolver = (
  root: string,
  path: Path.Path,
  packages: readonly WorkspacePackage[],
  rootManifest: PackageEdgeManifest,
) => {
  const directoryByName = new Map(
    packages.flatMap(({ directory, manifest }) =>
      manifest.name === undefined ? [] : [[manifest.name, directory] as const],
    ),
  );
  const owner = (file: string): string | undefined =>
    packages.find(({ directory }) => file === directory || file.startsWith(`${directory}/`))?.directory;
  const ownerOfPath = (directory: string, target: string): string | undefined =>
    owner(
      path.isAbsolute(target)
        ? path.relative(root, target).split(path.sep).join('/')
        : posixPath.normalize(posixPath.join(directory, target)),
    );
  /**
   * The workspace package a declaration installs: the key's own package for a plain range or a catalog, the
   * named package for a `workspace:` or `npm:` alias, the package holding the path for a `workspace:`,
   * `link:`, `file:` or `portal:` path, and none for any other protocol.
   */
  const declaredTarget = (directory: string, name: string, range: string): string | undefined => {
    const groups = versionProtocol.exec(range)?.groups;
    const protocol = groups?.protocol ?? 'catalog';
    const rest = groups?.rest ?? '';
    const isPath = rest.startsWith('.') || rest.startsWith('/');
    if (pathProtocols.has(protocol) || (protocol === 'workspace' && isPath)) {
      return ownerOfPath(directory, rest);
    }
    const alias = aliasedPackage.exec(rest)?.groups?.name;
    if (protocol === 'npm' || (protocol === 'workspace' && rest.includes('@', 1))) {
      return directoryByName.get(alias ?? '');
    }
    return protocol === 'catalog' || protocol === 'workspace' ? directoryByName.get(name) : undefined;
  };
  const declarations = (directory: string, manifest: PackageEdgeManifest) =>
    new Map(
      dependencyFields
        .flatMap((field) => Object.entries(manifest[field] ?? {}))
        .map(([name, range]) => [name, declaredTarget(directory, name, range)] as const),
    );
  const declared = new Map(
    packages.map(({ directory, manifest }) => [directory, declarations(directory, manifest)] as const),
  );
  const rootDeclared = declarations('.', rootManifest);
  /**
   * A bare specifier loads what its package declares under that name, else what the root package.json
   * declares under it (installed where every package finds it), else the workspace package of that name.
   */
  const bareTarget = (directory: string, specifier: string): string | undefined => {
    const name = specifierPackageName(specifier);
    const own = declared.get(directory);
    if (own?.has(name) === true) {
      return own.get(name);
    }
    return rootDeclared.has(name) ? rootDeclared.get(name) : directoryByName.get(name);
  };
  const importsEntryTargets = (directory: string, target: PackageImportsTarget, star: string) =>
    importsTargetStrings(target).map((selected) => {
      const expanded = selected.replaceAll('*', star);
      return expanded.startsWith('.') ? ownerOfPath(directory, expanded) : bareTarget(directory, expanded);
    });
  /**
   * A `#` specifier loads every target of the one `imports` entry Node selects for it: the key equal to it,
   * else the matching `*` pattern with the longest prefix before its `*`, then the longest key.
   */
  const subpathImportTargets = (
    { directory, manifest }: WorkspacePackage,
    specifier: string,
  ): readonly (string | undefined)[] => {
    const entries = Object.entries(manifest.imports ?? {});
    const exact = entries.find(([key]) => key === specifier && !key.includes('*'));
    if (exact !== undefined) {
      return importsEntryTargets(directory, exact[1], '');
    }
    const [pattern] = EffectArray.sort(
      entries.filter(([key]) => matchesSubpathPattern(key, specifier)),
      SubpathPatternOrder,
    );
    if (pattern === undefined) {
      return [];
    }
    const [key, target] = pattern;
    const star = key.indexOf('*');
    return importsEntryTargets(directory, target, specifier.slice(star, specifier.length - (key.length - star - 1)));
  };
  /** The packages a specifier written in `relative`, a file of `workspacePackage`, loads. */
  const referenceTargets = (
    workspacePackage: WorkspacePackage,
    relative: string,
    specifier: string,
  ): readonly (string | undefined)[] => {
    if (specifier.startsWith('.')) {
      return [owner(resolveRelativeSpecifier(relative, specifier))];
    }
    return specifier.startsWith('#')
      ? subpathImportTargets(workspacePackage, specifier)
      : [bareTarget(workspacePackage.directory, specifier)];
  };
  return { declaredTarget, referenceTargets };
};

/** Each listed source of a workspace package with its path relative to root. */
const packageSources = (
  root: string,
  listed: readonly string[],
  workspacePackage: WorkspacePackage,
): Effect.Effect<
  readonly (readonly [WorkspacePackage, string, string])[],
  PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* packageSourcesProgram() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* Effect.all(
      listedSources(listed, workspacePackage.directory, moduleSourceExtensions).map((file) =>
        fileSystem
          .readFileString(path.join(root, file), 'utf-8')
          .pipe(Effect.map((source) => [workspacePackage, file, source] as const)),
      ),
      { concurrency: 32 },
    );
  });

/** The package edge graph of the listed files of the tree at root, read from manifests and import specifiers only. */
const derivePackageGraph = (
  root: string,
  listing: SourceFileListing,
): Effect.Effect<PackageGraph, PlatformError, CheckServices> =>
  Effect.gen(function* derivePackageGraphProgram() {
    const path = yield* Path.Path;
    const listed = yield* listing(root);
    const packages = yield* listedWorkspacePackages(root, listed);
    const rootManifest = listed.includes('package.json') ? yield* readEdgeManifest(root, 'package.json') : {};
    const { declaredTarget, referenceTargets } = workspaceResolver(root, path, packages, rootManifest);
    const sitesByEdge = new Map<string, { readonly from: string; readonly sites: EdgeSite[]; readonly to: string }>();
    const recordSite = (from: string, to: string | undefined, site: EdgeSite): void => {
      if (to === undefined || to === from) {
        return;
      }
      const key = edgeKey(from, to);
      const edge = sitesByEdge.get(key) ?? { from, sites: [], to };
      edge.sites.push(site);
      sitesByEdge.set(key, edge);
    };

    for (const { directory, manifest } of packages) {
      for (const field of dependencyFields) {
        for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
          recordSite(directory, declaredTarget(directory, dependency, range), {
            class: field === 'devDependencies' ? 'test' : 'runtime',
            field,
            file: `${directory}/package.json`,
            line: 1,
          });
        }
      }
    }

    const sources = yield* Effect.all(
      packages.map((workspacePackage) => packageSources(root, listed, workspacePackage)),
      { concurrency: 4 },
    ).pipe(Effect.map((perPackage) => perPackage.flat()));
    const unparsable: string[] = [];
    for (const [workspacePackage, relative, source] of sources) {
      const references = moduleReferencesIn(relative, source);
      if (Option.isNone(references)) {
        unparsable.push(relative);
        continue;
      }
      const siteClass: EdgeClass = isTestSource(relative) ? 'test' : 'runtime';
      for (const { index, specifier } of references.value) {
        const line = sourceLine(source, index);
        for (const target of referenceTargets(workspacePackage, relative, specifier)) {
          recordSite(workspacePackage.directory, target, { class: siteClass, file: relative, line });
        }
      }
    }

    return {
      edges: new Map(
        [...sitesByEdge].map(([key, { from, sites, to }]): readonly [string, PackageEdge] => [
          key,
          {
            class: sites.some((site) => site.class === 'runtime') ? 'runtime' : 'test',
            from,
            sites: EffectArray.sort(sites, EdgeSiteOrder),
            to,
          },
        ]),
      ),
      packages: new Map(packages.map(({ directory, kind }) => [directory, kind] as const)),
      unparsable,
    };
  });

/** Rules 1 to 3: an edge from a module or a package to a module or an app is frozen. */
const isFrozenEdge = (graph: PackageGraph, edge: PackageEdge): boolean => {
  const from = graph.packages.get(edge.from);
  const to = graph.packages.get(edge.to);
  return (from === 'module' || from === 'package') && (to === 'module' || to === 'app');
};

const frozenEdges = (graph: PackageGraph): readonly PackageEdge[] =>
  EffectArray.sort(
    [...graph.edges.values()].filter((edge) => isFrozenEdge(graph, edge)),
    Order.mapInput(Order.String, (edge: PackageEdge) => edgeKey(edge.from, edge.to)),
  );

/** The files that make an edge: each manifest with its fields, each source with its lines. */
const describeSites = (edge: PackageEdge): string => {
  const details = new Map<string, string[]>();
  for (const { field, file, line } of edge.sites) {
    details.set(file, [...(details.get(file) ?? []), field ?? String(line)]);
  }
  return [...details]
    .map(([file, parts]) =>
      file.endsWith('/package.json') ? `${file} ${parts.join(', ')}` : `${file}:${parts.join(',')}`,
    )
    .join('; ');
};

const frozenEdgeRule = (graph: PackageGraph, edge: PackageEdge): string => {
  const from = graph.packages.get(edge.from);
  const to = graph.packages.get(edge.to);
  if (from === 'package') {
    return `A package under packages/ takes no edge to ${to === 'app' ? 'an app' : 'a module'}`;
  }
  return to === 'app' ? 'A module takes no edge to an app' : 'A module takes no edge to another module';
};

/** Wider classes admit more: a runtime edge also carries everything a test edge does. */
const classAdmits = (wider: EdgeClass, narrower: EdgeClass): boolean => wider === 'runtime' || narrower === 'test';

const readModuleEdgeBaseline = (
  root: string,
): Effect.Effect<Option.Option<readonly ModuleEdgeBaselineEntry[]>, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* readModuleEdgeBaselineProgram() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(root, moduleEdgeBaselineRelative);
    if (!(yield* fileSystem.exists(file))) {
      return Option.none();
    }
    const raw = yield* fileSystem.readFileString(file, 'utf-8');
    return Option.some(yield* Schema.decodeUnknownEffect(ModuleEdgeBaselineFromJson)(raw).pipe(Effect.orDie));
  });

const baselineViolation = (reason: string): LeanCoreDependencyViolation => ({
  file: moduleEdgeBaselineRelative,
  line: 1,
  reason,
});

const sameBaseline = (left: readonly ModuleEdgeBaselineEntry[], right: readonly ModuleEdgeBaselineEntry[]): boolean =>
  left.length === right.length &&
  left.every(
    (entry, index) =>
      entry.from === right[index]?.from && entry.to === right[index]?.to && entry.class === right[index]?.class,
  );

/** Runs a command whose output is not needed; its stderr reaches the console. */
const exitCodeOf = (command: string, args: readonly string[], cwd: string) =>
  Effect.gen(function* exitCodeOfProgram() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner.exitCode(
      ChildProcess.make(command, [...args], { cwd, stderr: 'inherit', stdin: 'ignore', stdout: 'ignore' }),
    );
  });

interface ShrinkOnlyResult {
  readonly summary: string;
  readonly violations: readonly LeanCoreDependencyViolation[];
}

const unreadableBase = (base: string, reason: string): ShrinkOnlyResult => ({
  summary: `Shrink-only rule failed: the comparison base ${base} cannot be read.`,
  violations: [
    baselineViolation(`The comparison base ${base} cannot be read (${reason}), so the shrink-only rule fails closed`),
  ],
});

/** Rule 5 against the comparison tree that root's commit `commit` extracted into `tree`. */
const checkShrinkOnlyAgainst = (
  commit: string,
  tree: string,
  baseline: readonly ModuleEdgeBaselineEntry[],
): Effect.Effect<ShrinkOnlyResult, PlatformError, CheckServices> =>
  Effect.gen(function* checkShrinkOnlyAgainstProgram() {
    const baseBaseline = yield* readModuleEdgeBaseline(tree);
    if (Option.isSome(baseBaseline) && sameBaseline(baseline, baseBaseline.value)) {
      return {
        summary: `Shrink-only rule: the baseline is the one at the comparison base ${commit}.`,
        violations: [],
      };
    }
    // The extracted archive holds exactly the base commit's tree, so every file in it is read.
    const baseGraph = yield* derivePackageGraph(tree, filesOnDisk);
    const violations = baseline.flatMap((entry): readonly LeanCoreDependencyViolation[] => {
      const edge = baseGraph.edges.get(edgeKey(entry.from, entry.to));
      if (edge === undefined) {
        return [
          baselineViolation(
            `Baseline entry ${edgeKey(entry.from, entry.to)} (${entry.class}) is not an edge of the comparison base ${commit}: the baseline only shrinks, so no new edge enters it`,
          ),
        ];
      }
      return classAdmits(edge.class, entry.class)
        ? []
        : [
            baselineViolation(
              `Baseline entry ${edgeKey(entry.from, entry.to)} is runtime, but the comparison base ${commit} has it only as test (${describeSites(edge)}): the baseline only shrinks, so no class widens`,
            ),
          ];
    });
    const baseState = Option.isSome(baseBaseline) ? 'a different baseline' : 'no baseline';
    const outcome =
      violations.length === 0 ? 'holds every baseline entry with the same or a wider class' : 'lacks what follows';
    return {
      summary: `Shrink-only rule: the comparison base ${commit} has ${baseState}, so its tree was derived and ${outcome}.`,
      violations,
    };
  });

/**
 * Rule 5. The base is read from an extracted copy of its tree (git archive into a temporary directory), so
 * it needs no install, and the head's derivation reads it. A base that cannot be read fails the check.
 */
const checkShrinkOnly = (
  root: string,
  base: string,
  baseline: readonly ModuleEdgeBaselineEntry[],
): Effect.Effect<ShrinkOnlyResult, never, CheckServices> =>
  Effect.scoped(
    Effect.gen(function* checkShrinkOnlyProgram() {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const commit = (yield* spawner.string(
        ChildProcess.make('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], {
          cwd: root,
          stderr: 'inherit',
          stdin: 'ignore',
        }),
      )).trim();
      if (!/^[0-9a-f]{40}$/u.test(commit)) {
        return unreadableBase(base, 'it names no commit of this repository');
      }
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: 'ontos-lean-core-base-' });
      const archive = path.join(directory, 'base.tar');
      const tree = path.join(directory, 'tree');
      yield* fileSystem.makeDirectory(tree);
      // Run from root, git archive holds exactly root's subtree of the commit, at the same relative paths.
      const archived = yield* exitCodeOf('git', ['archive', '--format=tar', `--output=${archive}`, commit], root);
      if (archived !== 0) {
        return unreadableBase(base, `git archive exited with ${archived}`);
      }
      const extracted = yield* exitCodeOf('tar', ['-x', '-f', archive, '-C', tree], root);
      if (extracted !== 0) {
        return unreadableBase(base, `tar exited with ${extracted}`);
      }
      return yield* checkShrinkOnlyAgainst(commit, tree, baseline);
    }),
  ).pipe(Effect.catchTag('PlatformError', (failure) => Effect.succeed(unreadableBase(base, failure.message))));

/** Groups of packages that reach each other over runtime edges, each sorted, largest first. */
const runtimeCycleGroups = (graph: PackageGraph): readonly (readonly string[])[] => {
  const successors = new Map<string, readonly string[]>();
  for (const edge of graph.edges.values()) {
    if (edge.class === 'runtime') {
      successors.set(edge.from, [...(successors.get(edge.from) ?? []), edge.to]);
    }
  }
  const reachableFrom = (start: string): ReadonlySet<string> => {
    const reached = new Set<string>();
    const pending = [...(successors.get(start) ?? [])];
    while (pending.length > 0) {
      const next = pending.pop();
      if (next === undefined || reached.has(next)) {
        continue;
      }
      reached.add(next);
      pending.push(...(successors.get(next) ?? []));
    }
    return reached;
  };
  const nodes = EffectArray.sort([...graph.packages.keys()], Order.String);
  const reachable = new Map(nodes.map((node) => [node, reachableFrom(node)] as const));
  const grouped = new Set<string>();
  const groups: (readonly string[])[] = [];
  for (const node of nodes) {
    if (grouped.has(node) || !(reachable.get(node)?.has(node) ?? false)) {
      continue;
    }
    const group = nodes.filter(
      (other) => (reachable.get(node)?.has(other) ?? false) && (reachable.get(other)?.has(node) ?? false),
    );
    for (const member of group) {
      grouped.add(member);
    }
    groups.push(group);
  }
  return EffectArray.sort(
    groups,
    Order.combine(
      Order.mapInput(Order.flip(Order.Number), (group: readonly string[]) => group.length),
      Order.mapInput(Order.String, (group: readonly string[]) => group[0] ?? ''),
    ),
  );
};

export interface ModuleEdgeFreezeReport {
  readonly cycleGroups: readonly (readonly string[])[];
  readonly frozenEdgeCounts: Readonly<Record<EdgeClass, number>>;
  readonly shrinkOnly: string;
  readonly violations: readonly LeanCoreDependencyViolation[];
}

/** Rules 1 to 4 against the tree at root, and rule 5 when the run's comparison base is given. */
export const checkModuleEdgeFreeze = (
  root: string,
  options: { readonly base?: string | undefined; readonly files: SourceFileListing },
): Effect.Effect<ModuleEdgeFreezeReport, PlatformError, CheckServices> =>
  Effect.gen(function* checkModuleEdgeFreezeProgram() {
    const graph = yield* derivePackageGraph(root, options.files);
    const baseline = Option.getOrElse(
      yield* readModuleEdgeBaseline(root),
      (): readonly ModuleEdgeBaselineEntry[] => [],
    );
    const frozen = frozenEdges(graph);
    const listed = new Map(baseline.map((entry) => [edgeKey(entry.from, entry.to), entry] as const));
    const violations: LeanCoreDependencyViolation[] = graph.unparsable.map((file) => ({
      file,
      line: 1,
      reason: 'Workspace source does not parse, so the package edges it makes are unknown',
    }));

    const unordered = baseline.findIndex((entry, index) => {
      const previous = baseline[index - 1];
      return previous !== undefined && BaselineEntryOrder(previous, entry) !== -1;
    });
    if (unordered !== -1) {
      violations.push(
        baselineViolation(
          `Baseline entry ${unordered + 1} is out of order or repeats an edge: entries are sorted by from, then to, one per edge`,
        ),
      );
    }

    for (const edge of frozen) {
      const entry = listed.get(edgeKey(edge.from, edge.to));
      if (entry !== undefined && classAdmits(entry.class, edge.class)) {
        continue;
      }
      const [first] = edge.sites;
      const listedAs = entry === undefined ? 'does not list it' : `lists it only as ${entry.class}`;
      violations.push({
        file: first?.file ?? moduleEdgeBaselineRelative,
        line: first?.line ?? 1,
        reason: `${frozenEdgeRule(graph, edge)} unless ${moduleEdgeBaselineRelative} lists it: ${edgeKey(edge.from, edge.to)} is a ${edge.class} edge and the baseline ${listedAs}; made by ${describeSites(edge)}`,
      });
    }

    for (const entry of baseline) {
      const edge = graph.edges.get(edgeKey(entry.from, entry.to));
      if (edge === undefined || !isFrozenEdge(graph, edge)) {
        violations.push(
          baselineViolation(
            `Baseline entry ${edgeKey(entry.from, entry.to)} (${entry.class}) is no frozen edge of the tree any more: remove it`,
          ),
        );
      } else if (entry.class === 'runtime' && edge.class === 'test') {
        violations.push(
          baselineViolation(
            `Baseline entry ${edgeKey(entry.from, entry.to)} is ${entry.class}, but the tree has it only as ${edge.class} (${describeSites(edge)}): change its class to ${edge.class}`,
          ),
        );
      }
    }

    const shrinkOnly =
      options.base === undefined
        ? {
            summary:
              'Shrink-only rule not run: no --base names the comparison base (required CI passes the one its planner computed).',
            violations: [],
          }
        : yield* checkShrinkOnly(root, options.base, baseline);

    return {
      cycleGroups: runtimeCycleGroups(graph),
      frozenEdgeCounts: {
        runtime: frozen.filter((edge) => edge.class === 'runtime').length,
        test: frozen.filter((edge) => edge.class === 'test').length,
      },
      shrinkOnly: shrinkOnly.summary,
      violations: EffectArray.sort([...violations, ...shrinkOnly.violations], ViolationOrder),
    };
  });

class LeanCoreDependencyCheckFailed extends Schema.TaggedError<LeanCoreDependencyCheckFailed>()(
  'LeanCoreDependencyCheckFailed',
  { violationCount: Schema.Number },
) {}

const printModuleEdgeFreeze = (report: ModuleEdgeFreezeReport) =>
  Effect.gen(function* printModuleEdgeFreezeProgram() {
    const { runtime, test } = report.frozenEdgeCounts;
    yield* Console.log(
      `Frozen package edges into modules and apps: ${runtime + test} (${runtime} runtime, ${test} test), listed in ${moduleEdgeBaselineRelative}.`,
    );
    yield* Console.log(`Runtime cycle groups: ${report.cycleGroups.length}`);
    yield* Effect.all(
      report.cycleGroups.map((group) => Console.log(`  ${group.length} packages: ${group.join(', ')}`)),
      { concurrency: 1, discard: true },
    );
    yield* Console.log(report.shrinkOnly);
  });

const main = (base: Option.Option<string>) =>
  Effect.gen(function* leanCoreDependencyMain() {
    const path = yield* Path.Path;
    const root = path.resolve(process.cwd());
    // The check judges the commit: the files Git tracks, never what a step beside it writes meanwhile.
    const leanCoreViolations = yield* checkLeanCoreDependencies(root, trackedFiles);
    const freeze = yield* checkModuleEdgeFreeze(root, { base: Option.getOrUndefined(base), files: trackedFiles });
    yield* printModuleEdgeFreeze(freeze);
    const violations = [...leanCoreViolations, ...freeze.violations];
    if (violations.length > 0) {
      yield* Effect.all(
        violations.map((violation) => Console.error(`${violation.file}:${violation.line}: ${violation.reason}`)),
        { concurrency: 1, discard: true },
      );
      return yield* Effect.fail(new LeanCoreDependencyCheckFailed({ violationCount: violations.length }));
    }
    return yield* Console.log('Lean-Core dependency boundaries verified');
  });

// `--base` names the run's comparison base; without it the shrink-only rule reports that it did not run.
const command = Command.make(
  'check-lean-core-dependencies',
  { base: Flag.String('base').pipe(Flag.optional) },
  ({ base }) => main(base),
);

const [, invokedPath] = process.argv;
if (invokedPath === import.meta.filename) {
  const leanCoreDependencyRuntime = ManagedRuntime.make(NodeServices.layer);
  // A failure that is not a listed violation (a file that cannot be read, a manifest that does not decode)
  // would otherwise end the run with exit code 1 and no line saying why.
  const exit = await leanCoreDependencyRuntime.runPromiseExit(
    Command.run(command, { version: '1.0.0' }).pipe(Effect.tapCause((cause) => Console.error(Cause.pretty(cause)))),
  );
  process.exitCode = Exit.isSuccess(exit) ? 0 : 1;
}
