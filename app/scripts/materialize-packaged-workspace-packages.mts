#!/usr/bin/env node
/**
 * Compiles the workspace packages `modern deploy --deploy-target node` traces into `.output/node_modules`.
 *
 * Node refuses to strip TypeScript types for a file under `node_modules`
 * (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), and every `@app/*` package publishes TypeScript entry
 * points, so a packaged unit cannot load the traced copies as they stand. This step compiles them where they
 * already are:
 *
 *   - every traced `.ts`/`.tsx`/`.mts`/`.cts` module becomes one executable `.js`/`.mjs`/`.cjs` beside its
 *     source, so a module reachable from two entry points stays a single module instance;
 *   - a relative specifier that names a TypeScript file is repointed at the compiled module, so the traced
 *     module graph keeps its shape;
 *   - each package's `exports` targets are repointed at the compiled modules.
 *
 * Traced sources stay in place. Missing relative TypeScript inputs are completed at build time from the
 * declared dependency only after its package identity and every carried source agree. The executable unit
 * resolves `@app/*` through its own `.output/node_modules`, never through the build workspace at runtime.
 * Missing build inputs and colliding outputs fail the build instead of publishing an incomplete graph.
 *
 *   node scripts/materialize-packaged-workspace-packages.mts <unit directory> [...]
 */
import { findPackageJSON } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { transform } from 'esbuild';
import { Console, Effect, FileSystem, Layer, Predicate, Schema } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { Argument, Command } from 'effect/cli';
import { parseSync, Visitor } from 'oxc-parser';

/** The directory `modern deploy --deploy-target node` writes the packaged unit into. */
export const PACKAGED_DIRECTORY = '.output';
/** Every package this repository's workspace publishes is scoped `@app`. */
export const WORKSPACE_PACKAGE_SCOPE = '@app';

const PACKAGE_MANIFEST = 'package.json';
const TRACED_DEPENDENCIES_DIRECTORY = 'node_modules';
const MANIFEST_EXPORTS = 'exports';
const MANIFEST_IMPORTS = 'imports';
const MANIFEST_TYPE = 'type';
const MODULE_MANIFEST_TYPE = 'module';

const TYPESCRIPT_EXTENSION = '.ts';
const TYPESCRIPT_JSX_EXTENSION = '.tsx';
const ES_MODULE_TYPESCRIPT_EXTENSION = '.mts';
const COMMONJS_TYPESCRIPT_EXTENSION = '.cts';

/** A TypeScript declaration file emits no runtime module; it must never become a `.d.js`. */
const DECLARATION_FILE = /\.d\.(?:cts|mts|ts)$/u;
/** A specifier that starts with `./` or `../` resolves inside the packaged package. */
const RELATIVE_SPECIFIER = /^\.\.?\//u;
/** A compiled module specifier is written back into a string literal, so it must survive one verbatim. */
const UNQUOTABLE_SPECIFIER = /["'\\\n\r\u2028\u2029]/u;

/** `.ts`/`.tsx` become `.js` in a module package, `.mjs` elsewhere; `.mts`/`.cts` are fixed by extension. */
const ES_MODULE_EXTENSION = '.mjs';
const MODULE_EXTENSION = '.js';
const COMMONJS_EXTENSION = '.cjs';
const ES_MODULE_FORMAT = 'esm';
const COMMONJS_FORMAT = 'cjs';

/** Every module extension this step compiles. */
const TYPESCRIPT_EXTENSIONS = new Set([
  COMMONJS_TYPESCRIPT_EXTENSION,
  ES_MODULE_TYPESCRIPT_EXTENSION,
  TYPESCRIPT_EXTENSION,
  TYPESCRIPT_JSX_EXTENSION,
]);

const isTypeScriptModule = (extension: string): boolean => TYPESCRIPT_EXTENSIONS.has(extension);
const isJavaScriptModule = (extension: string): boolean => ['.js', '.mjs', '.cjs'].includes(extension);
const isRuntimeModule = (extension: string): boolean => isTypeScriptModule(extension) || isJavaScriptModule(extension);

export class PackagedWorkspaceError extends Schema.TaggedError<PackagedWorkspaceError>()('PackagedWorkspaceError', {
  message: Schema.String,
}) {}

/** An `exports` target: a path string, a condition map, or a fallback array of either. */
type PackagedExportTarget = string | readonly PackagedExportTarget[] | PackagedExportTargetConditions;

interface PackagedExportTargetConditions {
  readonly [condition: string]: PackagedExportTarget;
}

const PackagedExportTargetSchema: Schema.Codec<PackagedExportTarget> = Schema.suspend(() =>
  Schema.Union([
    Schema.String,
    Schema.Array(PackagedExportTargetSchema),
    Schema.Record(Schema.String, PackagedExportTargetSchema),
  ]),
);

const PackagedExportTargetConditionsSchema = Schema.Record(Schema.String, PackagedExportTargetSchema);
const isExportTargetConditions = Schema.is(PackagedExportTargetConditionsSchema);
const isExportTargetList = Schema.is(Schema.Array(PackagedExportTargetSchema));

/** A traced `package.json`: every field it carries, with the two this step repoints typed. */
const PackagedPackageManifestSchema = Schema.StructWithRest(
  Schema.Struct({
    exports: Schema.optionalKey(PackagedExportTargetSchema),
    imports: Schema.optionalKey(PackagedExportTargetSchema),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const packagedPackageManifestCodec = Schema.fromJsonString(PackagedPackageManifestSchema, { space: 2 });

/** One traced TypeScript module of a packaged workspace package. */
interface TracedModule {
  /** `.cts` compiles to CommonJS; every other traced TypeScript module compiles to an ES module. */
  readonly commonJs: boolean;
  /** `.tsx` carries JSX; every other traced TypeScript module does not. */
  readonly jsx: boolean;
  /** The absolute path of the executable module this step writes beside the source. */
  readonly outputPath: string;
  /** The relative path of that executable module. */
  readonly outputRelativePath: string;
  /** The traced source, and the file this step reads. */
  readonly sourcePath: string;
  /** JavaScript inputs already run natively; only their TypeScript import specifiers need rewriting. */
  readonly typescript: boolean;
}

/** What one packaged workspace package became. */
export interface PackagedWorkspacePackageReport {
  /** Relative paths of the modules this step emitted, in source order. */
  readonly compiled: readonly string[];
  /** The package's directory name under `@app`. */
  readonly name: string;
  /** `exports` subpaths repointed at a compiled module. */
  readonly repointed: readonly string[];
  /** `exports` subpaths left naming traced TypeScript the packaged tree does not carry. */
  readonly untraced: readonly string[];
}

export interface PackagedWorkspaceCompilation {
  readonly packages: readonly PackagedWorkspacePackageReport[];
}

const failed = (message: string) => new PackagedWorkspaceError({ message });

/** A specifier to write back, `undefined` to leave the traced one alone, or the failure that stops the build. */
type SpecifierResolution = string | undefined | PackagedWorkspaceError;

/** True when `candidate` sits inside `directory` and is not `directory` itself. */
const isInside = (directory: string, candidate: string): boolean => {
  const relative = path.relative(directory, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/** `.ts`/`.tsx` follow the package's module system; `.mts`/`.cts` are fixed by their extension. */
const outputExtensionFor = (extension: string, packageIsModule: boolean): string => {
  if (extension === ES_MODULE_TYPESCRIPT_EXTENSION) {
    return ES_MODULE_EXTENSION;
  }
  if (extension === COMMONJS_TYPESCRIPT_EXTENSION) {
    return COMMONJS_EXTENSION;
  }
  return packageIsModule ? MODULE_EXTENSION : ES_MODULE_EXTENSION;
};

/**
 * Rewrites the relative specifiers of one compiled module. `resolve` returns the specifier to write, or
 * `undefined` to leave the traced specifier untouched; it returns a failure when a traced TypeScript import has
 * no compiled module in the packaged package.
 */
const rewriteModuleSpecifiers = (
  code: string,
  file: string,
  resolve: (specifier: string, commonJs: boolean) => SpecifierResolution,
): Effect.Effect<string, PackagedWorkspaceError> =>
  Effect.gen(function* rewriteCompiledModuleSpecifiers() {
    const parsed = parseSync(file, code, { lang: 'js', sourceType: 'module' });
    if (parsed.errors.length > 0) {
      return yield* Effect.fail(failed(`${file}: the compiled module does not parse`));
    }
    const edits: { readonly end: number; readonly start: number; readonly text: string }[] = [];
    const problems: PackagedWorkspaceError[] = [];
    const record = (
      literal: { readonly end: number; readonly start: number; readonly value?: unknown } | null,
      commonJs = false,
    ) => {
      if (literal === null || !Predicate.isString(literal.value)) {
        return;
      }
      const replacement = resolve(literal.value, commonJs);
      if (replacement === undefined) {
        return;
      }
      if (!Predicate.isString(replacement)) {
        problems.push(replacement);
        return;
      }
      if (UNQUOTABLE_SPECIFIER.test(replacement)) {
        problems.push(failed(`${file}: ${replacement} cannot be written back as a string literal`));
        return;
      }
      const quote = code.charAt(literal.start);
      edits.push({ end: literal.end, start: literal.start, text: `${quote}${replacement}${quote}` });
    };
    new Visitor({
      CallExpression: (node) => {
        const [argument] = node.arguments;
        if (node.callee.type === 'Identifier' && node.callee.name === 'require' && argument?.type === 'Literal') {
          record(argument, true);
        }
      },
      ExportAllDeclaration: (node) => record(node.source),
      ExportNamedDeclaration: (node) => record(node.source),
      ImportDeclaration: (node) => record(node.source),
      ImportExpression: (node) => record(node.source),
    }).visit(parsed.program);
    const [problem] = problems;
    if (problem !== undefined) {
      return yield* Effect.fail(problem);
    }
    let text = code;
    for (const edit of edits.toSorted((left, right) => right.start - left.start)) {
      text = `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`;
    }
    return text;
  });

/** The compiled module `specifier` names, or `undefined` when the target is not a traced TypeScript file. */
const compiledExportTarget = (
  packageDirectory: string,
  packageIsModule: boolean,
  compiledPaths: ReadonlySet<string>,
  specifier: string,
): string | undefined => {
  if (!RELATIVE_SPECIFIER.test(specifier)) {
    return undefined;
  }
  const absolute = path.resolve(packageDirectory, specifier);
  const extension = path.extname(absolute);
  if (!isTypeScriptModule(extension)) {
    return undefined;
  }
  const compiled = `${absolute.slice(0, -extension.length)}${outputExtensionFor(extension, packageIsModule)}`;
  return compiledPaths.has(compiled)
    ? `${specifier.slice(0, -extension.length)}${outputExtensionFor(extension, packageIsModule)}`
    : undefined;
};

const isUntracedTypeScriptTarget = (specifier: string): boolean =>
  RELATIVE_SPECIFIER.test(specifier) && isTypeScriptModule(path.extname(specifier));

/** The `exports` target after repointing, with whether this subpath changed or stayed traced TypeScript. */
interface ExportTargetRewrite {
  readonly repointed: boolean;
  readonly target: PackagedExportTarget;
  readonly untraced: boolean;
}

const rewriteExportTarget = (
  target: PackagedExportTarget,
  repoint: (specifier: string) => string | undefined,
): ExportTargetRewrite => {
  if (isExportTargetConditions(target)) {
    const rewrites = Object.entries(target).map(
      ([condition, entry]) => [condition, rewriteExportTarget(entry, repoint)] as const,
    );
    return {
      repointed: rewrites.some(([, rewrite]) => rewrite.repointed),
      target: Object.fromEntries(rewrites.map(([condition, rewrite]) => [condition, rewrite.target])),
      untraced: rewrites.some(([, rewrite]) => rewrite.untraced),
    };
  }
  if (isExportTargetList(target)) {
    const rewrites = target.map((entry) => rewriteExportTarget(entry, repoint));
    return {
      repointed: rewrites.some((rewrite) => rewrite.repointed),
      target: rewrites.map((rewrite) => rewrite.target),
      untraced: rewrites.some((rewrite) => rewrite.untraced),
    };
  }
  const repointed = repoint(target);
  return repointed === undefined
    ? { repointed: false, target, untraced: isUntracedTypeScriptTarget(target) }
    : { repointed: true, target: repointed, untraced: false };
};

/** Repoints package exports and private imports without flattening their ordered condition maps. */
const rewriteManifestTargets = (
  field: PackagedExportTarget | undefined,
  repoint: (specifier: string) => string | undefined,
) => {
  const repointed: string[] = [];
  const untraced: string[] = [];
  if (field === undefined) {
    return { repointed, target: field, untraced };
  }
  const entries = isExportTargetConditions(field) ? Object.entries(field) : [['.', field] as const];
  const rewrites = entries.map(([subpath, entry]) => [subpath, rewriteExportTarget(entry, repoint)] as const);
  for (const [subpath, rewrite] of rewrites) {
    if (rewrite.repointed) {
      repointed.push(subpath);
    }
    if (rewrite.untraced) {
      untraced.push(subpath);
    }
  }
  return {
    repointed,
    target: isExportTargetConditions(field)
      ? Object.fromEntries(rewrites.map(([subpath, rewrite]) => [subpath, rewrite.target]))
      : rewrites[0]?.[1].target,
    untraced,
  };
};

/** Every TypeScript module the packaged package carries, skipping nested installs and every symlink. */
const collectTracedModules = (packageDirectory: string, packageIsModule: boolean) =>
  Effect.gen(function* collectPackagedModules() {
    const fs = yield* FileSystem.FileSystem;
    const modules: TracedModule[] = [];
    const recordFile = (absolute: string) => {
      const extension = path.extname(absolute);
      if (!isRuntimeModule(extension) || DECLARATION_FILE.test(absolute)) {
        return;
      }
      const typescript = isTypeScriptModule(extension);
      const outputExtension = typescript ? outputExtensionFor(extension, packageIsModule) : extension;
      const sourceRelativePath = path.relative(packageDirectory, absolute);
      const outputRelativePath = `${sourceRelativePath.slice(0, -extension.length)}${outputExtension}`;
      modules.push({
        commonJs: outputExtension === COMMONJS_EXTENSION,
        jsx: absolute.endsWith(TYPESCRIPT_JSX_EXTENSION),
        outputPath: path.join(packageDirectory, outputRelativePath),
        outputRelativePath,
        sourcePath: absolute,
        typescript,
      });
    };
    const visit = (directory: string): Effect.Effect<void, PlatformError> =>
      Effect.gen(function* visitPackagedDirectory() {
        for (const name of (yield* fs.readDirectory(directory)).toSorted()) {
          if (name === TRACED_DEPENDENCIES_DIRECTORY) {
            continue;
          }
          const absolute = path.join(directory, name);
          const info = yield* fs.lstat(absolute);
          // A symlink is an installed dependency or a path out of the packaged copy; neither is ours to write.
          if (info.type !== 'SymbolicLink') {
            if (info.type === 'Directory') {
              yield* visit(absolute);
            } else if (info.type === 'File') {
              recordFile(absolute);
            }
          }
        }
      });
    yield* visit(packageDirectory);
    const generated = new Set(modules.filter((module) => module.typescript).map((module) => module.outputPath));
    return modules.filter((module) => module.typescript || !generated.has(module.sourcePath));
  });

/** Transforms one module without bundling it or changing its module identity. */
const transpileTracedModule = (module: TracedModule) =>
  Effect.gen(function* transpilePackagedModule() {
    const fs = yield* FileSystem.FileSystem;
    const source = yield* fs.readFileString(module.sourcePath);
    if (!module.typescript) {
      return source;
    }
    const transformed = yield* Effect.tryPromise({
      catch: (cause) => failed(`${module.sourcePath}: ${String(cause)}`),
      try: async () =>
        await transform(source, {
          format: module.commonJs ? COMMONJS_FORMAT : ES_MODULE_FORMAT,
          jsx: 'automatic',
          loader: module.jsx ? 'tsx' : 'ts',
          sourcefile: module.sourcePath,
          target: 'esnext',
        }),
    });
    if (transformed.warnings.length > 0) {
      yield* Effect.fail(
        failed(
          `${module.sourcePath}: esbuild would change what this module means: ${transformed.warnings
            .map((warning) => warning.text)
            .join('; ')}`,
        ),
      );
    }
    return transformed.code;
  });

/** Compiles one traced module, refusing to overwrite a different existing output. */
const compileTracedModule = (module: TracedModule, resolve: (specifier: string) => SpecifierResolution) =>
  Effect.gen(function* compilePackagedModule() {
    const fs = yield* FileSystem.FileSystem;
    const code = yield* transpileTracedModule(module);
    const compiled = yield* rewriteModuleSpecifiers(code, module.sourcePath, resolve);
    if (!module.typescript) {
      if (compiled !== code) {
        yield* fs.writeFileString(module.outputPath, compiled);
      }
      return;
    }
    const existing = (yield* fs.exists(module.outputPath)) ? yield* fs.readFileString(module.outputPath) : undefined;
    if (existing !== undefined && existing !== compiled) {
      yield* Effect.fail(
        failed(
          `${module.outputPath}: the packaged tree already carries a different module at this path; this step will not overwrite it`,
        ),
      );
    }
    if (existing === undefined) {
      yield* fs.writeFileString(module.outputPath, compiled);
    }
  });

/** The relative specifier inside a compiled package that `specifier` names, or a failure explaining why not. */
const resolveCompiledSpecifier = (
  importer: string,
  packageDirectory: string,
  packageIsModule: boolean,
  compiledPaths: ReadonlySet<string>,
  specifier: string,
): SpecifierResolution => {
  if (!RELATIVE_SPECIFIER.test(specifier)) {
    return undefined;
  }
  const target = path.resolve(path.dirname(importer), specifier);
  if (!isInside(packageDirectory, target)) {
    return failed(`${importer}: ${specifier} leaves the packaged package`);
  }
  const extension = path.extname(target);
  if (isTypeScriptModule(extension)) {
    const compiled = `${target.slice(0, -extension.length)}${outputExtensionFor(extension, packageIsModule)}`;
    return compiledPaths.has(compiled)
      ? `./${path.relative(path.dirname(importer), compiled)}`
      : failed(`${importer}: ${specifier} is not among the modules the packaged tree carries`);
  }
  if (extension !== '') {
    return undefined;
  }
  const compiledExtension = outputExtensionFor(TYPESCRIPT_EXTENSION, packageIsModule);
  const candidates = [`${target}${compiledExtension}`, path.join(target, `index${compiledExtension}`)];
  const resolved = candidates.find((candidate) => compiledPaths.has(candidate));
  return resolved === undefined
    ? failed(`${importer}: ${specifier} resolves to no compiled module`)
    : `./${path.relative(path.dirname(importer), resolved)}`;
};

const ensurePackagedSourceParent = (packageDirectory: string, relative: string) =>
  Effect.gen(function* ensureRegularPackagedParents() {
    const fs = yield* FileSystem.FileSystem;
    let parent = packageDirectory;
    for (const segment of relative.split(path.sep).slice(0, -1)) {
      parent = path.join(parent, segment);
      if (yield* fs.exists(parent)) {
        if ((yield* fs.lstat(parent)).type !== 'Directory') {
          yield* Effect.fail(failed(`${parent}: a packaged source directory must not be a symlink`));
        }
      } else {
        yield* fs.makeDirectory(parent);
      }
    }
  });

/** Node chooses the first matching condition, independently for import() and require(). */
const nodeImportTarget = (target: PackagedExportTarget, commonJs: boolean): string | undefined => {
  if (Predicate.isString(target)) {
    return target;
  }
  const candidates = isExportTargetList(target)
    ? target
    : Object.entries(target)
        .filter(([condition]) =>
          ['node', 'node-addons', 'module-sync', 'default', commonJs ? 'require' : 'import'].includes(condition),
        )
        .map(([, entry]) => entry);
  for (const entry of candidates) {
    const selected = nodeImportTarget(entry, commonJs);
    if (selected !== undefined) {
      return selected;
    }
  }
  return undefined;
};

const privateImportTarget = (
  specifier: string,
  imports: PackagedExportTarget | undefined,
  commonJs: boolean,
): SpecifierResolution => {
  if (!specifier.startsWith('#')) {
    return undefined;
  }
  const entry = imports !== undefined && isExportTargetConditions(imports) ? imports[specifier] : undefined;
  const target = entry === undefined ? undefined : nodeImportTarget(entry, commonJs);
  return target ?? failed(`${specifier}: no declared Node package-import target`);
};

/** Condition order is meaningful to Node, so ordinary record equivalence is insufficient here. */
const sameImportTarget = (left: PackagedExportTarget | undefined, right: PackagedExportTarget | undefined): boolean => {
  if (left === right) {
    return true;
  }
  if (left === undefined || right === undefined) {
    return false;
  }
  if (isExportTargetList(left) && isExportTargetList(right)) {
    return left.length === right.length && left.every((entry, index) => sameImportTarget(entry, right[index]));
  }
  if (isExportTargetConditions(left) && isExportTargetConditions(right)) {
    const entries = Object.entries(left);
    const other = Object.entries(right);
    return (
      entries.length === other.length &&
      entries.every(([key, entry], index) => {
        const candidate = other[index];
        return candidate !== undefined && key === candidate[0] && sameImportTarget(entry, candidate[1]);
      })
    );
  }
  return false;
};

const sameBuildPackageIdentity = (
  source: typeof PackagedPackageManifestSchema.Type,
  packaged: typeof PackagedPackageManifestSchema.Type,
  name: string,
) =>
  source.name === name &&
  packaged.name === name &&
  source.version === packaged.version &&
  source.type === packaged.type &&
  sameImportTarget(source.imports, packaged.imports);

/** Completes missing relative and private-import TypeScript inputs at build time, never at runtime. */
const completeTracedModuleGraph = (
  unitDirectory: string,
  packageDirectory: string,
  name: string,
  packageIsModule: boolean,
  packagedManifest: typeof PackagedPackageManifestSchema.Type,
) =>
  Effect.gen(function* completePackagedGraph() {
    const fs = yield* FileSystem.FileSystem;
    let modules = yield* collectTracedModules(packageDirectory, packageIsModule);
    const examined = new Set<string>();
    let sourceDirectory: string | undefined;
    while (true) {
      const carried = new Set(modules.flatMap((module) => [module.sourcePath, module.outputPath]));
      const missing = new Set<string>();
      for (const module of modules) {
        if (examined.has(module.sourcePath)) {
          continue;
        }
        examined.add(module.sourcePath);
        yield* rewriteModuleSpecifiers(
          yield* transpileTracedModule(module),
          module.sourcePath,
          (specifier, commonJs): SpecifierResolution => {
            const privateTarget = privateImportTarget(specifier, packagedManifest.imports, commonJs);
            if (privateTarget !== undefined && !Predicate.isString(privateTarget)) {
              return privateTarget;
            }
            const input = privateTarget ?? specifier;
            if (!RELATIVE_SPECIFIER.test(input) || !isRuntimeModule(path.extname(input))) {
              return undefined;
            }
            const target = path.resolve(
              privateTarget === undefined ? path.dirname(module.sourcePath) : packageDirectory,
              input,
            );
            if (!isInside(packageDirectory, target) || DECLARATION_FILE.test(target)) {
              return failed(`${module.sourcePath}: ${specifier} is not a runtime module inside the packaged package`);
            }
            if (!carried.has(target)) {
              missing.add(target);
            }
            return undefined;
          },
        );
      }
      if (missing.size === 0) {
        return modules;
      }
      if (sourceDirectory === undefined) {
        const packageName = `${WORKSPACE_PACKAGE_SCOPE}/${name}`;
        const sourceManifestPath = yield* Effect.try({
          catch: () => failed(`${packageName}: the declared build dependency could not be resolved`),
          try: () => findPackageJSON(packageName, pathToFileURL(path.join(unitDirectory, PACKAGE_MANIFEST))),
        });
        if (sourceManifestPath === undefined) {
          return yield* Effect.fail(failed(`${packageName}: missing the declared build dependency manifest`));
        }
        sourceDirectory = yield* fs.realPath(path.dirname(sourceManifestPath));
        const packagedOutput = yield* fs.realPath(path.join(unitDirectory, PACKAGED_DIRECTORY));
        if (sourceDirectory === packagedOutput || isInside(packagedOutput, sourceDirectory)) {
          return yield* Effect.fail(
            failed(`${packageName}: build inputs must not resolve through the packaged output`),
          );
        }
        const sourceManifest = yield* Schema.decodeUnknownEffect(packagedPackageManifestCodec)(
          yield* fs.readFileString(sourceManifestPath),
        );
        if (!sameBuildPackageIdentity(sourceManifest, packagedManifest, packageName)) {
          return yield* Effect.fail(failed(`${packageName}: the traced and build-input package identities differ`));
        }
        // A matching package name alone is insufficient: every carried source must be the same build input.
        for (const module of modules) {
          const original = path.join(sourceDirectory, path.relative(packageDirectory, module.sourcePath));
          if (!isInside(sourceDirectory, yield* fs.realPath(original))) {
            return yield* Effect.fail(failed(`${original}: a traced build input leaves its package`));
          }
          if ((yield* fs.readFileString(original)) !== (yield* fs.readFileString(module.sourcePath))) {
            return yield* Effect.fail(failed(`${packageName}: a traced source differs from its declared build input`));
          }
        }
      }
      for (const target of missing) {
        const relative = path.relative(packageDirectory, target);
        const original = path.join(sourceDirectory, relative);
        const realOriginal = yield* fs.realPath(original);
        if (!isInside(sourceDirectory, realOriginal) || (yield* fs.lstat(original)).type !== 'File') {
          return yield* Effect.fail(
            failed(`${original}: a missing runtime source must be a regular package-owned file`),
          );
        }
        yield* ensurePackagedSourceParent(packageDirectory, relative);
        if (yield* fs.exists(target)) {
          return yield* Effect.fail(failed(`${target}: refusing to replace an existing untraced source`));
        }
        yield* fs.writeFileString(target, yield* fs.readFileString(original));
      }
      modules = yield* collectTracedModules(packageDirectory, packageIsModule);
    }
  });

/** Compiles one traced `@app` package and repoints its `exports` targets at the compiled modules. */
const compilePackagedWorkspacePackage = Effect.fn(
  'MaterializePackagedWorkspacePackages.compilePackagedWorkspacePackage',
)(function* compilePackagedWorkspacePackage(unitDirectory: string, packageDirectory: string, name: string) {
  const fs = yield* FileSystem.FileSystem;
  const manifestPath = path.join(packageDirectory, PACKAGE_MANIFEST);
  if (!(yield* fs.exists(manifestPath))) {
    return yield* Effect.fail(failed(`${name}: the packaged copy carries no ${PACKAGE_MANIFEST}`));
  }
  const manifestText = yield* fs.readFileString(manifestPath);
  const manifest = yield* Schema.decodeUnknownEffect(packagedPackageManifestCodec)(manifestText).pipe(
    Effect.mapError((cause) => failed(`${manifestPath}: ${String(cause)}`)),
  );
  const packageIsModule = manifest[MANIFEST_TYPE] === MODULE_MANIFEST_TYPE;
  const modules = yield* completeTracedModuleGraph(unitDirectory, packageDirectory, name, packageIsModule, manifest);
  const compiledPaths = new Set(modules.map((module) => module.outputPath));
  yield* Effect.forEach(
    modules,
    (module) =>
      compileTracedModule(module, (specifier) =>
        resolveCompiledSpecifier(module.sourcePath, packageDirectory, packageIsModule, compiledPaths, specifier),
      ),
    { concurrency: 1, discard: true },
  );
  const compiledTypeScriptPaths = new Set(
    modules.filter((module) => module.typescript).map((module) => module.outputPath),
  );
  const repoint = (specifier: string) =>
    compiledExportTarget(packageDirectory, packageIsModule, compiledTypeScriptPaths, specifier);
  const exportsRewrite = rewriteManifestTargets(manifest[MANIFEST_EXPORTS], repoint);
  const importsRewrite = rewriteManifestTargets(manifest[MANIFEST_IMPORTS], repoint);
  const repointed = [...exportsRewrite.repointed, ...importsRewrite.repointed];
  const untraced = [...exportsRewrite.untraced, ...importsRewrite.untraced];
  if (repointed.length > 0) {
    const nextManifest = { ...manifest };
    if (exportsRewrite.target !== undefined) {
      nextManifest[MANIFEST_EXPORTS] = exportsRewrite.target;
    }
    if (importsRewrite.target !== undefined) {
      nextManifest[MANIFEST_IMPORTS] = importsRewrite.target;
    }
    const encoded = yield* Schema.encodeEffect(packagedPackageManifestCodec)(nextManifest).pipe(
      Effect.mapError((cause) => failed(`${manifestPath}: ${String(cause)}`)),
    );
    yield* fs.writeFileString(manifestPath, `${encoded}\n`);
  }
  return {
    compiled: modules.filter((module) => module.typescript).map((module) => module.outputRelativePath),
    name,
    repointed,
    untraced,
  } satisfies PackagedWorkspacePackageReport;
});

/**
 * Compiles every workspace package the unit traced into `.output/node_modules`. Idempotent: a unit without a
 * packaged output, or one whose modules are already compiled and repointed, reports nothing to change.
 */
export const compilePackagedWorkspacePackages = Effect.fn(
  'MaterializePackagedWorkspacePackages.compilePackagedWorkspacePackages',
)(function* compilePackagedWorkspacePackages(unitDirectory: string) {
  const fs = yield* FileSystem.FileSystem;
  // The unit is usually addressed relative to the shell app (`node … .`), and every path this step compares
  // has to agree on absolute or relative form.
  const unit = path.resolve(unitDirectory);
  const tracedScope = path.join(unit, PACKAGED_DIRECTORY, TRACED_DEPENDENCIES_DIRECTORY, WORKSPACE_PACKAGE_SCOPE);
  if (!(yield* fs.exists(tracedScope))) {
    return { packages: [] } satisfies PackagedWorkspaceCompilation;
  }
  const packages: PackagedWorkspacePackageReport[] = [];
  for (const name of (yield* fs.readDirectory(tracedScope)).toSorted()) {
    const packageDirectory = path.join(tracedScope, name);
    const info = yield* fs.lstat(packageDirectory);
    if (info.type !== 'Directory') {
      return yield* Effect.fail(
        failed(
          `${packageDirectory}: a packaged workspace package must be a real directory inside ${PACKAGED_DIRECTORY}`,
        ),
      );
    }
    packages.push(yield* compilePackagedWorkspacePackage(unit, packageDirectory, name));
  }
  return { packages } satisfies PackagedWorkspaceCompilation;
});

const reportUnit = Effect.fn('MaterializePackagedWorkspacePackages.reportUnit')(function* reportUnit(
  unitDirectory: string,
) {
  const compilation = yield* compilePackagedWorkspacePackages(unitDirectory);
  let compiled = 0;
  for (const entry of compilation.packages) {
    compiled += entry.compiled.length;
  }
  yield* Console.log(
    `${unitDirectory}: compiled ${compiled} packaged workspace modules across ${compilation.packages.length} packages`,
  );
  yield* Effect.forEach(
    compilation.packages,
    (entry) =>
      entry.untraced.length === 0
        ? Effect.void
        : Console.warn(
            `${unitDirectory}: ${WORKSPACE_PACKAGE_SCOPE}/${entry.name} leaves ${entry.untraced.join(', ')} naming traced TypeScript the packaged tree does not carry`,
          ),
    { concurrency: 1, discard: true },
  );
});

const command = Command.make(
  'materialize-packaged-workspace-packages',
  { units: Argument.String('unit-directory').pipe(Argument.atLeast(1)) },
  ({ units }) => Effect.forEach(units, (unit) => reportUnit(unit), { concurrency: 1, discard: true }),
);

const executableLayer = Layer.effectDiscard(Command.run({ version: '1.0.0' })(command)).pipe(
  Layer.provide(NodeServices.layer),
);

if (import.meta.main) {
  NodeRuntime.runMain(Layer.build(executableLayer).pipe(Effect.scoped));
}
