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
import { Console, Effect, FileSystem, Layer, Predicate, Schema, Stream } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { Argument, Command } from 'effect/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { parseSync, Visitor } from 'oxc-parser';

import { PACKAGED_DIRECTORY, WORKSPACE_PACKAGE_SCOPE } from './materialize-packaged-workspace-packages.mts';

const PACKAGE_MANIFEST = 'package.json';
const NODE_MODULES = 'node_modules';
const DEFAULT_MODULE_TYPE = 'commonjs';
const ES_MODULE_EXTENSION = '.mjs';

/** The files a static ESM graph starts from or reaches; only these may be scanned for `import` edges. */
const SCANNED_EXTENSIONS = new Set(['.js', '.mjs']);
/** The runtime files this step copies from a declared install. TypeScript belongs to the compile step. */
const COPYABLE_EXTENSIONS = new Set(['.cjs', '.js', '.json', '.mjs']);
const TYPESCRIPT_EXTENSIONS = new Set(['.cts', '.mts', '.ts', '.tsx']);

/** Node's flag that makes `import.meta.resolve` honour its parent argument. */
const PARENT_AWARE_RESOLUTION_FLAG = '--experimental-import-meta-resolve';
/** The probe parent the host must honour; its specifier is resolved against it and checked before any result is used. */
const SELF_CHECK_PARENT = '.node-dependency-self-check.mjs';
const SELF_CHECK_SPECIFIER = './node-dependency-self-check-missing.mjs';

/**
 * Runs in one native Node process: each request is resolved against its parent, and a failure is reported as data
 * with Node's own error code, so a missing target is never confused with an unresolvable one.
 */
const RESOLVER_HOST = [
  'const chunks = [];',
  'for await (const chunk of process.stdin) chunks.push(chunk);',
  "const { requests } = JSON.parse(Buffer.concat(chunks).toString('utf8'));",
  'const results = requests.map(({ parent, specifier }) => {',
  '  try {',
  '    return { url: import.meta.resolve(specifier, parent) };',
  '  } catch (error) {',
  "    return { code: String(error?.code ?? 'ERR_UNKNOWN'), message: String(error?.message ?? error) };",
  '  }',
  '});',
  'process.stdout.write(JSON.stringify({ results }));',
].join('\n');

export class PackagedNodeDependencyError extends Schema.TaggedError<PackagedNodeDependencyError>()(
  'PackagedNodeDependencyError',
  { message: Schema.String },
) {}

const failed = (message: string) => new PackagedNodeDependencyError({ message });

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
type PackageManifest = typeof PackageManifestSchema.Type;
const packageManifestCodec = Schema.fromJsonString(PackageManifestSchema);

const ResolverRequestCodec = Schema.fromJsonString(
  Schema.Struct({
    requests: Schema.Array(Schema.Struct({ parent: Schema.String, specifier: Schema.String })),
  }),
);
const ResolverResponseCodec = Schema.fromJsonString(
  Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        code: Schema.optionalKey(Schema.String),
        message: Schema.optionalKey(Schema.String),
        url: Schema.optionalKey(Schema.String),
      }),
    ),
  }),
);

interface ResolverRequest {
  readonly parent: string;
  readonly specifier: string;
}

interface ResolverResult {
  readonly code?: string | undefined;
  readonly message?: string | undefined;
  readonly url?: string | undefined;
}

export interface NodeDependencyCompletionOptions {
  /**
   * Unit-relative modules to start the walk from. They must lie outside the traced `node_modules`, because a package
   * file has no declaring owner until an entry reaches it. Default: every `.js`/`.mjs` the unit carries outside it, and
   * the ES module entries of the workspace packages it declares.
   */
  readonly roots?: readonly string[];
}

export interface NodeDependencyCompletion {
  /** Unit-relative paths of the files copied from declared installs, in discovery order. */
  readonly copied: readonly string[];
}

/** The package whose manifest declares the dependencies a module imports. */
interface DeclaringOwner {
  readonly declared: DeclaredSpecs;
  readonly manifest: string;
  readonly name: string;
}

/** A packaged package whose identity and carried files have been verified against its declared install. */
interface VerifiedSource {
  readonly declared: DeclaredSpecs;
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
  readonly unit: string;
  readonly unitOwner: DeclaringOwner;
}

const isInside = (directory: string, candidate: string): boolean => {
  const relative = path.relative(directory, candidate);
  return relative !== '' && relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative);
};

const isNodeModulesName = (name: string): boolean => name === NODE_MODULES;

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

const moduleTypeOf = (manifest: PackageManifest): string => manifest.type ?? DEFAULT_MODULE_TYPE;

/** The names a manifest declares, each with its version spec. An alias declares `npm:<real name>@<version>`. */
type DeclaredSpecs = ReadonlyMap<string, string>;

const declaredSpecs = (manifest: PackageManifest): DeclaredSpecs =>
  new Map(
    [manifest.dependencies ?? {}, manifest.optionalDependencies ?? {}, manifest.peerDependencies ?? {}].flatMap(
      (group) => Object.entries(group).map(([name, spec]): [string, string] => [name, String(spec)]),
    ),
  );

/** The name `declared` installs the package `name` under: its own name, or the alias whose spec points at `name`. */
const declaredAliasOf = (declared: DeclaredSpecs, name: string): string | undefined => {
  if (declared.has(name)) {
    return name;
  }
  return [...declared].find(([, spec]) => spec.startsWith(`npm:${name}@`))?.[0];
};

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
      return file;
    }
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(yield* fs.realPath(existing), ...missing);
});

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

/** Every regular file below `directory`, skipping symlinks and any directory `skip` names. */
const walkFiles = (directory: string, skip: (name: string) => boolean) =>
  Effect.gen(function* collectFiles() {
    const fs = yield* FileSystem.FileSystem;
    const files: string[] = [];
    const visit = (current: string): Effect.Effect<void, PlatformError> =>
      Effect.gen(function* visitDirectory() {
        for (const name of (yield* fs.readDirectory(current)).toSorted()) {
          if (skip(name)) {
            continue;
          }
          const absolute = path.join(current, name);
          const info = yield* fs.lstat(absolute);
          if (info.type === 'Directory') {
            yield* visit(absolute);
          } else if (info.type === 'File') {
            files.push(absolute);
          }
        }
      });
    yield* visit(directory);
    return files;
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
    return [];
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
  return specifiers;
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
  function* workspaceExportRoots(output: string, declared: DeclaredSpecs) {
    const fs = yield* FileSystem.FileSystem;
    const scope = path.join(output, NODE_MODULES, WORKSPACE_PACKAGE_SCOPE);
    if (!(yield* fs.exists(scope))) {
      return [];
    }
    const roots: string[] = [];
    for (const name of (yield* fs.readDirectory(scope)).toSorted()) {
      const packageRoot = path.join(scope, name);
      const manifest = yield* readManifest(path.join(packageRoot, PACKAGE_MANIFEST));
      if (declaredAliasOf(declared, manifest.name) === undefined) {
        continue;
      }
      for (const target of exportTargets(manifest.exports)) {
        const file = yield* canonicalPath(path.join(packageRoot, target));
        if (isInside(packageRoot, file) && SCANNED_EXTENSIONS.has(path.extname(file)) && (yield* fs.exists(file))) {
          roots.push(file);
        }
      }
    }
    return roots;
  },
);

/**
 * Resolves every request in one native Node process. The process first resolves a probe whose answer is known, so a
 * Node that ignores the parent argument fails here instead of resolving the graph against the host script.
 */
const resolveSpecifiers = Effect.fn('CompletePackagedNodeDependencies.resolveSpecifiers')(function* resolveSpecifiers(
  output: string,
  requests: readonly ResolverRequest[],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const selfCheckParent = pathToFileURL(path.join(output, SELF_CHECK_PARENT)).href;
  const payload = yield* Schema.encodeEffect(ResolverRequestCodec)({
    requests: [{ parent: selfCheckParent, specifier: SELF_CHECK_SPECIFIER }, ...requests],
  }).pipe(Effect.mapError((cause) => failed(`the resolver request cannot be encoded: ${String(cause)}`)));
  const [stdout, stderr, exitCode] = yield* Effect.scoped(
    Effect.gen(function* runResolverHost() {
      const handle = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          [PARENT_AWARE_RESOLUTION_FLAG, '--input-type=module', '--eval', RESOLVER_HOST],
          {
            cwd: output,
            env: {},
            stderr: 'pipe',
            stdin: Stream.make(new TextEncoder().encode(payload)),
            stdout: 'pipe',
          },
        ),
      );
      // Output is read to EOF before the exit code, so a large answer cannot fill the pipe and block the host.
      return [
        yield* Stream.mkString(Stream.decodeText(handle.stdout)),
        yield* Stream.mkString(Stream.decodeText(handle.stderr)),
        yield* handle.exitCode,
      ] as const;
    }),
  );
  if (Number(exitCode) !== 0) {
    return yield* Effect.fail(failed(`the Node resolver exited ${Number(exitCode)}: ${stderr.trim()}`));
  }
  const response = yield* Schema.decodeUnknownEffect(ResolverResponseCodec)(stdout).pipe(
    Effect.mapError((cause) => failed(`the Node resolver answered an unexpected shape: ${String(cause)}`)),
  );
  const [selfCheck, ...results] = response.results;
  if (selfCheck?.url !== new URL(SELF_CHECK_SPECIFIER, selfCheckParent).href) {
    return yield* Effect.fail(
      failed(
        'this Node does not resolve import.meta.resolve(specifier, parent) against its parent; the packaged dependency closure needs a Node that supports --experimental-import-meta-resolve',
      ),
    );
  }
  if (results.length !== requests.length) {
    return yield* Effect.fail(failed('the Node resolver answered a different number of requests than it received'));
  }
  return results;
});

/** The declared install of `name` that `owner` resolves, from the owner's own real location. */
const resolveDeclaredSource = Effect.fn('CompletePackagedNodeDependencies.resolveDeclaredSource')(
  function* resolveDeclaredSource(owner: DeclaringOwner, name: string) {
    const fs = yield* FileSystem.FileSystem;
    const alias = declaredAliasOf(owner.declared, name);
    if (alias === undefined) {
      return yield* Effect.fail(failed(`${name}: ${owner.name} does not declare it, so its install is not copied`));
    }
    const sourceManifest = yield* Effect.try({
      catch: () => failed(`${name}: the install ${owner.name} declares cannot be resolved`),
      try: () => findPackageJSON(alias, pathToFileURL(owner.manifest)),
    });
    if (sourceManifest === undefined) {
      return yield* Effect.fail(failed(`${name}: the install ${owner.name} declares is missing`));
    }
    const directory = yield* fs
      .realPath(path.dirname(sourceManifest))
      .pipe(Effect.mapError(() => failed(`${name}: its declared install cannot be resolved to a real directory`)));
    const manifest = yield* readManifest(path.join(directory, PACKAGE_MANIFEST));
    if (manifest.name !== name) {
      return yield* Effect.fail(failed(`${name}: the declared install is named ${manifest.name}`));
    }
    return { declared: declaredSpecs(manifest), directory, manifest };
  },
);

/** Every file of a traced third-party package matches its declared install byte for byte. */
const verifyCarriedFiles = Effect.fn('CompletePackagedNodeDependencies.verifyCarriedFiles')(
  function* verifyCarriedFiles(packageRoot: string, sourceDirectory: string) {
    const fs = yield* FileSystem.FileSystem;
    for (const file of yield* walkFiles(packageRoot, isNodeModulesName)) {
      const relative = path.relative(packageRoot, file);
      if (relative === PACKAGE_MANIFEST) {
        // The traced manifest is rewritten by the packaging step (`exports`, `publishConfig`); its identity is checked.
        continue;
      }
      const declaredFile = path.join(sourceDirectory, relative);
      if (!(yield* fs.exists(declaredFile))) {
        yield* Effect.fail(failed(`${file}: the traced package carries a file its declared install does not contain`));
      }
      const real = yield* fs.realPath(declaredFile);
      if (!isInside(sourceDirectory, real)) {
        yield* Effect.fail(failed(`${declaredFile}: the declared install's file resolves outside its package`));
      }
      if (!sameBytes(yield* fs.readFile(file), yield* fs.readFile(real))) {
        yield* Effect.fail(failed(`${file}: differs from the declared install's ${relative}`));
      }
    }
  },
);

/**
 * Verifies a traced package against the install its owner declares, and records it. A second owner must resolve the
 * same install, so two declaring packages never see two copies of one package.
 */
const ensureVerifiedSource = Effect.fn('CompletePackagedNodeDependencies.ensureVerifiedSource')(
  function* ensureVerifiedSource(sources: Map<string, VerifiedSource>, packageRoot: string, owner: DeclaringOwner) {
    const packaged = yield* readManifest(path.join(packageRoot, PACKAGE_MANIFEST));
    const resolved = yield* resolveDeclaredSource(owner, packaged.name);
    const existing = sources.get(packageRoot);
    if (existing !== undefined) {
      if (existing.directory !== resolved.directory) {
        return yield* Effect.fail(
          failed(`${packaged.name}: two declaring packages resolve different installs; the packaged tree keeps one`),
        );
      }
      return existing;
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
      yield* verifyCarriedFiles(packageRoot, resolved.directory);
    }
    const source: VerifiedSource = { declared: resolved.declared, directory: resolved.directory, name: packaged.name };
    sources.set(packageRoot, source);
    return source;
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
  },
);

/** The owner of the packages `file` imports: its own package's verified declared install, or the unit. */
const ownerOf = Effect.fn('CompletePackagedNodeDependencies.ownerOf')(function* ownerOf(
  context: CompletionContext,
  file: string,
) {
  const packageRoot = packageRootOf(context.output, file);
  if (packageRoot === undefined) {
    return context.unitOwner;
  }
  // A package reached without an import edge is a workspace export root, which only the unit's declaration can verify.
  const source =
    context.sources.get(packageRoot) ?? (yield* ensureVerifiedSource(context.sources, packageRoot, context.unitOwner));
  return { declared: source.declared, manifest: path.join(source.directory, PACKAGE_MANIFEST), name: source.name };
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
    return null;
  }
  const target = yield* canonicalPath(fileURLToPath(result.url));
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
    yield* ensureVerifiedSource(context.sources, targetRoot, edge.owner);
  }
  const extension = path.extname(target);
  if (yield* fs.exists(target)) {
    if ((yield* fs.lstat(target)).type !== 'File') {
      return yield* Effect.fail(failed(`${reference}: ${target} is not a file`));
    }
    return SCANNED_EXTENSIONS.has(extension) ? target : null;
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
  return SCANNED_EXTENSIONS.has(extension) ? target : null;
});

/**
 * Completes the static ESM closure of one packaged unit. Idempotent: a closure that already loads reports nothing to
 * copy. Each wave resolves all its edges in one native Node process, so the walk costs one process per wave.
 */
export const completePackagedNodeDependencies = Effect.fn('CompletePackagedNodeDependencies.complete')(
  function* completePackagedNodeDependencies(unitDirectory: string, options: NodeDependencyCompletionOptions = {}) {
    const fs = yield* FileSystem.FileSystem;
    // Canonical from the start: every path this step compares, reports, or writes is a real path, as Node sees it.
    const unit = yield* canonicalPath(path.resolve(unitDirectory));
    const outputPath = path.join(unit, PACKAGED_DIRECTORY);
    if (!(yield* fs.exists(outputPath))) {
      return yield* Effect.fail(failed(`${outputPath}: there is no packaged output to complete`));
    }
    const output = yield* fs.realPath(outputPath);
    const unitManifest = yield* readManifest(path.join(unit, PACKAGE_MANIFEST));
    const context: CompletionContext = {
      copied: [],
      output,
      sources: new Map(),
      unit,
      unitOwner: {
        declared: declaredSpecs(unitManifest),
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
      roots.push(...(yield* workspaceExportRoots(output, context.unitOwner.declared)));
    } else {
      for (const root of options.roots) {
        const file = yield* canonicalPath(path.resolve(unit, root));
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

    const visited = new Set<string>();
    let wave = [...new Set(roots)];
    while (wave.length > 0) {
      const files = wave.filter((file) => !visited.has(file));
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
      if (edges.length === 0) {
        break;
      }
      const results = yield* resolveSpecifiers(
        output,
        edges.map((edge) => ({ parent: pathToFileURL(edge.importer).href, specifier: edge.specifier })),
      );
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
      wave = next;
    }
    return { copied: context.copied.toSorted() } satisfies NodeDependencyCompletion;
  },
);

const reportUnit = Effect.fn('CompletePackagedNodeDependencies.reportUnit')(function* reportUnit(
  unitDirectory: string,
) {
  const completion = yield* completePackagedNodeDependencies(unitDirectory);
  yield* Console.log(`${unitDirectory}: completed ${completion.copied.length} packaged Node dependency files`);
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
