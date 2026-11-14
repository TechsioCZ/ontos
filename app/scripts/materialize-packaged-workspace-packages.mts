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
 * declared dependency only after its package identity and every carried source agree. The trace cannot parse
 * TypeScript, so a bare `@app/*` import that a compiled packaged module makes and the packaged tree lacks is carried
 * from the install the importing package declares (its manifest and the imported entry, then their relative graph),
 * until the compiled workspace graph names nothing the packaged tree lacks. The executable unit
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
  /** Node loads this module as CommonJS: a `.cts` output, a native `.cjs`, or a native `.js` whose `type` is not `module`. */
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
  commonJs: boolean,
  resolve: (specifier: string, viaRequire: boolean) => SpecifierResolution,
): Effect.Effect<string, PackagedWorkspaceError> =>
  Effect.gen(function* rewriteCompiledModuleSpecifiers() {
    // CommonJS parses with Node's own top-level rules, so a top-level `return` is valid there.
    const parsed = parseSync(file, code, { lang: 'js', sourceType: commonJs ? 'commonjs' : 'module' });
    if (parsed.errors.length > 0) {
      return yield* Effect.fail(failed(`${file}: the compiled module does not parse`));
    }
    const edits: { readonly end: number; readonly start: number; readonly text: string }[] = [];
    const problems: PackagedWorkspaceError[] = [];
    const record = (
      literal: { readonly end: number; readonly start: number; readonly value?: unknown } | null,
      viaRequire = false,
    ) => {
      if (literal === null || !Predicate.isString(literal.value)) {
        return;
      }
      const replacement = resolve(literal.value, viaRequire);
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

/**
 * The compiled form of a `*` import target such as `./src/lib/*.ts`, or `undefined` when no carried TypeScript module
 * matches it. Every carried module is compiled before any target is repointed, so the pattern serves only compiled files.
 */
const compiledPatternTarget = (
  packageDirectory: string,
  packageIsModule: boolean,
  modules: readonly TracedModule[],
  specifier: string,
): string | undefined => {
  const star = specifier.indexOf('*');
  const extension = path.extname(specifier);
  if (
    !RELATIVE_SPECIFIER.test(specifier) ||
    star === -1 ||
    specifier.lastIndexOf('*') !== star ||
    !isTypeScriptModule(extension)
  ) {
    return undefined;
  }
  const prefix = path.join(packageDirectory, specifier.slice(0, star));
  const tail = specifier.slice(star + 1);
  const served = modules.some(
    (module) =>
      module.typescript &&
      module.sourcePath.startsWith(prefix) &&
      module.sourcePath.endsWith(tail) &&
      module.sourcePath.length >= prefix.length + tail.length,
  );
  return served
    ? `${specifier.slice(0, star + 1)}${tail.slice(0, tail.length - extension.length)}${outputExtensionFor(extension, packageIsModule)}`
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
  repointFor: (subpath: string) => (specifier: string) => string | undefined,
) => {
  const repointed: string[] = [];
  const untraced: string[] = [];
  if (field === undefined) {
    return { repointed, target: field, untraced };
  }
  const entries = isExportTargetConditions(field) ? Object.entries(field) : [['.', field] as const];
  const rewrites = entries.map(
    ([subpath, entry]) => [subpath, rewriteExportTarget(entry, repointFor(subpath))] as const,
  );
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

/** A nested `package.json` only supplies the `type` that Node reads for the files beneath it. */
const NestedPackageManifestSchema = Schema.fromJsonString(
  Schema.StructWithRest(Schema.Struct({ type: Schema.optionalKey(Schema.String) }), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]),
);

/** `.cjs` is CommonJS and `.mjs` an ES module; `.js` takes the `type` of its nearest package.json. */
const isCommonJsJavaScript = (extension: string, scopeIsModule: boolean): boolean =>
  extension === COMMONJS_EXTENSION || (extension === MODULE_EXTENSION && !scopeIsModule);

/** Whether the nearest package.json at or above `directory`, below the package root, declares `type: module`. */
const nearestScopeIsModule = (directory: string, inherited: boolean) =>
  Effect.gen(function* readNearestScope() {
    const fs = yield* FileSystem.FileSystem;
    const manifestPath = path.join(directory, PACKAGE_MANIFEST);
    if (!(yield* fs.exists(manifestPath))) {
      return inherited;
    }
    const nested = yield* Schema.decodeUnknownEffect(NestedPackageManifestSchema)(
      yield* fs.readFileString(manifestPath),
    ).pipe(Effect.mapError((cause) => failed(`${manifestPath}: ${String(cause)}`)));
    return nested.type === MODULE_MANIFEST_TYPE;
  });

/** Every TypeScript module the packaged package carries, skipping nested installs and every symlink. */
const collectTracedModules = (packageDirectory: string, packageIsModule: boolean) =>
  Effect.gen(function* collectPackagedModules() {
    const fs = yield* FileSystem.FileSystem;
    const modules: TracedModule[] = [];
    const recordFile = (absolute: string, scopeIsModule: boolean) => {
      const extension = path.extname(absolute);
      if (!isRuntimeModule(extension) || DECLARATION_FILE.test(absolute)) {
        return;
      }
      const typescript = isTypeScriptModule(extension);
      const outputExtension = typescript ? outputExtensionFor(extension, packageIsModule) : extension;
      const sourceRelativePath = path.relative(packageDirectory, absolute);
      const outputRelativePath = `${sourceRelativePath.slice(0, -extension.length)}${outputExtension}`;
      modules.push({
        commonJs: typescript ? outputExtension === COMMONJS_EXTENSION : isCommonJsJavaScript(extension, scopeIsModule),
        jsx: absolute.endsWith(TYPESCRIPT_JSX_EXTENSION),
        outputPath: path.join(packageDirectory, outputRelativePath),
        outputRelativePath,
        sourcePath: absolute,
        typescript,
      });
    };
    const visit = (
      directory: string,
      scopeIsModule: boolean,
    ): Effect.Effect<void, PlatformError | PackagedWorkspaceError, FileSystem.FileSystem> =>
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
              yield* visit(absolute, yield* nearestScopeIsModule(absolute, scopeIsModule));
            } else if (info.type === 'File') {
              recordFile(absolute, scopeIsModule);
            }
          }
        }
      });
    yield* visit(packageDirectory, packageIsModule);
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
    const compiled = yield* rewriteModuleSpecifiers(code, module.sourcePath, module.commonJs, resolve);
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

/**
 * The relative specifier inside a compiled package that `specifier` names, `undefined` to keep it as written, or a
 * failure explaining why not. A native module keeps every specifier Node resolves itself, and only names a TypeScript
 * source that this step compiled; a TypeScript module's extensionless specifier must name one.
 */
const resolveCompiledSpecifier = (
  importer: string,
  packageDirectory: string,
  packageIsModule: boolean,
  compiledPaths: ReadonlySet<string>,
  importerIsTypeScript: boolean,
  specifier: string,
): SpecifierResolution => {
  if (!RELATIVE_SPECIFIER.test(specifier)) {
    return undefined;
  }
  const target = path.resolve(path.dirname(importer), specifier);
  if (target !== packageDirectory && !isInside(packageDirectory, target)) {
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
  if (importerIsTypeScript) {
    return resolved === undefined
      ? failed(`${importer}: ${specifier} resolves to no compiled module`)
      : `./${path.relative(path.dirname(importer), resolved)}`;
  }
  // Node's extensionless lookup takes a native `.js` (or its index) before anything else, so a native module's
  // specifier is rewritten only when the TypeScript module it names is the one Node would otherwise miss.
  const javaScript = [`${target}${MODULE_EXTENSION}`, path.join(target, `index${MODULE_EXTENSION}`)];
  if (resolved === undefined || javaScript.some((candidate) => compiledPaths.has(candidate))) {
    return undefined;
  }
  return `./${path.relative(path.dirname(importer), resolved)}`;
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
const nodeImportTarget = (target: PackagedExportTarget, viaRequire: boolean): string | undefined => {
  if (Predicate.isString(target)) {
    return target;
  }
  const candidates = isExportTargetList(target)
    ? target
    : Object.entries(target)
        .filter(([condition]) =>
          ['node', 'node-addons', 'module-sync', 'default', viaRequire ? 'require' : 'import'].includes(condition),
        )
        .map(([, entry]) => entry);
  for (const entry of candidates) {
    const selected = nodeImportTarget(entry, viaRequire);
    if (selected !== undefined) {
      return selected;
    }
  }
  return undefined;
};

/** The text a `*` import key captures from `specifier`, or `undefined` when the key is not a matching pattern. */
const importPatternCapture = (key: string, specifier: string): string | undefined => {
  const star = key.indexOf('*');
  if (star === -1 || key.lastIndexOf('*') !== star) {
    return undefined;
  }
  const prefix = key.slice(0, star);
  const suffix = key.slice(star + 1);
  return specifier.length >= key.length && specifier.startsWith(prefix) && specifier.endsWith(suffix)
    ? specifier.slice(prefix.length, specifier.length - suffix.length)
    : undefined;
};

/** The import-map entry Node selects, with the text a matching `*` key captured (absent for an exact key). */
interface SelectedImportEntry {
  readonly capture?: string;
  readonly entry: PackagedExportTarget;
}

/** Node's choice: an exact key first, else the matching `*` key with the longest prefix, then the longest key. */
const selectImportEntry = (
  specifier: string,
  imports: PackagedExportTarget | undefined,
): SelectedImportEntry | undefined => {
  if (imports === undefined || !isExportTargetConditions(imports)) {
    return undefined;
  }
  const exact = specifier.includes('*') ? undefined : imports[specifier];
  if (exact !== undefined) {
    return { entry: exact };
  }
  const [key] = Object.keys(imports)
    .filter((candidate) => importPatternCapture(candidate, specifier) !== undefined)
    .toSorted((left, right) => right.indexOf('*') - left.indexOf('*') || right.length - left.length);
  if (key === undefined) {
    return undefined;
  }
  const entry = imports[key];
  return entry === undefined ? undefined : { capture: importPatternCapture(key, specifier), entry };
};

const privateImportTarget = (
  specifier: string,
  imports: PackagedExportTarget | undefined,
  viaRequire: boolean,
): SpecifierResolution => {
  if (!specifier.startsWith('#')) {
    return undefined;
  }
  const selected = selectImportEntry(specifier, imports);
  const target = selected === undefined ? undefined : nodeImportTarget(selected.entry, viaRequire);
  if (selected === undefined || target === undefined) {
    return failed(`${specifier}: no declared Node package-import target`);
  }
  // Node fills every `*` in the target with the text the key captured.
  return selected.capture === undefined ? target : target.split('*').join(selected.capture);
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

/**
 * Completes missing relative and private-import TypeScript inputs at build time, never at runtime. A package the unit
 * declares resolves its build input from the unit; a package carried for another packaged package passes the manifest
 * of the install that package declares.
 */
const completeTracedModuleGraph = (
  unitDirectory: string,
  packageDirectory: string,
  name: string,
  packageIsModule: boolean,
  packagedManifest: typeof PackagedPackageManifestSchema.Type,
  declaredSourceManifest: string | undefined,
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
          module.commonJs,
          (specifier, viaRequire): SpecifierResolution => {
            const privateTarget = privateImportTarget(specifier, packagedManifest.imports, viaRequire);
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
        const sourceManifestPath =
          declaredSourceManifest ??
          (yield* Effect.try({
            catch: () => failed(`${packageName}: the declared build dependency could not be resolved`),
            try: () => findPackageJSON(packageName, pathToFileURL(path.join(unitDirectory, PACKAGE_MANIFEST))),
          }));
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
)(function* compilePackagedWorkspacePackage(
  unitDirectory: string,
  packageDirectory: string,
  name: string,
  declaredSourceManifest: string | undefined,
) {
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
  const modules = yield* completeTracedModuleGraph(
    unitDirectory,
    packageDirectory,
    name,
    packageIsModule,
    manifest,
    declaredSourceManifest,
  );
  const compiledPaths = new Set(modules.map((module) => module.outputPath));
  yield* Effect.forEach(
    modules,
    (module) =>
      compileTracedModule(module, (specifier) =>
        resolveCompiledSpecifier(
          module.sourcePath,
          packageDirectory,
          packageIsModule,
          compiledPaths,
          module.typescript,
          specifier,
        ),
      ),
    { concurrency: 1, discard: true },
  );
  const compiledTypeScriptPaths = new Set(
    modules.filter((module) => module.typescript).map((module) => module.outputPath),
  );
  const repointExport = (specifier: string) =>
    compiledExportTarget(packageDirectory, packageIsModule, compiledTypeScriptPaths, specifier);
  const repointPattern = (specifier: string) =>
    compiledPatternTarget(packageDirectory, packageIsModule, modules, specifier);
  const exportsRewrite = rewriteManifestTargets(manifest[MANIFEST_EXPORTS], () => repointExport);
  const importsRewrite = rewriteManifestTargets(manifest[MANIFEST_IMPORTS], (subpath) =>
    subpath.includes('*') ? repointPattern : repointExport,
  );
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

/** The `exports` subpath of a package's root entry, in `package.json` and in an import specifier. */
const ROOT_EXPORT = '.';
/** The manifest fields a package declares its installs in. */
const DECLARING_MANIFEST_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;

/** A bare `@app/<name>[/<subpath>]` specifier split into the package directory name and its `exports` subpath. */
const workspaceSpecifierParts = (
  specifier: string,
): { readonly name: string; readonly subpath: string } | undefined => {
  const scope = `${WORKSPACE_PACKAGE_SCOPE}/`;
  if (!specifier.startsWith(scope)) {
    return undefined;
  }
  const [name = '', ...rest] = specifier.slice(scope.length).split('/');
  return name === '' ? undefined : { name, subpath: rest.length === 0 ? ROOT_EXPORT : `./${rest.join('/')}` };
};

/** Whether a manifest declares an install of `packageName`. */
const declaresInstall = (manifest: typeof PackagedPackageManifestSchema.Type, packageName: string): boolean =>
  DECLARING_MANIFEST_FIELDS.some((field) => {
    const declared = manifest[field];
    return Predicate.isObject(declared) && Object.hasOwn(declared, packageName);
  });

/** The `exports` target Node selects for an import of `subpath`, or `undefined` when the package exports none. */
const exportImportTarget = (
  manifest: typeof PackagedPackageManifestSchema.Type,
  subpath: string,
): string | undefined => {
  const exportsField = manifest[MANIFEST_EXPORTS];
  let entry: PackagedExportTarget | undefined;
  if (isExportTargetConditions(exportsField) && Object.keys(exportsField).every((key) => key.startsWith(ROOT_EXPORT))) {
    entry = exportsField[subpath];
  } else if (subpath === ROOT_EXPORT) {
    entry = exportsField;
  }
  return entry === undefined ? undefined : nodeImportTarget(entry, false);
};

/** Every static ES module `import` / `export … from` specifier of one compiled module. */
const staticImportSpecifiers = (file: string, code: string) =>
  Effect.gen(function* readStaticImportSpecifiers() {
    const parsed = parseSync(file, code, { lang: 'js', sourceType: 'module' });
    if (parsed.errors.length > 0) {
      return yield* Effect.fail(failed(`${file}: the compiled module does not parse`));
    }
    const specifiers: string[] = [];
    const record = (literal: { readonly value?: unknown } | null) => {
      if (literal !== null && Predicate.isString(literal.value)) {
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

const readPackagedManifest = (manifestPath: string) =>
  Effect.gen(function* readPackageManifest() {
    const fs = yield* FileSystem.FileSystem;
    return yield* Schema.decodeUnknownEffect(packagedPackageManifestCodec)(yield* fs.readFileString(manifestPath)).pipe(
      Effect.mapError((cause) => failed(`${manifestPath}: ${String(cause)}`)),
    );
  });

/** One bare `@app/*` import a compiled packaged module makes. */
interface WorkspaceImport {
  /** The compiled module that imports it. */
  readonly file: string;
  /** The importing package's directory name under `@app`. */
  readonly importer: string;
  /** The imported package's directory name under `@app`. */
  readonly name: string;
  readonly specifier: string;
  /** The `exports` subpath the specifier names. */
  readonly subpath: string;
}

/** Every bare `@app/*` static ES module import of one packaged workspace package's compiled and native modules. */
const workspaceImportsOf = (tracedScope: string, importer: string) =>
  Effect.gen(function* collectWorkspaceImports() {
    const fs = yield* FileSystem.FileSystem;
    const directory = path.join(tracedScope, importer);
    const manifest = yield* readPackagedManifest(path.join(directory, PACKAGE_MANIFEST));
    const modules = yield* collectTracedModules(directory, manifest[MANIFEST_TYPE] === MODULE_MANIFEST_TYPE);
    const imports: WorkspaceImport[] = [];
    // CommonJS `require` edges are traced as written; only static ES module edges link at load time.
    for (const module of modules.filter((candidate) => !candidate.commonJs)) {
      const file = module.typescript ? module.outputPath : module.sourcePath;
      // A source carried earlier in this pass is compiled, then scanned, by the next pass.
      if (!(yield* fs.exists(file))) {
        continue;
      }
      for (const specifier of yield* staticImportSpecifiers(file, yield* fs.readFileString(file))) {
        const parts = workspaceSpecifierParts(specifier);
        if (parts !== undefined) {
          imports.push({ file, importer, name: parts.name, specifier, subpath: parts.subpath });
        }
      }
    }
    return imports;
  });

/** Whether the packaged tree already answers an import: its package holds the exported entry, or exports none. */
const packagedTreeAnswers = (tracedScope: string, workspaceImport: WorkspaceImport) =>
  Effect.gen(function* checkPackagedImport() {
    const fs = yield* FileSystem.FileSystem;
    const packageDirectory = path.join(tracedScope, workspaceImport.name);
    const manifestPath = path.join(packageDirectory, PACKAGE_MANIFEST);
    if (!(yield* fs.exists(manifestPath))) {
      return false;
    }
    const target = exportImportTarget(yield* readPackagedManifest(manifestPath), workspaceImport.subpath);
    // An unexported subpath is the dependency closure's to judge, with Node's own error.
    return target === undefined || (yield* fs.exists(path.resolve(packageDirectory, target)));
  });

/** The `package.json` of the install a packaged workspace package was built from. */
const buildInputManifestOf = (unit: string, name: string, declaredSources: ReadonlyMap<string, string>) =>
  Effect.gen(function* resolveBuildInputManifest() {
    const carried = declaredSources.get(name);
    if (carried !== undefined) {
      return carried;
    }
    const packageName = `${WORKSPACE_PACKAGE_SCOPE}/${name}`;
    const manifestPath = yield* Effect.try({
      catch: () => failed(`${packageName}: the declared build dependency could not be resolved`),
      try: () => findPackageJSON(packageName, pathToFileURL(path.join(unit, PACKAGE_MANIFEST))),
    });
    return (
      manifestPath ?? (yield* Effect.fail(failed(`${packageName}: missing the declared build dependency manifest`)))
    );
  });

/** The install of an imported workspace package that its importing package declares, resolved from that package. */
const declaredWorkspaceInstall = (
  unit: string,
  workspaceImport: WorkspaceImport,
  declaredSources: ReadonlyMap<string, string>,
) =>
  Effect.gen(function* resolveDeclaredWorkspaceInstall() {
    const fs = yield* FileSystem.FileSystem;
    const importerName = `${WORKSPACE_PACKAGE_SCOPE}/${workspaceImport.importer}`;
    const packageName = `${WORKSPACE_PACKAGE_SCOPE}/${workspaceImport.name}`;
    const importerSourceManifest = yield* buildInputManifestOf(unit, workspaceImport.importer, declaredSources);
    if (!declaresInstall(yield* readPackagedManifest(importerSourceManifest), packageName)) {
      return yield* Effect.fail(
        failed(
          `${workspaceImport.file}: imports ${workspaceImport.specifier}, but ${importerName} declares no install of ${packageName}`,
        ),
      );
    }
    const sourceManifestPath = yield* Effect.try({
      catch: () => failed(`${packageName}: the install ${importerName} declares could not be resolved`),
      try: () => findPackageJSON(packageName, pathToFileURL(importerSourceManifest)),
    });
    if (sourceManifestPath === undefined) {
      return yield* Effect.fail(failed(`${packageName}: the install ${importerName} declares is missing`));
    }
    const directory = yield* fs.realPath(path.dirname(sourceManifestPath));
    const packagedOutput = yield* fs.realPath(path.join(unit, PACKAGED_DIRECTORY));
    if (directory === packagedOutput || isInside(packagedOutput, directory)) {
      return yield* Effect.fail(failed(`${packageName}: build inputs must not resolve through the packaged output`));
    }
    const manifestPath = path.join(directory, PACKAGE_MANIFEST);
    const manifest = yield* readPackagedManifest(manifestPath);
    if (manifest.name !== packageName) {
      return yield* Effect.fail(failed(`${manifestPath}: the declared install is not ${packageName}`));
    }
    return { directory, manifest, manifestPath, packageName };
  });

/** The regular, package-owned runtime file an install exports for `subpath`. */
const exportedEntryOf = (
  install: Effect.Success<ReturnType<typeof declaredWorkspaceInstall>>,
  workspaceImport: WorkspaceImport,
) =>
  Effect.gen(function* resolveExportedEntry() {
    const fs = yield* FileSystem.FileSystem;
    const target = exportImportTarget(install.manifest, workspaceImport.subpath);
    if (target === undefined) {
      return yield* Effect.fail(
        failed(`${workspaceImport.file}: ${workspaceImport.specifier} is not exported by ${install.packageName}`),
      );
    }
    const entry = path.resolve(install.directory, target);
    if (
      !RELATIVE_SPECIFIER.test(target) ||
      !isInside(install.directory, entry) ||
      !isRuntimeModule(path.extname(entry))
    ) {
      return yield* Effect.fail(
        failed(`${install.packageName}: ${workspaceImport.subpath} is not a runtime module in its package`),
      );
    }
    const real = yield* fs.realPath(entry);
    if (!isInside(install.directory, real) || (yield* fs.lstat(entry)).type !== 'File') {
      return yield* Effect.fail(failed(`${entry}: an imported entry must be a regular package-owned file`));
    }
    return { real, relative: path.relative(install.directory, entry) };
  });

/** Carries one unanswered import's package manifest and exported entry. Returns how many files it wrote. */
const carryWorkspaceImport = (
  unit: string,
  tracedScope: string,
  workspaceImport: WorkspaceImport,
  declaredSources: Map<string, string>,
) =>
  Effect.gen(function* carryOneWorkspaceImport() {
    const fs = yield* FileSystem.FileSystem;
    if (yield* packagedTreeAnswers(tracedScope, workspaceImport)) {
      return 0;
    }
    const install = yield* declaredWorkspaceInstall(unit, workspaceImport, declaredSources);
    const packageDirectory = path.join(tracedScope, workspaceImport.name);
    const packagedManifestPath = path.join(packageDirectory, PACKAGE_MANIFEST);
    let written = 0;
    if (!(yield* fs.exists(packagedManifestPath))) {
      yield* fs.makeDirectory(packageDirectory, { recursive: true });
      yield* fs.writeFileString(packagedManifestPath, yield* fs.readFileString(install.manifestPath));
      declaredSources.set(workspaceImport.name, install.manifestPath);
      written += 1;
    } else if ((declaredSources.get(workspaceImport.name) ?? install.manifestPath) !== install.manifestPath) {
      return yield* Effect.fail(
        failed(
          `${install.packageName}: two declaring packages resolve different installs; the packaged tree keeps one`,
        ),
      );
    }
    const entry = yield* exportedEntryOf(install, workspaceImport);
    const target = path.join(packageDirectory, entry.relative);
    if (!(yield* fs.exists(target))) {
      yield* ensurePackagedSourceParent(packageDirectory, entry.relative);
      yield* fs.writeFileString(target, yield* fs.readFileString(entry.real));
      written += 1;
    }
    return written;
  });

/**
 * Carries the workspace inputs a compiled packaged module imports by bare `@app/*` specifier but the packaged tree
 * does not hold. The trace cannot parse TypeScript, so a workspace package that only another workspace package's
 * TypeScript imports never reaches `.output`. The importing package must declare the install, which is resolved from
 * that package's own build input; the carried package's manifest and the imported entry are copied verbatim, and the
 * compile pass that follows completes their relative graph from the same install. Returns how many files it carried.
 */
const carryDeclaredWorkspaceImports = Effect.fn('MaterializePackagedWorkspacePackages.carryDeclaredWorkspaceImports')(
  function* carryDeclaredWorkspaceImports(unit: string, tracedScope: string, declaredSources: Map<string, string>) {
    const fs = yield* FileSystem.FileSystem;
    let carriedFiles = 0;
    for (const importer of (yield* fs.readDirectory(tracedScope)).toSorted()) {
      for (const workspaceImport of yield* workspaceImportsOf(tracedScope, importer)) {
        carriedFiles += yield* carryWorkspaceImport(unit, tracedScope, workspaceImport, declaredSources);
      }
    }
    return carriedFiles;
  },
);

/**
 * Compiles every workspace package the unit traced into `.output/node_modules`, carrying in the declared workspace
 * imports the trace could not follow until the compiled graph names nothing the packaged tree lacks. Idempotent: a
 * unit without a packaged output, or one whose modules are already compiled and repointed, reports nothing to change.
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
  /** Carried package directory name → the manifest of the install its declaring package resolves. */
  const declaredSources = new Map<string, string>();
  while (true) {
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
      packages.push(yield* compilePackagedWorkspacePackage(unit, packageDirectory, name, declaredSources.get(name)));
    }
    // Every pass carries at least one new file or stops, so the loop ends with the workspace graph closed.
    if ((yield* carryDeclaredWorkspaceImports(unit, tracedScope, declaredSources)) === 0) {
      return { packages } satisfies PackagedWorkspaceCompilation;
    }
  }
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
