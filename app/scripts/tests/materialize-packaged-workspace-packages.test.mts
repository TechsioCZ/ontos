import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Effect, Exit, Option, Predicate, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { compilePackagedWorkspacePackages, PACKAGED_DIRECTORY } from '../materialize-packaged-workspace-packages.mts';

const ENCODING = 'utf-8';
const PACKAGE_MANIFEST = 'package.json';
const PROBE = 'probe.mjs';
/** The subpath a package publishes its root entry under, in `package.json` and in an import specifier. */
const ROOT_EXPORT = '.';
const ENTRY_SUBPATH = './src/index.ts';
const ENTRY_SOURCE = 'src/index.ts';
const ENTRY_OUTPUT = 'src/index.js';

const PACKAGED_CONTRACTS = '@app/packaged-contracts';
const TRACED_CONTRACTS = '@app/traced-contracts';
const COLLIDING_CONTRACTS = '@app/colliding-contracts';
const DANGLING_CONTRACTS = '@app/dangling-contracts';
const STABLE_CONTRACTS = '@app/stable-contracts';
const RELATIVE_CONTRACTS = '@app/relative-contracts';
const COMMONJS_CONTRACTS = '@app/commonjs-contracts';
const TOP_LEVEL_RETURN_CONTRACTS = '@app/top-level-return-contracts';
const PATTERN_CONTRACTS = '@app/pattern-contracts';
const NESTED_SCOPE_CONTRACTS = '@app/nested-scope-contracts';
const SELECTION_CONTRACTS = '@app/selection-contracts';
const BOOTSTRAP_SOURCE = 'src/bootstrap.cjs';
const BOOTSTRAP_IMPORT = "import bootstrap from './bootstrap.cjs'; export const origin = bootstrap.origin;\n";

/** A traced workspace package manifest, as this step reads it. */
interface WorkspacePackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly exports: Readonly<Record<string, string>>;
  readonly imports?: Readonly<Record<string, string | Readonly<Record<string, string>>>>;
  readonly name: string;
  readonly type?: string;
  readonly version: string;
}

const manifestOf = (name: string, exports: Readonly<Record<string, string>>): WorkspacePackageManifest => ({
  exports,
  name,
  type: 'module',
  version: '0.1.0',
});

/** A package without a `type`, so Node reads its `.js` files as CommonJS. */
const untypedManifestOf = (name: string, exports: Readonly<Record<string, string>>): WorkspacePackageManifest => ({
  exports,
  name,
  version: '0.1.0',
});

/** Writes one `@app/*` package: its manifest, then every file below it keyed by path inside the package. */
const writeWorkspacePackage = async (
  nodeModulesDirectory: string,
  manifest: WorkspacePackageManifest,
  files: Readonly<Record<string, string>>,
) => {
  // The package name is its install path: `@app/contracts` installs as `node_modules/@app/contracts`.
  const directory = path.join(nodeModulesDirectory, manifest.name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, PACKAGE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  await Promise.all(
    Object.entries(files).map(async ([relative, text]) => {
      const file = path.join(directory, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
    }),
  );
  return directory;
};

/** The traced install one unit's packaged output resolves `@app/*` through. */
const packagedNodeModules = (unit: string) => path.join(unit, PACKAGED_DIRECTORY, 'node_modules');

const unitUnder = (root: string) => path.join(root, 'apps', 'shell-super-app');

const PackageManifestDocument = Schema.fromJsonString(
  Schema.Struct({ exports: Schema.Record(Schema.String, Schema.String) }),
);

const readExports = async (directory: string) => {
  const manifestText = await readFile(path.join(directory, PACKAGE_MANIFEST), ENCODING);
  return Result.getOrThrow(Schema.decodeUnknownResult(PackageManifestDocument)(manifestText)).exports;
};

const OriginObservation = Schema.fromJsonString(Schema.Struct({ origin: Schema.String, resolved: Schema.String }));
const TracedObservation = Schema.fromJsonString(
  Schema.Struct({ deep: Schema.String, helper: Schema.Number, legacy: Schema.String, nested: Schema.String }),
);

/** Runs a probe inside the packaged tree, so `@app/*` resolves through `.output/node_modules`. */
const runProbe = (packagedDirectory: string) => {
  const result = spawnSync(process.execPath, [PROBE], { cwd: packagedDirectory, encoding: ENCODING });
  return { status: result.status, stderr: result.stderr ?? '', stdout: result.stdout ?? '' };
};

/** A probe that reports which copy of a package Node loaded, and the file it resolved. */
const originProbe = (name: string) =>
  [
    `const { origin } = await import('${name}');`,
    `process.stdout.write(JSON.stringify({ origin, resolved: import.meta.resolve('${name}') }));`,
    '',
  ].join('\n');

const writeProbe = (packagedDirectory: string, source: string) =>
  writeFile(path.join(packagedDirectory, PROBE), source);

const resolvedInsidePackaged = (resolved: string, packagedDirectory: string) =>
  resolved.startsWith(pathToFileURL(realpathSync(packagedDirectory)).href);

/** The message of the typed refusal a build ended with, or `undefined` when it did not fail with one. */
const refusalOf = (exit: Exit.Exit<unknown, unknown>) => {
  const error = Option.getOrUndefined(Exit.findErrorOption(exit));
  return Predicate.hasProperty(error, 'message') && Predicate.isString(error.message) ? error.message : undefined;
};

/** Deletes every TypeScript source below `directory`, so only what this step compiled remains to be loaded. */
const removeTypeScriptSources = async (directory: string) => {
  const relativePaths = await readdir(directory, { recursive: true });
  await Promise.all(
    relativePaths
      .filter((relative) => /\.(?:c|m)?tsx?$/u.test(relative) && !relative.endsWith('.d.ts'))
      .map((relative) => rm(path.join(directory, relative))),
  );
};

/** Every path below `directory`, mapped to its text, so two runs can be compared byte for byte. */
const snapshotTree = async (directory: string) => {
  const relativePaths = await readdir(directory, { recursive: true });
  const entries = await Promise.all(
    relativePaths.toSorted().map(async (relative): Promise<[string, string]> => {
      const absolute = path.join(directory, relative);
      return [relative, statSync(absolute).isFile() ? await readFile(absolute, ENCODING) : ''];
    }),
  );
  return Object.fromEntries(entries);
};

const temporaryRoot = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(path.join(tmpdir(), 'ontos-packaged-workspace-'))),
  (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
);

it.effect('loads the packaged copy from inside .output instead of the installed workspace copy', () =>
  Effect.gen(function* loadsPackagedCopy() {
    const root = yield* temporaryRoot;
    const unit = unitUnder(root);
    const packaged = path.join(unit, PACKAGED_DIRECTORY);
    // The installed workspace carries the same package with a different value, so the probe says which won.
    const installed = yield* Effect.promise(() =>
      writeWorkspacePackage(path.join(unit, 'node_modules'), manifestOf(PACKAGED_CONTRACTS, { '.': ENTRY_SUBPATH }), {
        [ENTRY_SOURCE]: "export const origin = 'installed-workspace';\n",
      }),
    );
    const traced = yield* Effect.promise(() =>
      writeWorkspacePackage(
        packagedNodeModules(unit),
        manifestOf(PACKAGED_CONTRACTS, { '.': ENTRY_SUBPATH, './value': './src/value.ts' }),
        {
          [ENTRY_SOURCE]: "export { origin } from './value.ts';\n",
          'src/value.ts': "export const origin = 'packaged-output';\n",
        },
      ),
    );
    yield* Effect.promise(() => writeProbe(packaged, originProbe(PACKAGED_CONTRACTS)));

    // Node refuses to strip types under `node_modules`, so the traced copy is unloadable before this step.
    expect(runProbe(packaged).stderr).toContain('ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING');

    const compilation = yield* compilePackagedWorkspacePackages(unit);
    expect(compilation.packages).toHaveLength(1);
    expect(compilation.packages[0]?.repointed).toEqual([ROOT_EXPORT, './value']);

    const after = runProbe(packaged);
    expect(after.status).toBe(0);
    const observed = Result.getOrThrow(Schema.decodeUnknownResult(OriginObservation)(after.stdout));
    expect(observed.origin).toBe('packaged-output');
    expect(resolvedInsidePackaged(observed.resolved, packaged)).toBe(true);
    // Nothing is deleted, and the installed workspace copy is neither read nor written.
    expect(existsSync(path.join(traced, ENTRY_SOURCE))).toBe(true);
    expect(existsSync(path.join(installed, ENTRY_OUTPUT))).toBe(false);
    expect(existsSync(path.join(installed, ENTRY_SOURCE))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('runs private package imports through their compiled Node condition without changing other conditions', () =>
  Effect.gen(function* compilesPrivateImports() {
    const root = yield* temporaryRoot;
    const unit = unitUnder(root);
    const packaged = path.join(unit, PACKAGED_DIRECTORY);
    const directory = yield* Effect.promise(() =>
      writeWorkspacePackage(
        packagedNodeModules(unit),
        {
          ...manifestOf(PACKAGED_CONTRACTS, { '.': ENTRY_SUBPATH }),
          imports: {
            '#database-runtime': Object.fromEntries([
              ['workerd', './src/database-runtime.workerd.ts'],
              ['default', './src/database-runtime.node.ts'],
            ]),
            '#external': 'node:path',
            '#unit-service-fetch': Object.fromEntries([
              ['types', './src/unit-service-fetch.d.ts'],
              ['workerd', './src/unit-service-fetch.workerd.ts'],
              ['node', './src/unit-service-fetch.node.ts'],
            ]),
          },
        },
        {
          [ENTRY_SOURCE]:
            "import { origin } from '#database-runtime'; import { suffix } from '#unit-service-fetch'; export const value = origin + suffix;\n",
          'src/database-runtime.node.ts': "export const origin: string = 'native';\n",
          'src/unit-service-fetch.d.ts': 'export declare const suffix: string;\n',
          'src/unit-service-fetch.node.ts': "export const suffix: string = '-node';\n",
        },
      ),
    );
    yield* Effect.promise(() =>
      writeProbe(packaged, `const { value } = await import('${PACKAGED_CONTRACTS}'); process.stdout.write(value);`),
    );
    const report = yield* compilePackagedWorkspacePackages(unit);
    expect(report.packages[0]?.repointed).toEqual(['.', '#database-runtime', '#unit-service-fetch']);
    const { imports } = Result.getOrThrow(
      Schema.decodeUnknownResult(
        Schema.fromJsonString(
          Schema.Struct({
            imports: Schema.Record(
              Schema.String,
              Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)]),
            ),
          }),
        ),
      )(yield* Effect.promise(() => readFile(path.join(directory, PACKAGE_MANIFEST), ENCODING))),
    );
    expect(JSON.stringify(imports)).toBe(
      JSON.stringify({
        '#database-runtime': Object.fromEntries([
          ['workerd', './src/database-runtime.workerd.ts'],
          ['default', './src/database-runtime.node.js'],
        ]),
        '#external': 'node:path',
        '#unit-service-fetch': Object.fromEntries([
          ['types', './src/unit-service-fetch.d.ts'],
          ['workerd', './src/unit-service-fetch.workerd.ts'],
          ['node', './src/unit-service-fetch.node.js'],
        ]),
      }),
    );
    const after = runProbe(packaged);
    expect(after.stderr).toBe('');
    expect(after.status).toBe(0);
    expect(after.stdout).toBe('native-node');
    const snapshot = yield* Effect.promise(() => snapshotTree(directory));
    yield* compilePackagedWorkspacePackages(unit);
    expect(yield* Effect.promise(() => snapshotTree(directory))).toEqual(snapshot);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('compiles a packaged unit that has no installed workspace beside it', () =>
  Effect.gen(function* compilesWithoutInstalledWorkspace() {
    const root = yield* temporaryRoot;
    const unit = unitUnder(root);
    const packaged = path.join(unit, PACKAGED_DIRECTORY);
    yield* Effect.promise(() =>
      writeWorkspacePackage(packagedNodeModules(unit), manifestOf(PACKAGED_CONTRACTS, { '.': ENTRY_SUBPATH }), {
        [ENTRY_SOURCE]: "export const origin = 'packaged-only';\n",
      }),
    );
    yield* Effect.promise(() => writeProbe(packaged, originProbe(PACKAGED_CONTRACTS)));
    expect(existsSync(path.join(unit, 'node_modules'))).toBe(false);

    yield* compilePackagedWorkspacePackages(unit);

    const after = runProbe(packaged);
    expect(after.status).toBe(0);
    const observed = Result.getOrThrow(Schema.decodeUnknownResult(OriginObservation)(after.stdout));
    expect(observed.origin).toBe('packaged-only');
    expect(resolvedInsidePackaged(observed.resolved, packaged)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('compiles a unit addressed by a path relative to the working directory', () =>
  Effect.gen(function* compilesRelativeUnit() {
    const root = yield* temporaryRoot;
    const unit = unitUnder(root);
    const packaged = path.join(unit, PACKAGED_DIRECTORY);
    yield* Effect.promise(() =>
      writeWorkspacePackage(packagedNodeModules(unit), manifestOf(RELATIVE_CONTRACTS, { '.': ENTRY_SUBPATH }), {
        [ENTRY_SOURCE]: "export const origin = 'relative-unit';\n",
      }),
    );
    yield* Effect.promise(() => writeProbe(packaged, originProbe(RELATIVE_CONTRACTS)));

    // The shell app's build hook runs this step from the app directory as `node … .`, so the unit is relative.
    const compilation = yield* compilePackagedWorkspacePackages(path.relative(process.cwd(), unit));

    expect(compilation.packages[0]?.repointed).toEqual([ROOT_EXPORT]);
    const after = runProbe(packaged);
    expect(after.status).toBe(0);
    expect(Result.getOrThrow(Schema.decodeUnknownResult(OriginObservation)(after.stdout)).origin).toBe('relative-unit');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('compiles the traced module graph and repoints every exports target at the compiled module', () =>
  Effect.gen(function* repointsExports() {
    const root = yield* temporaryRoot;
    const unit = unitUnder(root);
    const packaged = path.join(unit, PACKAGED_DIRECTORY);
    const directory = yield* Effect.promise(() =>
      writeWorkspacePackage(
        packagedNodeModules(unit),
        manifestOf(TRACED_CONTRACTS, {
          '.': ENTRY_SUBPATH,
          './legacy': './src/legacy.cts',
          './nested/deep': './src/nested/deep.mts',
          './untraced': './src/untraced.ts',
        }),
        {
          [ENTRY_SOURCE]: [
            "export { helper } from './helper.ts';",
            "export { legacy } from './legacy.cts';",
            "export const deep = async () => (await import('./nested/deep.mts')).deep;",
            '',
          ].join('\n'),
          'src/declaration.d.ts': 'export declare const unused: string;\n',
          'src/helper.ts': 'export const helper = 41;\n',
          'src/legacy-value.cts': "exports.legacy = 'legacy-commonjs';\n",
          'src/legacy.cts': "const { legacy } = require('./legacy-value.cts'); exports.legacy = legacy;\n",
          'src/nested/deep.mts': "export const deep = 'deep-esm';\n",
        },
      ),
    );

    const compilation = yield* compilePackagedWorkspacePackages(unit);

    expect(yield* Effect.promise(() => readExports(directory))).toEqual({
      '.': './src/index.js',
      './legacy': './src/legacy.cjs',
      './nested/deep': './src/nested/deep.mjs',
      './untraced': './src/untraced.ts',
    });
    expect(compilation.packages[0]?.repointed).toEqual([ROOT_EXPORT, './legacy', './nested/deep']);
    expect(compilation.packages[0]?.untraced).toEqual(['./untraced']);
    // A declaration file carries no runtime module, so it is never compiled.
    expect(existsSync(path.join(directory, 'src', 'declaration.d.js'))).toBe(false);
    expect(yield* Effect.promise(() => readFile(path.join(directory, ENTRY_OUTPUT), ENCODING))).toBe(
      [
        'import { helper } from "./helper.js";',
        'import { legacy } from "./legacy.cjs";',
        'const deep = async () => (await import("./nested/deep.mjs")).deep;',
        'export {',
        '  deep,',
        '  helper,',
        '  legacy',
        '};',
        '',
      ].join('\n'),
    );

    yield* Effect.promise(() =>
      writeProbe(
        packaged,
        [
          `const { deep, helper, legacy } = await import('${TRACED_CONTRACTS}');`,
          `const { deep: nested } = await import('${TRACED_CONTRACTS}/nested/deep');`,
          'process.stdout.write(JSON.stringify({ deep: await deep(), helper, legacy, nested }));',
          '',
        ].join('\n'),
      ),
    );
    const after = runProbe(packaged);
    expect(after.status).toBe(0);
    expect(Result.getOrThrow(Schema.decodeUnknownResult(TracedObservation)(after.stdout))).toEqual({
      deep: 'deep-esm',
      helper: 41,
      legacy: 'legacy-commonjs',
      nested: 'deep-esm',
    });
    // Nothing is deleted: every traced TypeScript source stays beside the module compiled from it.
    expect(existsSync(path.join(directory, ENTRY_SOURCE))).toBe(true);
    expect(existsSync(path.join(directory, 'src', 'legacy.cts'))).toBe(true);
    expect(existsSync(path.join(directory, 'src', 'nested', 'deep.mts'))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('completes a partial trace from matching build inputs and runs with those inputs retired', () =>
  Effect.gen(function* completesRelativeBuildInputs() {
    const root = yield* temporaryRoot;
    const unit = unitUnder(root);
    const packaged = path.join(unit, PACKAGED_DIRECTORY);
    const entry = "export { origin } from './helper.ts';\n";
    const installed = yield* Effect.promise(() =>
      writeWorkspacePackage(path.join(unit, 'node_modules'), manifestOf(TRACED_CONTRACTS, { '.': ENTRY_SUBPATH }), {
        [ENTRY_SOURCE]: entry,
        'src/deep.ts': "export const origin = 'completed-at-build';\n",
        'src/helper.ts': "export { origin } from './deep.ts';\n",
      }),
    );
    const before = yield* Effect.promise(() => snapshotTree(installed));
    const traced = yield* Effect.promise(() =>
      writeWorkspacePackage(packagedNodeModules(unit), manifestOf(TRACED_CONTRACTS, { '.': ENTRY_SUBPATH }), {
        [ENTRY_SOURCE]: entry,
      }),
    );
    yield* Effect.promise(() => writeProbe(packaged, originProbe(TRACED_CONTRACTS)));

    const compilation = yield* compilePackagedWorkspacePackages(unit);

    expect(compilation.packages[0]?.compiled).toEqual(['src/deep.js', 'src/helper.js', ENTRY_OUTPUT]);
    expect(yield* Effect.promise(() => snapshotTree(installed))).toEqual(before);
    expect(existsSync(path.join(traced, 'src', 'deep.js'))).toBe(true);
    yield* Effect.promise(() => rename(installed, `${installed}-retired-build-input`));
    const after = runProbe(packaged);
    expect(after.status).toBe(0);
    const observed = Result.getOrThrow(Schema.decodeUnknownResult(OriginObservation)(after.stdout));
    expect(observed.origin).toBe('completed-at-build');
    expect(resolvedInsidePackaged(observed.resolved, packaged)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('carries a workspace package that only a traced package declares and imports from TypeScript', () =>
  Effect.gen(function* carriesDeclaredWorkspaceImport() {
    const root = yield* temporaryRoot;
    const unit = unitUnder(root);
    const packaged = path.join(unit, PACKAGED_DIRECTORY);
    const entry = "export { origin } from '@app/selection-contracts/reference';\n";
    const installed = yield* Effect.promise(() =>
      writeWorkspacePackage(
        path.join(unit, 'node_modules'),
        {
          ...manifestOf(TRACED_CONTRACTS, { '.': ENTRY_SUBPATH }),
          dependencies: { [SELECTION_CONTRACTS]: 'workspace:*' },
        },
        { [ENTRY_SOURCE]: entry },
      ),
    );
    // Only the traced package resolves the selection contracts: the unit does not declare them.
    const selection = yield* Effect.promise(() =>
      writeWorkspacePackage(
        path.join(installed, 'node_modules'),
        manifestOf(SELECTION_CONTRACTS, { '.': ENTRY_SUBPATH, './reference': './src/reference.ts' }),
        {
          [ENTRY_SOURCE]: "export const unused: string = 'root entry';\n",
          'src/origin.ts': "export const origin: string = 'carried-selection';\n",
          'src/reference.ts': "export { origin } from './origin.ts';\n",
        },
      ),
    );
    yield* Effect.promise(() =>
      writeWorkspacePackage(packagedNodeModules(unit), manifestOf(TRACED_CONTRACTS, { '.': ENTRY_SUBPATH }), {
        [ENTRY_SOURCE]: entry,
      }),
    );
    yield* Effect.promise(() => writeProbe(packaged, originProbe(TRACED_CONTRACTS)));

    const compilation = yield* compilePackagedWorkspacePackages(unit);

    const carried = path.join(packagedNodeModules(unit), SELECTION_CONTRACTS);
    expect(compilation.packages.map((report) => report.name)).toEqual(['selection-contracts', 'traced-contracts']);
    expect(compilation.packages[0]?.compiled).toEqual(['src/origin.js', 'src/reference.js']);
    // Only the imported entry and its relative graph are carried, never the package's other entries.
    expect(existsSync(path.join(carried, ENTRY_SOURCE))).toBe(false);
    expect(yield* Effect.promise(() => readExports(carried))).toEqual({
      '.': ENTRY_SUBPATH,
      './reference': './src/reference.js',
    });
    yield* Effect.promise(() => rename(selection, `${selection}-retired-build-input`));
    yield* Effect.promise(() => rename(installed, `${installed}-retired-build-input`));
    const after = runProbe(packaged);
    expect(after.stderr).toBe('');
    expect(after.status).toBe(0);
    expect(Result.getOrThrow(Schema.decodeUnknownResult(OriginObservation)(after.stdout)).origin).toBe(
      'carried-selection',
    );
    const again = yield* compilePackagedWorkspacePackages(unit).pipe(Effect.exit);
    expect(Exit.isSuccess(again) ? 'idempotent' : refusalOf(again)).toBe('idempotent');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('refuses a traced workspace import its importing package does not declare', () =>
  Effect.gen(function* refusesUndeclaredWorkspaceImport() {
    const root = yield* temporaryRoot;
    const unit = unitUnder(root);
    const entry = "export { origin } from '@app/selection-contracts';\n";
    const installed = yield* Effect.promise(() =>
      writeWorkspacePackage(path.join(unit, 'node_modules'), manifestOf(TRACED_CONTRACTS, { '.': ENTRY_SUBPATH }), {
        [ENTRY_SOURCE]: entry,
      }),
    );
    yield* Effect.promise(() =>
      writeWorkspacePackage(
        path.join(installed, 'node_modules'),
        manifestOf(SELECTION_CONTRACTS, { '.': ENTRY_SUBPATH }),
        {
          [ENTRY_SOURCE]: "export const origin = 'undeclared';\n",
        },
      ),
    );
    yield* Effect.promise(() =>
      writeWorkspacePackage(packagedNodeModules(unit), manifestOf(TRACED_CONTRACTS, { '.': ENTRY_SUBPATH }), {
        [ENTRY_SOURCE]: entry,
      }),
    );

    const exit = yield* compilePackagedWorkspacePackages(unit).pipe(Effect.exit);

    expect(refusalOf(exit)).toContain(`${TRACED_CONTRACTS} declares no install of ${SELECTION_CONTRACTS}`);
    expect(existsSync(path.join(packagedNodeModules(unit), SELECTION_CONTRACTS))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  'completes omitted Node private-import targets for both import and require without copying inactive branches',
  () =>
    Effect.gen(function* completesPrivateImportBuildInputs() {
      const root = yield* temporaryRoot;
      const unit = unitUnder(root);
      const packaged = path.join(unit, PACKAGED_DIRECTORY);
      const manifest: WorkspacePackageManifest = {
        ...manifestOf(TRACED_CONTRACTS, { '.': ENTRY_SUBPATH }),
        imports: {
          '#transport': Object.fromEntries([
            ['workerd', './src/transport.workerd.ts'],
            ['import', './src/transport.import.ts'],
            ['require', './src/transport.require.cts'],
            ['default', './src/transport.default.ts'],
          ]),
        },
      };
      const entry =
        "import { value } from '#transport'; import legacy from './legacy.cts'; export const origin = value + legacy.value;\n";
      const installed = yield* Effect.promise(() =>
        writeWorkspacePackage(path.join(unit, 'node_modules'), manifest, {
          [ENTRY_SOURCE]: entry,
          'src/legacy.cts': "module.exports = require('#transport');\n",
          'src/transport.import.ts': "export const value: string = 'import';\n",
          'src/transport.require.cts': "module.exports = { value: '-require' };\n",
        }),
      );
      const before = yield* Effect.promise(() => snapshotTree(installed));
      const traced = yield* Effect.promise(() =>
        writeWorkspacePackage(packagedNodeModules(unit), manifest, { [ENTRY_SOURCE]: entry }),
      );
      yield* Effect.promise(() => writeProbe(packaged, originProbe(TRACED_CONTRACTS)));
      yield* compilePackagedWorkspacePackages(unit);
      expect(existsSync(path.join(traced, 'src/transport.import.js'))).toBe(true);
      expect(existsSync(path.join(traced, 'src/transport.require.cjs'))).toBe(true);
      expect(existsSync(path.join(traced, 'src/transport.workerd.ts'))).toBe(false);
      expect(existsSync(path.join(traced, 'src/transport.default.ts'))).toBe(false);
      expect(yield* Effect.promise(() => snapshotTree(installed))).toEqual(before);
      yield* Effect.promise(() => rename(installed, `${installed}-retired-build-input`));
      const after = runProbe(packaged);
      expect(after.stderr).toBe('');
      expect(after.status).toBe(0);
      expect(Result.getOrThrow(Schema.decodeUnknownResult(OriginObservation)(after.stdout)).origin).toBe(
        'import-require',
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('completes omitted native CommonJS inputs and follows their own TypeScript dependencies', () =>
  Effect.gen(function* completesNativeJavaScriptInputs() {
    const root = yield* temporaryRoot;
    const unit = unitUnder(root);
    const packaged = path.join(unit, PACKAGED_DIRECTORY);
    const manifest = manifestOf(TRACED_CONTRACTS, { '.': ENTRY_SUBPATH });
    const entry = BOOTSTRAP_IMPORT;
    const installed = yield* Effect.promise(() =>
      writeWorkspacePackage(path.join(unit, 'node_modules'), manifest, {
        [BOOTSTRAP_SOURCE]: "module.exports = require('./nested/runtime.cjs');\n",
        [ENTRY_SOURCE]: entry,
        'src/nested/runtime.cjs': "module.exports = require('../value.cts');\n",
        'src/value.cts': "module.exports = { origin: 'completed-native-commonjs' };\n",
      }),
    );
    const before = yield* Effect.promise(() => snapshotTree(installed));
    const traced = yield* Effect.promise(() =>
      writeWorkspacePackage(packagedNodeModules(unit), manifest, { [ENTRY_SOURCE]: entry }),
    );
    yield* Effect.promise(() => writeProbe(packaged, originProbe(TRACED_CONTRACTS)));
    yield* compilePackagedWorkspacePackages(unit);
    expect(yield* Effect.promise(() => snapshotTree(installed))).toEqual(before);
    expect(yield* Effect.promise(() => readFile(path.join(traced, BOOTSTRAP_SOURCE), ENCODING))).toBe(
      "module.exports = require('./nested/runtime.cjs');\n",
    );
    expect(yield* Effect.promise(() => readFile(path.join(traced, 'src/nested/runtime.cjs'), ENCODING))).toBe(
      "module.exports = require('./../value.cjs');\n",
    );
    yield* Effect.promise(() => rename(installed, `${installed}-retired-build-input`));
    const after = runProbe(packaged);
    expect(after.stderr).toBe('');
    expect(after.status).toBe(0);
    expect(Result.getOrThrow(Schema.decodeUnknownResult(OriginObservation)(after.stdout)).origin).toBe(
      'completed-native-commonjs',
    );
    const snapshot = yield* Effect.promise(() => snapshotTree(traced));
    yield* compilePackagedWorkspacePackages(unit);
    expect(yield* Effect.promise(() => snapshotTree(traced))).toEqual(snapshot);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  'loads native CommonJS without a module type through extensionless requires to a .js, a .json, and a TypeScript file',
  () =>
    Effect.gen(function* loadsExtensionlessNativeRequires() {
      const root = yield* temporaryRoot;
      const unit = unitUnder(root);
      const packaged = path.join(unit, PACKAGED_DIRECTORY);
      const bootstrap =
        "const { origin: base } = require('./lib'); const { suffix } = require('./data'); const { helper } = require('./helper'); module.exports = { origin: base + suffix + helper };\n";
      const directory = yield* Effect.promise(() =>
        writeWorkspacePackage(
          packagedNodeModules(unit),
          untypedManifestOf(COMMONJS_CONTRACTS, { '.': ENTRY_SUBPATH }),
          {
            [BOOTSTRAP_SOURCE]: bootstrap,
            [ENTRY_SOURCE]: BOOTSTRAP_IMPORT,
            'src/data.json': '{ "suffix": "-json" }\n',
            'src/helper.ts': "export const helper = '-ts';\n",
            'src/lib.js': "module.exports = { origin: 'native' };\n",
          },
        ),
      );
      yield* Effect.promise(() => writeProbe(packaged, originProbe(COMMONJS_CONTRACTS)));

      const compilation = yield* compilePackagedWorkspacePackages(unit);

      expect(compilation.packages[0]?.compiled).toEqual(['src/helper.mjs', 'src/index.mjs']);
      expect(yield* Effect.promise(() => readExports(directory))).toEqual({ '.': './src/index.mjs' });
      // Node finds `lib.js` and `data.json` itself, so only the require of the TypeScript-only `helper` is rewritten.
      expect(yield* Effect.promise(() => readFile(path.join(directory, BOOTSTRAP_SOURCE), ENCODING))).toBe(
        bootstrap.replace("require('./helper')", "require('./helper.mjs')"),
      );
      yield* Effect.promise(() => removeTypeScriptSources(directory));
      const after = runProbe(packaged);
      expect(after.stderr).toBe('');
      expect(after.status).toBe(0);
      const observed = Result.getOrThrow(Schema.decodeUnknownResult(OriginObservation)(after.stdout));
      expect(observed.origin).toBe('native-json-ts');
      expect(resolvedInsidePackaged(observed.resolved, packaged)).toBe(true);
      const snapshot = yield* Effect.promise(() => snapshotTree(directory));
      yield* compilePackagedWorkspacePackages(unit);
      expect(yield* Effect.promise(() => snapshotTree(directory))).toEqual(snapshot);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('keeps native CommonJS with a top-level return loadable and rewrites its TypeScript require', () =>
  Effect.gen(function* keepsTopLevelReturn() {
    const root = yield* temporaryRoot;
    const unit = unitUnder(root);
    const packaged = path.join(unit, PACKAGED_DIRECTORY);
    const bootstrap = [
      "const { value } = require('./value.cts');",
      "if (value !== '') {",
      '  module.exports = { origin: value };',
      '  return;',
      '}',
      "module.exports = { origin: 'unreachable' };",
      '',
    ].join('\n');
    const directory = yield* Effect.promise(() =>
      writeWorkspacePackage(packagedNodeModules(unit), manifestOf(TOP_LEVEL_RETURN_CONTRACTS, { '.': ENTRY_SUBPATH }), {
        [BOOTSTRAP_SOURCE]: bootstrap,
        [ENTRY_SOURCE]: BOOTSTRAP_IMPORT,
        'src/value.cts': "exports.value = 'top-level-return';\n",
      }),
    );
    yield* Effect.promise(() => writeProbe(packaged, originProbe(TOP_LEVEL_RETURN_CONTRACTS)));

    const compilation = yield* compilePackagedWorkspacePackages(unit);

    expect(compilation.packages[0]?.compiled).toEqual([ENTRY_OUTPUT, 'src/value.cjs']);
    expect(yield* Effect.promise(() => readFile(path.join(directory, BOOTSTRAP_SOURCE), ENCODING))).toBe(
      bootstrap.replace("require('./value.cts')", "require('./value.cjs')"),
    );
    yield* Effect.promise(() => removeTypeScriptSources(directory));
    const after = runProbe(packaged);
    expect(after.stderr).toBe('');
    expect(after.status).toBe(0);
    expect(Result.getOrThrow(Schema.decodeUnknownResult(OriginObservation)(after.stdout))).toMatchObject({
      origin: 'top-level-return',
    });
    const snapshot = yield* Effect.promise(() => snapshotTree(directory));
    yield* compilePackagedWorkspacePackages(unit);
    expect(yield* Effect.promise(() => snapshotTree(directory))).toEqual(snapshot);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('keeps a native .js under a nested package.json type rather than the package root type', () =>
  Effect.gen(function* parsesNestedScope() {
    const root = yield* temporaryRoot;
    const unit = unitUnder(root);
    const packaged = path.join(unit, PACKAGED_DIRECTORY);
    const legacy =
      "if (typeof module === 'object') {\n  module.exports = { origin: 'nested-commonjs' };\n  return;\n}\n";
    const directory = yield* Effect.promise(() =>
      writeWorkspacePackage(packagedNodeModules(unit), manifestOf(NESTED_SCOPE_CONTRACTS, { '.': ENTRY_SUBPATH }), {
        [ENTRY_SOURCE]: "import legacy from './legacy/index.js'; export const origin = legacy.origin;\n",
        'src/legacy/index.js': legacy,
        'src/legacy/package.json': '{ "type": "commonjs" }\n',
      }),
    );
    yield* Effect.promise(() => writeProbe(packaged, originProbe(NESTED_SCOPE_CONTRACTS)));

    const compilation = yield* compilePackagedWorkspacePackages(unit);

    expect(compilation.packages[0]?.compiled).toEqual([ENTRY_OUTPUT]);
    expect(yield* Effect.promise(() => readFile(path.join(directory, 'src/legacy/index.js'), ENCODING))).toBe(legacy);
    yield* Effect.promise(() => removeTypeScriptSources(directory));
    const after = runProbe(packaged);
    expect(after.stderr).toBe('');
    expect(after.status).toBe(0);
    expect(Result.getOrThrow(Schema.decodeUnknownResult(OriginObservation)(after.stdout)).origin).toBe(
      'nested-commonjs',
    );
    const snapshot = yield* Effect.promise(() => snapshotTree(directory));
    yield* compilePackagedWorkspacePackages(unit);
    expect(yield* Effect.promise(() => snapshotTree(directory))).toEqual(snapshot);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('completes and runs pattern private imports from an ES module and a CommonJS importer', () =>
  Effect.gen(function* completesPatternImports() {
    const root = yield* temporaryRoot;
    const unit = unitUnder(root);
    const packaged = path.join(unit, PACKAGED_DIRECTORY);
    const manifest = {
      ...manifestOf(PATTERN_CONTRACTS, { '.': ENTRY_SUBPATH }),
      imports: { '#lib/*': './src/lib/*.ts', '#lib/special/*': './src/special/*.ts' },
    };
    const entry =
      "import { a } from '#lib/a'; import { special } from '#lib/special/s'; import bootstrap from './bootstrap.cjs'; export const origin = [a, special, bootstrap.b].join('-');\n";
    const bootstrap = "module.exports = { b: require('#lib/b').b };\n";
    const installed = yield* Effect.promise(() =>
      writeWorkspacePackage(path.join(unit, 'node_modules'), manifest, {
        [BOOTSTRAP_SOURCE]: bootstrap,
        [ENTRY_SOURCE]: entry,
        'src/lib/a.ts': "export const a = 'a';\n",
        'src/lib/b.ts': "export const b = 'b';\n",
        // A `#lib/special/*` import must select the longer prefix, never this file under `#lib/*`.
        'src/lib/special/s.ts': "export const special = 'wrong';\n",
        'src/special/s.ts': "export const special = 'special';\n",
      }),
    );
    const before = yield* Effect.promise(() => snapshotTree(installed));
    const traced = yield* Effect.promise(() =>
      writeWorkspacePackage(packagedNodeModules(unit), manifest, {
        [BOOTSTRAP_SOURCE]: bootstrap,
        [ENTRY_SOURCE]: entry,
      }),
    );
    yield* Effect.promise(() => writeProbe(packaged, originProbe(PATTERN_CONTRACTS)));

    yield* compilePackagedWorkspacePackages(unit);

    const { imports } = Result.getOrThrow(
      Schema.decodeUnknownResult(
        Schema.fromJsonString(Schema.Struct({ imports: Schema.Record(Schema.String, Schema.String) })),
      )(yield* Effect.promise(() => readFile(path.join(traced, PACKAGE_MANIFEST), ENCODING))),
    );
    expect(imports).toEqual({ '#lib/*': './src/lib/*.js', '#lib/special/*': './src/special/*.js' });
    // The build input is only read: nothing it carries is written or removed.
    expect(yield* Effect.promise(() => snapshotTree(installed))).toEqual(before);
    yield* Effect.promise(() => rename(installed, `${installed}-retired-build-input`));
    yield* Effect.promise(() => removeTypeScriptSources(traced));
    const after = runProbe(packaged);
    expect(after.stderr).toBe('');
    expect(after.status).toBe(0);
    expect(Result.getOrThrow(Schema.decodeUnknownResult(OriginObservation)(after.stdout)).origin).toBe('a-special-b');
    const snapshot = yield* Effect.promise(() => snapshotTree(traced));
    yield* compilePackagedWorkspacePackages(unit);
    expect(yield* Effect.promise(() => snapshotTree(traced))).toEqual(snapshot);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('refuses a private import map that differs from the declared build input', () =>
  Effect.gen(function* refusesDifferentPrivateImportMap() {
    const root = yield* temporaryRoot;
    const unit = unitUnder(root);
    const entry = "export { origin } from '#transport';\n";
    const manifest = {
      ...manifestOf(TRACED_CONTRACTS, { '.': ENTRY_SUBPATH }),
      imports: { '#transport': './src/transport.ts' },
    };
    yield* Effect.promise(() =>
      writeWorkspacePackage(path.join(unit, 'node_modules'), manifest, {
        [ENTRY_SOURCE]: entry,
        'src/other.ts': "export const origin = 'other';\n",
        'src/transport.ts': "export const origin = 'declared';\n",
      }),
    );
    const traced = yield* Effect.promise(() =>
      writeWorkspacePackage(
        packagedNodeModules(unit),
        {
          ...manifest,
          imports: { '#transport': './src/other.ts' },
        },
        { [ENTRY_SOURCE]: entry },
      ),
    );
    const exit = yield* Effect.exit(compilePackagedWorkspacePackages(unit));
    expect(refusalOf(exit)).toBe(`${TRACED_CONTRACTS}: the traced and build-input package identities differ`);
    expect(existsSync(path.join(traced, 'src/other.ts'))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('completes the real Better Auth adapter trace that CI omitted transaction hooks from', () =>
  Effect.gen(function* completesActualAdapterTrace() {
    const root = yield* temporaryRoot;
    const unit = unitUnder(root);
    const name = '@app/better-auth-effect-drizzle';
    const source = path.resolve('packages/better-auth-effect-drizzle');
    const manifest = yield* Effect.promise(() => readFile(path.join(source, PACKAGE_MANIFEST), ENCODING));
    const server = yield* Effect.promise(() => readFile(path.join(source, 'src', 'server.ts'), ENCODING));
    const traced = path.join(packagedNodeModules(unit), name);
    const installed = path.join(unit, 'node_modules', name);
    yield* Effect.promise(async () => {
      await mkdir(path.join(traced, 'src'), { recursive: true });
      await writeFile(path.join(traced, PACKAGE_MANIFEST), manifest);
      await writeFile(path.join(traced, 'src', 'server.ts'), server);
      await mkdir(path.dirname(installed), { recursive: true });
      await symlink(source, installed, 'dir');
    });

    const compilation = yield* compilePackagedWorkspacePackages(unit);

    expect(compilation.packages[0]?.compiled).toContain('src/transaction-hooks.js');
    expect(yield* Effect.promise(() => readFile(path.join(traced, 'src', 'server.js'), ENCODING))).toContain(
      './transaction-hooks.js',
    );
    expect(yield* Effect.promise(() => readFile(path.join(traced, 'src', 'transaction-hooks.ts'), ENCODING))).toBe(
      yield* Effect.promise(() => readFile(path.join(source, 'src', 'transaction-hooks.ts'), ENCODING)),
    );
    expect(existsSync(path.join(source, 'src', 'transaction-hooks.js'))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('refuses to complete a trace from a different build input with the same package name', () =>
  Effect.gen(function* refusesMismatchedBuildInputs() {
    const root = yield* temporaryRoot;
    const unit = unitUnder(root);
    yield* Effect.promise(() =>
      writeWorkspacePackage(path.join(unit, 'node_modules'), manifestOf(TRACED_CONTRACTS, { '.': ENTRY_SUBPATH }), {
        [ENTRY_SOURCE]: "export { origin } from './helper.ts';\n",
        'src/helper.ts': "export const origin = 'different-source';\n",
      }),
    );
    const traced = yield* Effect.promise(() =>
      writeWorkspacePackage(packagedNodeModules(unit), manifestOf(TRACED_CONTRACTS, { '.': ENTRY_SUBPATH }), {
        [ENTRY_SOURCE]: "export { origin } from './helper.ts';\nexport const traced = true;\n",
      }),
    );
    const exit = yield* Effect.exit(compilePackagedWorkspacePackages(unit));
    expect(refusalOf(exit)).toBe(`${TRACED_CONTRACTS}: a traced source differs from its declared build input`);
    expect(existsSync(path.join(traced, 'src', 'helper.ts'))).toBe(false);
    expect(existsSync(path.join(traced, ENTRY_OUTPUT))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('refuses to overwrite a different module already at a compiled path', () =>
  Effect.gen(function* refusesCollidingOutput() {
    const root = yield* temporaryRoot;
    const unit = unitUnder(root);
    const handWritten = 'module.exports = { handWritten: true };\n';
    const directory = yield* Effect.promise(() =>
      writeWorkspacePackage(packagedNodeModules(unit), manifestOf(COLLIDING_CONTRACTS, { '.': ENTRY_SUBPATH }), {
        [ENTRY_OUTPUT]: handWritten,
        [ENTRY_SOURCE]: 'export const value = 1;\n',
      }),
    );

    const exit = yield* Effect.exit(compilePackagedWorkspacePackages(unit));

    expect(refusalOf(exit)).toContain(
      `${path.join(directory, ENTRY_OUTPUT)}: the packaged tree already carries a different module at this path`,
    );
    expect(yield* Effect.promise(() => readFile(path.join(directory, ENTRY_OUTPUT), ENCODING))).toBe(handWritten);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('refuses a traced relative import whose source the packaged tree does not carry', () =>
  Effect.gen(function* refusesUntracedImport() {
    const root = yield* temporaryRoot;
    const unit = unitUnder(root);
    const directory = yield* Effect.promise(() =>
      writeWorkspacePackage(packagedNodeModules(unit), manifestOf(DANGLING_CONTRACTS, { '.': ENTRY_SUBPATH }), {
        [ENTRY_SOURCE]: "export { missing } from './missing.ts';\n",
      }),
    );

    const exit = yield* Effect.exit(compilePackagedWorkspacePackages(unit));

    expect(refusalOf(exit)).toBe(`${DANGLING_CONTRACTS}: the declared build dependency could not be resolved`);
    // The module is rejected before anything is written for it.
    expect(existsSync(path.join(directory, ENTRY_OUTPUT))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('is idempotent and leaves a packaged unit that has no workspace packages alone', () =>
  Effect.gen(function* compilesIdempotently() {
    const root = yield* temporaryRoot;
    const unit = unitUnder(root);

    expect(yield* compilePackagedWorkspacePackages(unit)).toEqual({ packages: [] });

    const directory = yield* Effect.promise(() =>
      writeWorkspacePackage(
        packagedNodeModules(unit),
        manifestOf(STABLE_CONTRACTS, { '.': ENTRY_SUBPATH, './helper': './src/helper.ts' }),
        {
          [ENTRY_SOURCE]: "export { helper } from './helper.ts';\n",
          'src/helper.ts': 'export const helper = 1;\n',
        },
      ),
    );

    const first = yield* compilePackagedWorkspacePackages(unit);
    expect(first.packages[0]?.repointed).toEqual([ROOT_EXPORT, './helper']);
    const afterFirst = yield* Effect.promise(() => snapshotTree(directory));

    const second = yield* compilePackagedWorkspacePackages(unit);
    expect(second.packages[0]?.repointed).toEqual([]);
    expect(second.packages[0]?.compiled).toEqual(first.packages[0]?.compiled);
    expect(yield* Effect.promise(() => snapshotTree(directory))).toEqual(afterFirst);
    expect(existsSync(path.join(directory, ENTRY_SOURCE))).toBe(true);
    expect(existsSync(path.join(directory, 'src', 'helper.ts'))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
