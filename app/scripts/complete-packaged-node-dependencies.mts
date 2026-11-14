#!/usr/bin/env node
/**
 * Completes the static ESM dependency closure of a packaged unit from the declared installs that produced it.
 *
 * `modern deploy` traces packages with `@vercel/nft`, which analyses CommonJS. A package whose `import` target is
 * a different file from its `require` target therefore arrives with only the CommonJS file, and an ESM import of
 * it cannot load. This step follows the static ESM graph that starts at the unit's own modules:
 *
 *   - every static `import` / `export ... from` specifier is resolved by one native Node process running
 *     `import.meta.resolve(specifier, parent)` under `--experimental-import-meta-resolve`, so the target keeps
 *     Node's conditions, `exports` map and package-scope rules, and a missing target still reports its path;
 *   - a missing target inside a traced package is copied from that package's declared install, found from the
 *     package that declares it. The package name, version and module type must agree, and every carried file must
 *     match that install byte for byte;
 *   - a target that resolves outside the packaged output, or that no traced package exports, fails the build. The
 *     packaged tree never falls back to an ancestor workspace or a guessed global install.
 *
 * The walk starts from the unit's own modules and from the ES module entries every packaged workspace package the unit
 * declares exports, because a consumer loads those by import whether or not the unit's graph reaches them.
 *
 * Only missing `.js`, `.mjs`, `.cjs` and `.json` files are copied, each at its own path inside its package, so a
 * module reached through two entries stays one instance. CommonJS `require` edges are not walked: the trace already
 * analysed them. Dynamic `import()` edges are not walked either, because they do not link at load time.
 *
 *   node scripts/complete-packaged-node-dependencies.mts <unit directory> [...]
 */
import { findPackageJSON } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Console, Effect, FileSystem, Layer, Option, Predicate, Schema } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { Argument, Command } from 'effect/cli';
import { parseSync, Visitor } from 'oxc-parser';

import { PACKAGED_DIRECTORY, WORKSPACE_PACKAGE_SCOPE } from './materialize-packaged-workspace-packages.mts';
import {
  makePackagedDependencyResolver,
  memoizeDependencyRead,
  PackagedNodeDependencyError,
} from './packaged-node-dependency-resolver.mts';
import type { ResolverResult } from './packaged-node-dependency-resolver.mts';

export { PackagedNodeDependencyError } from './packaged-node-dependency-resolver.mts';

const PACKAGE_MANIFEST = 'package.json';
const NODE_MODULES = 'node_modules';
const DEFAULT_MODULE_TYPE = 'commonjs';
const ES_MODULE_EXTENSION = '.mjs';

/** The files a static ESM graph starts from or reaches; only these may be scanned for `import` edges. */
const SCANNED_EXTENSIONS = new Set(['.js', '.mjs']);
/** The runtime files this step copies from a declared install. TypeScript belongs to the compile step. */
const COPYABLE_EXTENSIONS = new Set(['.cjs', '.js', '.json', '.mjs']);
const TYPESCRIPT_EXTENSIONS = new Set(['.cts', '.mts', '.ts', '.tsx']);

const failed = (message: string) => new PackagedNodeDependencyError({ message });
const FILE_CONCURRENCY = 16;

const PackageManifestSchema = Schema.StructWithRest(
  Schema.Struct({
    dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    exports: Schema.optionalKey(Schema.Json),
    name: Schema.String,
    optionalDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    peerDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    type: Schema.optionalKey(Schema.String),
    version: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, unknown>>;
  readonly exports?: Schema.Json;
  readonly name: string;
  readonly optionalDependencies?: Readonly<Record<string, unknown>>;
  readonly peerDependencies?: Readonly<Record<string, unknown>>;
  readonly type?: string;
  readonly version: string;
}
const packageManifestCodec = Schema.fromJsonString(PackageManifestSchema);

export interface NodeDependencyCompletionOptions {
  /**
   * Unit-relative modules to start the walk from. They must lie outside the traced `node_modules`, because a package
   * file has no declaring owner until an entry reaches it. Default: every `.js`/`.mjs` the unit carries outside it, and
   * the ES module entries of the workspace packages it declares.
   */
  readonly roots?: readonly string[];
}

export interface NodeDependencyCompletion {
  /** Unit-relative paths of the files copied from declared installs, sorted as before. */
  readonly copied: readonly string[];
  readonly metrics: CompletionMetrics;
}

interface CompletionMetrics {
  rootsMs: number;
  scanMs: number;
  resolveMs: number;
  followMs: number;
  verifyMs: number;
  totalMs: number;
  waves: number;
  scannedFiles: number;
  edges: number;
  manifestReads: number;
  canonicalReads: number;
  sourceResolutions: number;
  verifiedPackages: number;
  verifiedFiles: number;
  resolverBatches: number;
  resolverRequests: number;
  resolverCacheHits: number;
}

interface DependencyReads {
  readonly canonical: (file: string) => Effect.Effect<string, PlatformError, FileSystem.FileSystem>;
  readonly manifest: (
    file: string,
  ) => Effect.Effect<PackageManifest, PackagedNodeDependencyError, FileSystem.FileSystem>;
  readonly sources: Map<string, ResolvedSource>;
  readonly metrics: CompletionMetrics;
}

interface ResolvedSource {
  readonly declared: ReadonlySet<string>;
  readonly directory: string;
  readonly manifest: PackageManifest;
}

/** The package whose manifest declares the dependencies a module imports. */
interface DeclaringOwner {
  readonly declared: ReadonlySet<string>;
  readonly manifest: string;
  readonly name: string;
}

/** A packaged package whose identity and carried files have been verified against its declared install. */
interface VerifiedSource {
  readonly declared: ReadonlySet<string>;
  readonly directory: string;
  readonly name: string;
}

interface Edge {
  readonly importer: string;
  readonly owner: DeclaringOwner;
  readonly specifier: string;
}

interface CompletionContext {
  readonly copied: string[];
  readonly output: string;
  readonly sources: Map<string, VerifiedSource>;
  readonly targets: Map<string, string | null>;
  readonly unit: string;
  readonly unitOwner: DeclaringOwner;
  readonly reads: DependencyReads;
}

const isInside = (directory: string, candidate: string): boolean => {
  const relative = path.relative(directory, candidate);
  return relative !== '' && relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative);
};

const isNodeModulesName = (name: string): boolean => name === NODE_MODULES;

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  Buffer.from(left.buffer, left.byteOffset, left.byteLength).equals(
    Buffer.from(right.buffer, right.byteOffset, right.byteLength),
  );

const moduleTypeOf = (manifest: PackageManifest): string => manifest.type ?? DEFAULT_MODULE_TYPE;

const declaredNames = (manifest: PackageManifest): ReadonlySet<string> =>
  new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);

/** The path of `file` with every symlink in it resolved, including for a path that does not exist yet. */
const canonicalPath = Effect.fn('CompletePackagedNodeDependencies.canonicalPath')(function* canonicalPath(
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const missing: string[] = [];
  let existing = file;
  while (!(yield* fs.exists(existing))) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      return yield* Effect.succeed(file);
    }
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return yield* Effect.succeed(path.join(yield* fs.realPath(existing), ...missing));
});

const makeDependencyReads = (): DependencyReads => {
  const metrics: CompletionMetrics = {
    rootsMs: 0,
    scanMs: 0,
    resolveMs: 0,
    followMs: 0,
    verifyMs: 0,
    totalMs: 0,
    waves: 0,
    scannedFiles: 0,
    edges: 0,
    manifestReads: 0,
    canonicalReads: 0,
    sourceResolutions: 0,
    verifiedPackages: 0,
    verifiedFiles: 0,
    resolverBatches: 0,
    resolverRequests: 0,
    resolverCacheHits: 0,
  };
  return {
    canonical: memoizeDependencyRead((file) => {
      metrics.canonicalReads += 1;
      return canonicalPath(file);
    }),
    manifest: memoizeDependencyRead((file) => {
      metrics.manifestReads += 1;
      return readManifest(file);
    }),
    metrics,
    sources: new Map(),
  };
};

const readManifest = Effect.fn('CompletePackagedNodeDependencies.readManifest')(function* readManifest(
  manifestPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(manifestPath)
    .pipe(Effect.mapError(() => failed(`${manifestPath}: the package manifest cannot be read`)));
  return yield* Schema.decodeUnknownEffect(packageManifestCodec)(text).pipe(
    Effect.mapError((cause) => failed(`${manifestPath}: ${String(cause)}`)),
  );
});

const directoryEntries = Effect.fn('CompletePackagedNodeDependencies.directoryEntries')(function* directoryEntries(
  directory: string,
  skip: (name: string) => boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.forEach(
    (yield* fs.readDirectory(directory)).toSorted().filter((name) => !skip(name)),
    (name) => {
      const file = path.join(directory, name);
      return fs.lstat(file).pipe(Effect.map((info) => ({ file, type: info.type })));
    },
    { concurrency: FILE_CONCURRENCY },
  );
});

/** Sorted depth-first order is unchanged; only the independent metadata reads overlap. */
const walkFiles = (directory: string, skip: (name: string) => boolean) =>
  Effect.gen(function* collectFiles() {
    const files: string[] = [];
    const visit = (current: string): Effect.Effect<void, PlatformError> =>
      Effect.gen(function* visitDirectory() {
        for (const entry of yield* directoryEntries(current, skip)) {
          if (entry.type === 'Directory') {
            yield* visit(entry.file);
          } else if (entry.type === 'File') {
            files.push(entry.file);
          }
        }
        return yield* Effect.void;
      });
    yield* visit(directory);
    return yield* Effect.succeed(files);
  });

/**
 * The package directory a traced file belongs to: the innermost `node_modules/<name>` (or `node_modules/@scope/<name>`)
 * that contains it. Node's own package boundary, so a nested install of another version stays its own package.
 * Returns `undefined` for a module the unit carries outside its traced `node_modules`.
 */
const packageRootOf = (output: string, file: string): string | undefined => {
  const tracedNodeModules = path.join(output, NODE_MODULES);
  if (!isInside(tracedNodeModules, file)) {
    return undefined;
  }
  const segments = path.relative(output, file).split(path.sep);
  let boundary = segments.length - 2;
  while (boundary >= 0 && segments[boundary] !== NODE_MODULES) {
    boundary -= 1;
  }
  const nameLength = segments[boundary + 1]?.startsWith('@') ? 2 : 1;
  return path.join(output, ...segments.slice(0, boundary + 1 + nameLength));
};

/** Every static `import`/`export ... from` specifier of one module. Dynamic `import()` is not linked at load time. */
const staticSpecifiers = Effect.fn('CompletePackagedNodeDependencies.staticSpecifiers')(function* staticSpecifiers(
  file: string,
  code: string,
) {
  const parsed = parseSync(file, code, { lang: 'js', sourceType: 'module' });
  if (parsed.errors.length > 0) {
    // A script-mode CommonJS file has no static ESM edge to follow; a broken `.mjs` is a real failure.
    if (path.extname(file) === ES_MODULE_EXTENSION) {
      return yield* Effect.fail(failed(`${file}: the ES module does not parse`));
    }
    return yield* Effect.succeed([]);
  }
  const specifiers: string[] = [];
  const record = (literal: { readonly value?: unknown } | null | undefined) => {
    if (literal !== null && literal !== undefined && Predicate.isString(literal.value)) {
      specifiers.push(literal.value);
    }
  };
  new Visitor({
    ExportAllDeclaration: (node) => record(node.source),
    ExportNamedDeclaration: (node) => record(node.source),
    ImportDeclaration: (node) => record(node.source),
  }).visit(parsed.program);
  return yield* Effect.succeed(specifiers);
});

/** Conditions whose `exports` targets no ES module importer of the packaged tree selects. */
const NON_IMPORT_CONDITIONS = new Set(['require', 'types']);

/** Every `./` target an `exports` value can select for an import, in its declared order. */
const isJsonObject = Schema.is(Schema.JsonObject);
const exportTargets = (value: Schema.Json | undefined): readonly string[] => {
  if (Predicate.isString(value)) {
    return value.startsWith('./') ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry: Schema.Json) => exportTargets(entry));
  }
  if (isJsonObject(value)) {
    return Object.entries(value).flatMap(([condition, nested]) =>
      NON_IMPORT_CONDITIONS.has(condition) ? [] : exportTargets(nested),
    );
  }
  return [];
};

/**
 * The compiled ES module entries of each packaged workspace package the unit declares, as the packaged manifest's
 * `exports` names them (materialize repoints them at the compiled modules). A consumer loads these by import, so they
 * are walk roots even when the unit's own graph never reaches them. Undeclared packages are not roots: they are
 * verified only when a declaring package imports them.
 */
const workspaceExportRoots = Effect.fn('CompletePackagedNodeDependencies.workspaceExportRoots')(
  function* workspaceExportRoots(output: string, declared: ReadonlySet<string>, reads: DependencyReads) {
    const fs = yield* FileSystem.FileSystem;
    const scope = path.join(output, NODE_MODULES, WORKSPACE_PACKAGE_SCOPE);
    if (!(yield* fs.exists(scope))) {
      return yield* Effect.succeed([]);
    }
    const roots: string[] = [];
    for (const name of (yield* fs.readDirectory(scope)).toSorted()) {
      const packageRoot = path.join(scope, name);
      const manifest = yield* reads.manifest(path.join(packageRoot, PACKAGE_MANIFEST));
      if (!declared.has(manifest.name)) {
        continue;
      }
      for (const target of exportTargets(manifest.exports)) {
        const file = yield* reads.canonical(path.join(packageRoot, target));
        if (isInside(packageRoot, file) && SCANNED_EXTENSIONS.has(path.extname(file)) && (yield* fs.exists(file))) {
          roots.push(file);
        }
      }
    }
    return yield* Effect.succeed(roots);
  },
);

/** The declared install of `name` that `owner` resolves, from the owner's own real location. */
const resolveDeclaredSource = Effect.fn('CompletePackagedNodeDependencies.resolveDeclaredSource')(
  function* resolveDeclaredSource(reads: DependencyReads, owner: DeclaringOwner, name: string) {
    const key = `${owner.manifest}\0${name}`;
    const cached = reads.sources.get(key);
    if (cached !== undefined) {
      return yield* Effect.succeed(cached);
    }
    reads.metrics.sourceResolutions += 1;
    // A catalog alias is declared under its alias, so the owner's own installs decide which declared name is `name`.
    const specifiers = owner.declared.has(name) ? [name] : [...owner.declared];
    for (const specifier of specifiers) {
      const sourceManifest = Option.getOrUndefined(
        yield* Effect.option(
          Effect.try({ catch: () => null, try: () => findPackageJSON(specifier, pathToFileURL(owner.manifest)) }),
        ),
      );
      if (sourceManifest === undefined) {
        continue;
      }
      const directory = yield* reads
        .canonical(path.dirname(sourceManifest))
        .pipe(Effect.mapError(() => failed(`${name}: its declared install cannot be resolved to a real directory`)));
      const manifest = yield* reads.manifest(path.join(directory, PACKAGE_MANIFEST));
      if (manifest.name === name) {
        const resolved = { declared: declaredNames(manifest), directory, manifest };
        reads.sources.set(key, resolved);
        return yield* Effect.succeed(resolved);
      }
    }
    return yield* Effect.fail(failed(`${name}: ${owner.name} declares no install of it, so its install is not copied`));
  },
);

/** Every file of a traced third-party package matches its declared install byte for byte. */
const verifyCarriedFile = Effect.fn('CompletePackagedNodeDependencies.verifyCarriedFile')(function* verifyCarriedFile(
  reads: DependencyReads,
  packageRoot: string,
  sourceDirectory: string,
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const relative = path.relative(packageRoot, file);
  if (relative === PACKAGE_MANIFEST) {
    // The traced manifest is rewritten by the packaging step (`exports`, `publishConfig`); its identity is checked.
    return yield* Effect.void;
  }
  const declaredFile = path.join(sourceDirectory, relative);
  if (!(yield* fs.exists(declaredFile))) {
    return yield* Effect.fail(
      failed(`${file}: the traced package carries a file its declared install does not contain`),
    );
  }
  const real = yield* reads.canonical(declaredFile);
  if (!isInside(sourceDirectory, real)) {
    return yield* Effect.fail(failed(`${declaredFile}: the declared install's file resolves outside its package`));
  }
  const [carried, declared] = yield* Effect.all([fs.readFile(file), fs.readFile(real)], { concurrency: 2 });
  if (!sameBytes(carried, declared)) {
    return yield* Effect.fail(failed(`${file}: differs from the declared install's ${relative}`));
  }
  reads.metrics.verifiedFiles += 1;
  return yield* Effect.void;
});

const verifyCarriedFiles = Effect.fn('CompletePackagedNodeDependencies.verifyCarriedFiles')(
  function* verifyCarriedFiles(reads: DependencyReads, packageRoot: string, sourceDirectory: string) {
    const started = performance.now();
    yield* Effect.forEach(
      yield* walkFiles(packageRoot, isNodeModulesName),
      (file) => verifyCarriedFile(reads, packageRoot, sourceDirectory, file),
      { concurrency: FILE_CONCURRENCY, discard: true },
    );
    reads.metrics.verifyMs += performance.now() - started;
    return yield* Effect.void;
  },
);

/**
 * Verifies a traced package against the install its owner declares, and records it. A second owner must resolve the
 * same install, so two declaring packages never see two copies of one package.
 */
const ensureVerifiedSource = Effect.fn('CompletePackagedNodeDependencies.ensureVerifiedSource')(
  function* ensureVerifiedSource(context: CompletionContext, packageRoot: string, owner: DeclaringOwner) {
    const packaged = yield* context.reads.manifest(path.join(packageRoot, PACKAGE_MANIFEST));
    const resolved = yield* resolveDeclaredSource(context.reads, owner, packaged.name);
    const existing = context.sources.get(packageRoot);
    if (existing !== undefined) {
      if (existing.directory !== resolved.directory) {
        return yield* Effect.fail(
          failed(`${packaged.name}: two declaring packages resolve different installs; the packaged tree keeps one`),
        );
      }
      return yield* Effect.succeed(existing);
    }
    if (resolved.manifest.version !== packaged.version) {
      return yield* Effect.fail(
        failed(
          `${packaged.name}: the traced version ${packaged.version} differs from the declared install ${resolved.manifest.version}`,
        ),
      );
    }
    if (moduleTypeOf(resolved.manifest) !== moduleTypeOf(packaged)) {
      return yield* Effect.fail(
        failed(`${packaged.name}: the traced module type differs from the declared install's module type`),
      );
    }
    // Workspace packages are compiled by the TypeScript step, which verifies their sources itself.
    if (!packaged.name.startsWith(`${WORKSPACE_PACKAGE_SCOPE}/`)) {
      yield* verifyCarriedFiles(context.reads, packageRoot, resolved.directory);
    }
    const source: VerifiedSource = { declared: resolved.declared, directory: resolved.directory, name: packaged.name };
    context.sources.set(packageRoot, source);
    context.reads.metrics.verifiedPackages += 1;
    return yield* Effect.succeed(source);
  },
);

/** Creates each missing directory between a package root and a file, refusing a symlink on the way. */
const ensurePackagedParents = Effect.fn('CompletePackagedNodeDependencies.ensurePackagedParents')(
  function* ensurePackagedParents(packageRoot: string, target: string) {
    const fs = yield* FileSystem.FileSystem;
    let directory = packageRoot;
    for (const segment of path.relative(packageRoot, path.dirname(target)).split(path.sep)) {
      if (segment === '') {
        continue;
      }
      directory = path.join(directory, segment);
      if (yield* fs.exists(directory)) {
        if ((yield* fs.lstat(directory)).type !== 'Directory') {
          yield* Effect.fail(failed(`${directory}: a packaged directory must not be a symlink`));
        }
      } else {
        yield* fs.makeDirectory(directory);
      }
    }
    return yield* Effect.void;
  },
);

/** Copies one missing runtime file from its package's verified declared install, at the same path inside it. */
const completeMissingFile = Effect.fn('CompletePackagedNodeDependencies.completeMissingFile')(
  function* completeMissingFile(source: VerifiedSource, packageRoot: string, target: string, reference: string) {
    const fs = yield* FileSystem.FileSystem;
    const extension = path.extname(target);
    if (TYPESCRIPT_EXTENSIONS.has(extension)) {
      yield* Effect.fail(failed(`${reference}: ${target} is TypeScript; the compile step completes it`));
    }
    if (!COPYABLE_EXTENSIONS.has(extension)) {
      yield* Effect.fail(failed(`${reference}: ${target} is not a runtime file this step completes`));
    }
    const relative = path.relative(packageRoot, target);
    const declaredFile = path.join(source.directory, relative);
    if (!(yield* fs.exists(declaredFile))) {
      yield* Effect.fail(
        failed(`${reference}: ${source.name} is traced without ${relative}, and its declared install has no such file`),
      );
    }
    const real = yield* fs.realPath(declaredFile);
    if (!isInside(source.directory, real) || (yield* fs.lstat(real)).type !== 'File') {
      yield* Effect.fail(failed(`${declaredFile}: the declared install's file is not a regular file in its package`));
    }
    yield* ensurePackagedParents(packageRoot, target);
    yield* fs.writeFile(target, yield* fs.readFile(real));
    return yield* Effect.void;
  },
);

/** The owner of the packages `file` imports: its own package's verified declared install, or the unit. */
const ownerOf = Effect.fn('CompletePackagedNodeDependencies.ownerOf')(function* ownerOf(
  context: CompletionContext,
  file: string,
) {
  const packageRoot = packageRootOf(context.output, file);
  if (packageRoot === undefined) {
    return yield* Effect.succeed(context.unitOwner);
  }
  // A package reached without an import edge is a workspace export root, which only the unit's declaration can verify.
  const source =
    context.sources.get(packageRoot) ?? (yield* ensureVerifiedSource(context, packageRoot, context.unitOwner));
  return yield* Effect.succeed({
    declared: source.declared,
    manifest: path.join(source.directory, PACKAGE_MANIFEST),
    name: source.name,
  });
});

/** Follows one resolved edge. Returns the module to scan next, if this edge reached one. */
const followEdge = Effect.fn('CompletePackagedNodeDependencies.followEdge')(function* followEdge(
  context: CompletionContext,
  edge: Edge,
  result: ResolverResult,
) {
  const fs = yield* FileSystem.FileSystem;
  const reference = `${path.relative(context.unit, edge.importer)} imports ${edge.specifier}`;
  if (result.url === undefined) {
    return yield* Effect.fail(failed(`${reference}: ${result.message ?? result.code ?? 'does not resolve'}`));
  }
  // `node:` builtins and other non-file schemes are not part of the packaged tree.
  if (!result.url.startsWith('file:')) {
    return yield* Effect.succeed(null);
  }
  const target = yield* context.reads.canonical(fileURLToPath(result.url));
  if (!isInside(context.output, target)) {
    return yield* Effect.fail(
      failed(
        `${reference}: resolves to ${target}, outside the packaged output; the packaged tree does not fall back to an ancestor install`,
      ),
    );
  }
  const importerRoot = packageRootOf(context.output, edge.importer);
  const targetRoot = packageRootOf(context.output, target);
  if (importerRoot !== targetRoot) {
    if (targetRoot === undefined) {
      return yield* Effect.fail(failed(`${reference}: leaves its package for the unit-level module ${target}`));
    }
    yield* ensureVerifiedSource(context, targetRoot, edge.owner);
  }
  // Only skip target I/O AFTER checking this edge's declaring owner, including a second, conflicting owner.
  const completed = context.targets.get(target);
  if (completed !== undefined) {
    return yield* Effect.succeed(completed);
  }
  const extension = path.extname(target);
  const scan = SCANNED_EXTENSIONS.has(extension) ? target : null;
  if (yield* fs.exists(target)) {
    if ((yield* fs.lstat(target)).type !== 'File') {
      return yield* Effect.fail(failed(`${reference}: ${target} is not a file`));
    }
    context.targets.set(target, scan);
    return yield* Effect.succeed(scan);
  }
  if (targetRoot === undefined) {
    return yield* Effect.fail(failed(`${reference}: the unit-level module ${target} is missing from the unit`));
  }
  const source = context.sources.get(targetRoot);
  if (source === undefined) {
    return yield* Effect.fail(failed(`${reference}: ${target} has no verified declared install`));
  }
  yield* completeMissingFile(source, targetRoot, target, reference);
  context.copied.push(path.relative(context.unit, target));
  context.targets.set(target, scan);
  return yield* Effect.succeed(scan);
});

/**
 * Completes the static ESM closure of one packaged unit. Idempotent: a closure that already loads reports nothing to
 * copy. Waves share one native Node process and immutable reads, but every distinct declaring owner is still checked.
 */
export const completePackagedNodeDependencies = Effect.fn('CompletePackagedNodeDependencies.complete')(
  function* completePackagedNodeDependencies(unitDirectory: string, options: NodeDependencyCompletionOptions = {}) {
    const started = performance.now();
    const reads = makeDependencyReads();
    const fs = yield* FileSystem.FileSystem;
    // Canonical from the start: every path this step compares, reports, or writes is a real path, as Node sees it.
    const unit = yield* reads.canonical(path.resolve(unitDirectory));
    const outputPath = path.join(unit, PACKAGED_DIRECTORY);
    if (!(yield* fs.exists(outputPath))) {
      return yield* Effect.fail(failed(`${outputPath}: there is no packaged output to complete`));
    }
    const output = yield* fs.realPath(outputPath);
    const unitManifest = yield* reads.manifest(path.join(unit, PACKAGE_MANIFEST));
    const context: CompletionContext = {
      copied: [],
      reads,
      output,
      sources: new Map(),
      targets: new Map(),
      unit,
      unitOwner: {
        declared: declaredNames(unitManifest),
        manifest: path.join(unit, PACKAGE_MANIFEST),
        name: unitManifest.name,
      },
    };

    const roots: string[] = [];
    if (options.roots === undefined) {
      for (const file of yield* walkFiles(output, isNodeModulesName)) {
        if (SCANNED_EXTENSIONS.has(path.extname(file))) {
          roots.push(file);
        }
      }
      roots.push(...(yield* workspaceExportRoots(output, context.unitOwner.declared, reads)));
    } else {
      for (const root of options.roots) {
        const file = yield* reads.canonical(path.resolve(unit, root));
        if (!(yield* fs.exists(file))) {
          return yield* Effect.fail(failed(`${root}: the root module does not exist`));
        }
        if (!isInside(output, file) || packageRootOf(output, file) !== undefined) {
          return yield* Effect.fail(
            failed(`${root}: a root must be a unit-level module outside the traced node_modules`),
          );
        }
        roots.push(file);
      }
    }

    reads.metrics.rootsMs = performance.now() - started;
    const resolverStarted = performance.now();
    const resolver = yield* makePackagedDependencyResolver(output);
    reads.metrics.resolveMs += performance.now() - resolverStarted;
    const visited = new Set<string>();
    let wave = [...new Set(roots)];
    while (wave.length > 0) {
      const files = [...new Set(wave)].filter((file) => !visited.has(file));
      reads.metrics.waves += 1;
      reads.metrics.scannedFiles += files.length;
      const scanStarted = performance.now();
      for (const file of files) {
        visited.add(file);
      }
      const edges: Edge[] = [];
      for (const file of files) {
        const owner = yield* ownerOf(context, file);
        for (const specifier of yield* staticSpecifiers(file, yield* fs.readFileString(file))) {
          edges.push({ importer: file, owner, specifier });
        }
      }
      reads.metrics.scanMs += performance.now() - scanStarted;
      reads.metrics.edges += edges.length;
      if (edges.length === 0) {
        break;
      }
      const resolveStarted = performance.now();
      const results = yield* resolver.resolve(
        edges.map((edge) => ({ parent: pathToFileURL(edge.importer).href, specifier: edge.specifier })),
      );
      reads.metrics.resolveMs += performance.now() - resolveStarted;
      const followStarted = performance.now();
      const next: string[] = [];
      for (const [index, edge] of edges.entries()) {
        const result = results[index];
        if (result === undefined) {
          return yield* Effect.fail(
            failed(`${edge.importer}: the Node resolver returned no answer for ${edge.specifier}`),
          );
        }
        const scan = yield* followEdge(context, edge, result);
        if (scan !== null && !visited.has(scan)) {
          next.push(scan);
        }
      }
      reads.metrics.followMs += performance.now() - followStarted;
      wave = next;
    }
    yield* resolver.close;
    reads.metrics.resolverBatches = resolver.stats.batches;
    reads.metrics.resolverRequests = resolver.stats.requests;
    reads.metrics.resolverCacheHits = resolver.stats.cacheHits;
    reads.metrics.totalMs = performance.now() - started;
    return yield* Effect.succeed({
      copied: context.copied.toSorted(),
      metrics: reads.metrics,
    } satisfies NodeDependencyCompletion);
  },
  Effect.scoped,
);

const reportUnit = Effect.fn('CompletePackagedNodeDependencies.reportUnit')(function* reportUnit(
  unitDirectory: string,
) {
  const completion = yield* completePackagedNodeDependencies(unitDirectory);
  yield* Console.log(`${unitDirectory}: completed ${completion.copied.length} packaged Node dependency files`);
  const m = completion.metrics;
  yield* Console.log(
    `${unitDirectory}: packaged Node timings ms: roots=${m.rootsMs.toFixed(0)} scan=${m.scanMs.toFixed(0)} resolve=${m.resolveMs.toFixed(0)} follow=${m.followMs.toFixed(0)} verify=${m.verifyMs.toFixed(0)} total=${m.totalMs.toFixed(0)} (verify is included in scan/follow)`,
  );
  yield* Console.log(
    `${unitDirectory}: packaged Node work: waves=${m.waves} modules=${m.scannedFiles} edges=${m.edges} resolverProcesses=1 batches=${m.resolverBatches} requests=${m.resolverRequests} resolutionHits=${m.resolverCacheHits} manifests=${m.manifestReads} canonicalPaths=${m.canonicalReads} sourceResolutions=${m.sourceResolutions} verifiedPackages=${m.verifiedPackages} verifiedFiles=${m.verifiedFiles}`,
  );
  return yield* Effect.void;
});

const command = Command.make(
  'complete-packaged-node-dependencies',
  { units: Argument.String('unit-directory').pipe(Argument.atLeast(1)) },
  ({ units }) => Effect.forEach(units, (unit) => reportUnit(unit), { concurrency: 1, discard: true }),
);

const executableLayer = Layer.effectDiscard(Command.run({ version: '1.0.0' })(command)).pipe(
  Layer.provide(NodeServices.layer),
);

if (import.meta.main) {
  NodeRuntime.runMain(Layer.build(executableLayer).pipe(Effect.scoped));
}
