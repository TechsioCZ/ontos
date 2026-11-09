import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { completePackagedNodeDependencies } from '../complete-packaged-node-dependencies.mts';
import { PACKAGED_DIRECTORY } from '../materialize-packaged-workspace-packages.mts';

const ENCODING = 'utf-8';
const ENTRY = 'entry.mjs';
const DEPENDENCY = 'dep-lib';
const WORKSPACE = 'workspace';
const UNIT = path.join(WORKSPACE, 'apps', 'shell');
const PACKAGED_NODE_MODULES = path.join(UNIT, PACKAGED_DIRECTORY, 'node_modules');

/** The `import` and `require` targets of one dual-format package; the trace may carry only one of them. */
const DEPENDENCY_ESM = "export const value = 'dep-lib-esm';\nexport const instance = {};\n";
const DEPENDENCY_CJS = "module.exports = { value: 'dep-lib-cjs' };\n";

const APP_SOURCE = {
  core: "import { instance, value } from 'dep-lib';\nexport const core = value;\nexport const coreInstance = instance;\n",
  other: "import { instance } from 'dep-lib';\nexport const otherInstance = instance;\n",
} as const;
type AppName = keyof typeof APP_SOURCE;

const ENTRY_SOURCE = [
  "import { createRequire } from 'node:module';",
  "import { core } from '@app/core';",
  'const load = createRequire(import.meta.url);',
  "process.stdout.write(JSON.stringify({ core, legacy: load('dep-lib').value }));",
  '',
].join('\n');

const SHARED_ENTRY_SOURCE = [
  "import { coreInstance } from '@app/core';",
  "import { otherInstance } from '@app/other';",
  'process.stdout.write(JSON.stringify({ shared: coreInstance === otherInstance }));',
  '',
].join('\n');

const ENTRY_OBSERVATION = Schema.fromJsonString(Schema.Struct({ core: Schema.String, legacy: Schema.String }));
const SHARED_OBSERVATION = Schema.fromJsonString(Schema.Struct({ shared: Schema.Boolean }));
const CORE_OBSERVATION = Schema.fromJsonString(Schema.Struct({ core: Schema.String }));

/** A package manifest as the text a `package.json` holds. */
const json = (value: Schema.Json) => `${JSON.stringify(value, null, 2)}\n`;

const dependencyManifest = (version: string) =>
  json({
    exports: { '.': { import: { default: './index.js' }, require: { default: './index.cjs' } } },
    name: DEPENDENCY,
    type: 'module',
    version,
  });

type File = readonly [relative: string, text: string];

const writeFiles = (root: string, files: readonly File[]) =>
  Promise.all(
    files.map(async ([relative, text]) => {
      const file = path.join(root, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
    }),
  );

interface FixtureOptions {
  readonly apps: readonly AppName[];
  readonly entry?: string;
  readonly tracedDependencyCjs?: string;
  readonly tracedDependencyVersion?: string;
}

/**
 * A declared workspace install of each `@app` package and of `dep-lib` (ESM and CJS variants), and a unit whose
 * packaged output carries the same `@app` packages but only the CJS variant of `dep-lib`, as an NFT trace does.
 */
const writeFixture = async (root: string, options: FixtureOptions) => {
  const unit = path.join(root, UNIT);
  const output = path.join(unit, PACKAGED_DIRECTORY);
  const dependencies = Object.fromEntries(options.apps.map((app) => [`@app/${app}`, 'workspace:*']));
  const files: File[] = [
    [
      `${WORKSPACE}/apps/shell/package.json`,
      json({ dependencies, name: '@app/shell', type: 'module', version: '0.0.0' }),
    ],
    [`${WORKSPACE}/node_modules/${DEPENDENCY}/package.json`, dependencyManifest('1.0.0')],
    [`${WORKSPACE}/node_modules/${DEPENDENCY}/index.js`, DEPENDENCY_ESM],
    [`${WORKSPACE}/node_modules/${DEPENDENCY}/index.cjs`, DEPENDENCY_CJS],
    [path.join(UNIT, PACKAGED_DIRECTORY, ENTRY), options.entry ?? ENTRY_SOURCE],
    [
      path.join(PACKAGED_NODE_MODULES, DEPENDENCY, 'package.json'),
      dependencyManifest(options.tracedDependencyVersion ?? '1.0.0'),
    ],
    [path.join(PACKAGED_NODE_MODULES, DEPENDENCY, 'index.cjs'), options.tracedDependencyCjs ?? DEPENDENCY_CJS],
  ];
  for (const app of options.apps) {
    const manifest = json({
      dependencies: { [DEPENDENCY]: '1.0.0' },
      exports: { '.': './index.js' },
      name: `@app/${app}`,
      type: 'module',
      version: '0.1.0',
    });
    files.push(
      [`${WORKSPACE}/node_modules/@app/${app}/package.json`, manifest],
      [`${WORKSPACE}/node_modules/@app/${app}/index.js`, APP_SOURCE[app]],
      [path.join(PACKAGED_NODE_MODULES, '@app', app, 'package.json'), manifest],
      [path.join(PACKAGED_NODE_MODULES, '@app', app, 'index.js'), APP_SOURCE[app]],
    );
  }
  await writeFiles(root, files);
  return {
    output,
    sourceInstall: path.join(root, WORKSPACE, 'node_modules'),
    unit,
  };
};

/** Runs the packaged entry with the native Node binary, from inside the packaged output. */
const runEntry = (output: string) => {
  const result = spawnSync(process.execPath, [ENTRY], { cwd: output, encoding: ENCODING });
  return { signal: result.signal, status: result.status, stderr: result.stderr ?? '', stdout: result.stdout ?? '' };
};

const temporaryRoot = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(path.join(tmpdir(), 'ontos-node-dependencies-'))),
  (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
);

it.effect(
  'completes the ESM variant a CJS-only trace leaves out, and Node loads the packaged graph after the declared install is gone',
  () =>
    Effect.gen(function* completesPartialTrace() {
      const root = yield* temporaryRoot;
      const fixture = yield* Effect.promise(() => writeFixture(root, { apps: ['core'] }));
      const completion = yield* completePackagedNodeDependencies(fixture.unit);
      expect(completion.copied).toEqual([path.join(PACKAGED_DIRECTORY, 'node_modules', DEPENDENCY, 'index.js')]);
      const copied = yield* Effect.promise(() =>
        readFile(path.join(fixture.output, 'node_modules', DEPENDENCY, 'index.js'), ENCODING),
      );
      expect(copied).toBe(DEPENDENCY_ESM);
      // Only the declared install goes away; the packaged output the step wrote must load on its own.
      yield* Effect.promise(() => rm(fixture.sourceInstall, { force: true, recursive: true }));
      expect(existsSync(fixture.sourceInstall)).toBe(false);

      const probe = runEntry(fixture.output);
      expect(probe.signal).toBeNull();
      expect(probe.stderr).toBe('');
      expect(probe.status).toBe(0);
      const observed = Result.getOrThrow(Schema.decodeUnknownResult(ENTRY_OBSERVATION)(probe.stdout));
      expect(observed).toEqual({ core: 'dep-lib-esm', legacy: 'dep-lib-cjs' });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('keeps a dependency shared by two packages as one instance and one copied file', () =>
  Effect.gen(function* sharesOneInstance() {
    const root = yield* temporaryRoot;
    const fixture = yield* Effect.promise(() =>
      writeFixture(root, { apps: ['core', 'other'], entry: SHARED_ENTRY_SOURCE }),
    );
    const completion = yield* completePackagedNodeDependencies(fixture.unit);
    expect(completion.copied).toEqual([path.join(PACKAGED_DIRECTORY, 'node_modules', DEPENDENCY, 'index.js')]);
    yield* Effect.promise(() => rm(fixture.sourceInstall, { force: true, recursive: true }));

    const probe = runEntry(fixture.output);
    expect(probe.status).toBe(0);
    expect(Result.getOrThrow(Schema.decodeUnknownResult(SHARED_OBSERVATION)(probe.stdout))).toEqual({ shared: true });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('refuses a traced dependency whose version differs from its declared install', () =>
  Effect.gen(function* refusesVersionConflict() {
    const root = yield* temporaryRoot;
    const fixture = yield* Effect.promise(() =>
      writeFixture(root, { apps: ['core'], tracedDependencyVersion: '2.0.0' }),
    );
    const error = yield* Effect.flip(completePackagedNodeDependencies(fixture.unit));
    expect(error.message).toContain('the traced version 2.0.0 differs from the declared install 1.0.0');
    expect(existsSync(path.join(fixture.output, 'node_modules', DEPENDENCY, 'index.js'))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('refuses a traced file whose bytes differ from the declared install', () =>
  Effect.gen(function* refusesCarriedConflict() {
    const root = yield* temporaryRoot;
    const fixture = yield* Effect.promise(() =>
      writeFixture(root, { apps: ['core'], tracedDependencyCjs: "module.exports = { value: 'tampered' };\n" }),
    );
    const error = yield* Effect.flip(completePackagedNodeDependencies(fixture.unit));
    expect(error.message).toContain("differs from the declared install's index.cjs");
    expect(existsSync(path.join(fixture.output, 'node_modules', DEPENDENCY, 'index.js'))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('refuses an import that resolves to an ancestor install instead of the packaged tree', () =>
  Effect.gen(function* refusesAncestorFallback() {
    const root = yield* temporaryRoot;
    const fixture = yield* Effect.promise(() => writeFixture(root, { apps: ['core'] }));
    // `ghost-lib` is installed only above the unit, in the workspace; the packaged tree does not trace it.
    yield* Effect.promise(() =>
      writeFiles(root, [
        [`${WORKSPACE}/node_modules/ghost-lib/index.js`, 'export const ghost = true;\n'],
        [
          `${WORKSPACE}/node_modules/ghost-lib/package.json`,
          json({ name: 'ghost-lib', type: 'module', version: '1.0.0' }),
        ],
        [
          path.join(PACKAGED_NODE_MODULES, '@app', 'core', 'index.js'),
          "import 'ghost-lib';\nexport const core = 'core';\n",
        ],
      ]),
    );
    const error = yield* Effect.flip(completePackagedNodeDependencies(fixture.unit));
    expect(error.message).toContain('outside the packaged output');
    expect(existsSync(path.join(fixture.output, 'node_modules', 'ghost-lib'))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('completes a workspace package the unit never imports, when a consumer loads its export by import', () =>
  Effect.gen(function* completesExportRoot() {
    const root = yield* temporaryRoot;
    const fixture = yield* Effect.promise(() =>
      writeFixture(root, { apps: ['core'], entry: "process.stdout.write(JSON.stringify({ core: 'unused' }));\n" }),
    );
    const completion = yield* completePackagedNodeDependencies(fixture.unit);
    expect(completion.copied).toEqual([path.join(PACKAGED_DIRECTORY, 'node_modules', DEPENDENCY, 'index.js')]);
    yield* Effect.promise(() => rm(fixture.sourceInstall, { force: true, recursive: true }));

    const probe = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "const { core } = await import('@app/core'); process.stdout.write(JSON.stringify({ core }));",
      ],
      { cwd: fixture.output, encoding: ENCODING },
    );
    expect(probe.status).toBe(0);
    expect(Result.getOrThrow(Schema.decodeUnknownResult(CORE_OBSERVATION)(probe.stdout ?? ''))).toEqual({
      core: 'dep-lib-esm',
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
