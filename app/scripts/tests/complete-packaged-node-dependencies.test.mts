import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { completePackagedNodeDependencies } from '../complete-packaged-node-dependencies.mts';
import { PACKAGED_DIRECTORY } from '../materialize-packaged-workspace-packages.mts';
import {
  openPackagedDependencyResolver,
  memoizeDependencyRead,
  PackagedNodeDependencyError,
} from '../packaged-node-dependency-resolver.mts';

const ENCODING = 'utf-8';
const MANIFEST_FILE = 'package.json';
const ESM_TARGET = './index.js';
const ESM_VALUE = 'dep-lib-esm';
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
  "process.stdout.write(core + ':' + load('dep-lib').value);",
  '',
].join('\n');

const SHARED_ENTRY_SOURCE = [
  "import { coreInstance } from '@app/core';",
  "import { otherInstance } from '@app/other';",
  'process.stdout.write(String(coreInstance === otherInstance));',
  '',
].join('\n');

const CORE_PROBE = "const { core } = await import('@app/core'); process.stdout.write(core);";

/** A package manifest as the text a `package.json` holds. */
const json = (value: Schema.Json) => `${Schema.encodeSync(Schema.fromJsonString(Schema.Json))(value)}\n`;

const dependencyManifest = (version: string) =>
  json({
    exports: { '.': { import: { default: ESM_TARGET }, require: { default: './index.cjs' } } },
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
      path.join(PACKAGED_NODE_MODULES, DEPENDENCY, MANIFEST_FILE),
      dependencyManifest(options.tracedDependencyVersion ?? '1.0.0'),
    ],
    [path.join(PACKAGED_NODE_MODULES, DEPENDENCY, 'index.cjs'), options.tracedDependencyCjs ?? DEPENDENCY_CJS],
  ];
  for (const app of options.apps) {
    const manifest = json({
      dependencies: { [DEPENDENCY]: '1.0.0' },
      exports: { '.': ESM_TARGET },
      name: `@app/${app}`,
      type: 'module',
      version: '0.1.0',
    });
    files.push(
      [`${WORKSPACE}/node_modules/@app/${app}/package.json`, manifest],
      [`${WORKSPACE}/node_modules/@app/${app}/index.js`, APP_SOURCE[app]],
      [path.join(PACKAGED_NODE_MODULES, '@app', app, MANIFEST_FILE), manifest],
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
      expect(probe.stdout).toBe(`${ESM_VALUE}:dep-lib-cjs`);
      return yield* Effect.void;
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
    expect(probe.stdout).toBe('true');
    return yield* Effect.void;
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
    return yield* Effect.void;
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
    return yield* Effect.void;
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
    return yield* Effect.void;
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('completes a workspace package the unit never imports, when a consumer loads its export by import', () =>
  Effect.gen(function* completesExportRoot() {
    const root = yield* temporaryRoot;
    const fixture = yield* Effect.promise(() =>
      writeFixture(root, { apps: ['core'], entry: "process.stdout.write('unused');\n" }),
    );
    const completion = yield* completePackagedNodeDependencies(fixture.unit);
    expect(completion.copied).toEqual([path.join(PACKAGED_DIRECTORY, 'node_modules', DEPENDENCY, 'index.js')]);
    yield* Effect.promise(() => rm(fixture.sourceInstall, { force: true, recursive: true }));

    const probe = spawnSync(process.execPath, ['--input-type=module', '--eval', CORE_PROBE], {
      cwd: fixture.output,
      encoding: ENCODING,
    });
    expect(probe.status).toBe(0);
    expect(probe.stdout).toBe(ESM_VALUE);
    return yield* Effect.void;
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('resolves a dependency the owner declares under an alias to its real install', () =>
  Effect.gen(function* resolvesAlias() {
    const root = yield* temporaryRoot;
    const alias = 'dep-alias';
    const exportsMap = { '.': { import: { default: ESM_TARGET }, require: { default: './index.cjs' } } };
    const core = json({
      dependencies: { [alias]: `npm:${DEPENDENCY}@1.0.0` },
      exports: { '.': ESM_TARGET },
      name: '@app/core',
      type: 'module',
      version: '0.1.0',
    });
    const coreSource = "import { value } from 'dep-alias';\nexport const core = value;\n";
    yield* Effect.promise(() =>
      writeFiles(root, [
        [
          `${WORKSPACE}/apps/shell/package.json`,
          json({ dependencies: { '@app/core': 'workspace:*' }, name: '@app/shell', type: 'module', version: '0.0.0' }),
        ],
        [
          `${WORKSPACE}/node_modules/${alias}/package.json`,
          json({ exports: exportsMap, name: DEPENDENCY, type: 'module', version: '1.0.0' }),
        ],
        [`${WORKSPACE}/node_modules/${alias}/index.js`, DEPENDENCY_ESM],
        [`${WORKSPACE}/node_modules/${alias}/index.cjs`, DEPENDENCY_CJS],
        [`${WORKSPACE}/node_modules/@app/core/package.json`, core],
        [`${WORKSPACE}/node_modules/@app/core/index.js`, coreSource],
        [path.join(PACKAGED_NODE_MODULES, '@app', 'core', MANIFEST_FILE), core],
        [path.join(PACKAGED_NODE_MODULES, '@app', 'core', 'index.js'), coreSource],
        [
          path.join(PACKAGED_NODE_MODULES, alias, MANIFEST_FILE),
          json({ exports: exportsMap, name: DEPENDENCY, type: 'module', version: '1.0.0' }),
        ],
        [path.join(PACKAGED_NODE_MODULES, alias, 'index.cjs'), DEPENDENCY_CJS],
      ]),
    );
    const unit = path.join(root, UNIT);
    const completion = yield* completePackagedNodeDependencies(unit);
    expect(completion.copied).toEqual([path.join(PACKAGED_DIRECTORY, 'node_modules', alias, 'index.js')]);
    yield* Effect.promise(() => rm(path.join(root, WORKSPACE, 'node_modules'), { force: true, recursive: true }));

    const probe = spawnSync(process.execPath, ['--input-type=module', '--eval', CORE_PROBE], {
      cwd: path.join(unit, PACKAGED_DIRECTORY),
      encoding: ENCODING,
    });
    expect(probe.status).toBe(0);
    expect(probe.stdout).toBe(ESM_VALUE);
    return yield* Effect.void;
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('memoizes successful reads by exact key and does not cache failures', () =>
  Effect.gen(function* memoizedReads() {
    const calls: string[] = [];
    const read = memoizeDependencyRead((key) =>
      Effect.sync(() => calls.push(key)).pipe(
        Effect.flatMap(() =>
          key === 'missing'
            ? Effect.fail(new PackagedNodeDependencyError({ message: 'missing' }))
            : Effect.succeed({ key }),
        ),
      ),
    );
    const first = yield* read('first');
    expect(yield* read('first')).toBe(first);
    expect(yield* read('second')).toEqual({ key: 'second' });
    yield* Effect.flip(read('missing'));
    yield* Effect.flip(read('missing'));
    expect(calls).toEqual(['first', 'second', 'missing', 'missing']);
    return yield* Effect.void;
  }),
);

it.effect('batches a synthetic graph exactly like fresh single-request hosts and caches repeated wave edges', () =>
  Effect.gen(function* batchesResolution() {
    const root = yield* temporaryRoot;
    const fixture = yield* Effect.promise(() => writeFixture(root, { apps: ['core', 'other'] }));
    const parent = pathToFileURL(path.join(fixture.output, ENTRY)).href;
    const requests = [
      { parent, specifier: '@app/core' },
      { parent, specifier: '@app/other' },
      {
        parent: pathToFileURL(path.join(fixture.output, 'node_modules', '@app', 'core', 'index.js')).href,
        specifier: DEPENDENCY,
      },
      { parent, specifier: './missing.mjs' },
      { parent, specifier: 'not-installed' },
    ];
    const resolver = yield* openPackagedDependencyResolver(fixture.output);
    const batched = yield* resolver.resolve(requests);
    const singles = yield* Effect.forEach(
      requests,
      (request) =>
        Effect.gen(function* singleRequest() {
          const single = yield* openPackagedDependencyResolver(fixture.output);
          const [answer] = yield* single.resolve([request]);
          yield* single.close;
          return yield* Effect.succeed(answer);
        }).pipe(Effect.scoped),
      { concurrency: 1 },
    );
    expect(batched).toEqual(singles);
    expect(batched[3]?.url).toBe(new URL('missing.mjs', parent).href);
    expect(batched[4]?.code).toBe('ERR_MODULE_NOT_FOUND');
    expect(yield* resolver.resolve(requests)).toEqual(batched);
    expect(resolver.stats).toEqual({ batches: 1, cacheHits: requests.length, requests: requests.length });
    yield* resolver.close;
    return yield* Effect.void;
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  'scans a converging wave once, verifies shared carried bytes once, and keeps copied bytes and manifests',
  () =>
    Effect.gen(function* convergingGraph() {
      const root = yield* temporaryRoot;
      const fixture = yield* Effect.promise(() =>
        writeFixture(root, { apps: ['core', 'other'], entry: SHARED_ENTRY_SOURCE }),
      );
      const manifestPath = path.join(fixture.output, 'node_modules', DEPENDENCY, MANIFEST_FILE);
      const before = yield* Effect.promise(() => readFile(manifestPath, ENCODING));
      const completion = yield* completePackagedNodeDependencies(fixture.unit);
      expect(completion.metrics.scannedFiles).toBe(4);
      expect(completion.metrics.verifiedFiles).toBe(1);
      expect(completion.metrics.sourceResolutions).toBe(4);
      expect(completion.metrics.manifestReads).toBe(7);
      expect(completion.copied).toEqual([path.join(PACKAGED_DIRECTORY, 'node_modules', DEPENDENCY, 'index.js')]);
      expect(yield* Effect.promise(() => readFile(manifestPath, ENCODING))).toBe(before);
      expect(yield* Effect.promise(() => readFile(path.join(path.dirname(manifestPath), 'index.js'), ENCODING))).toBe(
        DEPENDENCY_ESM,
      );
      return yield* Effect.void;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('checks a second declaring owner even after its target and carried package have been verified', () =>
  Effect.gen(function* conflictingDeclaringOwner() {
    const root = yield* temporaryRoot;
    const fixture = yield* Effect.promise(() =>
      writeFixture(root, { apps: ['core', 'other'], entry: SHARED_ENTRY_SOURCE }),
    );
    yield* Effect.promise(() =>
      writeFiles(fixture.sourceInstall, [
        [`@app/other/node_modules/${DEPENDENCY}/package.json`, dependencyManifest('1.0.0')],
        [`@app/other/node_modules/${DEPENDENCY}/index.js`, DEPENDENCY_ESM],
        [`@app/other/node_modules/${DEPENDENCY}/index.cjs`, DEPENDENCY_CJS],
      ]),
    );
    const error = yield* Effect.flip(completePackagedNodeDependencies(fixture.unit));
    expect(error.message).toContain('two declaring packages resolve different installs');
    return yield* Effect.void;
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('checks every carried file beyond the first concurrency window for byte mismatches', () =>
  Effect.gen(function* concurrentMismatch() {
    const root = yield* temporaryRoot;
    const fixture = yield* Effect.promise(() => writeFixture(root, { apps: ['core'] }));
    const files: File[] = Array.from({ length: 24 }, (_, index) => [`carried-${index}.cjs`, DEPENDENCY_CJS]);
    yield* Effect.promise(() => writeFiles(path.join(fixture.sourceInstall, DEPENDENCY), files));
    yield* Effect.promise(() => writeFiles(path.join(fixture.output, 'node_modules', DEPENDENCY), files));
    yield* Effect.promise(() =>
      writeFile(path.join(fixture.output, 'node_modules', DEPENDENCY, 'carried-23.cjs'), 'different bytes\n'),
    );
    const error = yield* Effect.flip(completePackagedNodeDependencies(fixture.unit));
    expect(error.message).toContain("differs from the declared install's carried-23.cjs");
    return yield* Effect.void;
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('still rejects a carried file absent from the declared install during concurrent verification', () =>
  Effect.gen(function* absentCarriedFile() {
    const root = yield* temporaryRoot;
    const fixture = yield* Effect.promise(() => writeFixture(root, { apps: ['core'] }));
    yield* Effect.promise(() => writeFiles(fixture.output, [['node_modules/dep-lib/absent.js', 'export {};\n']]));
    const error = yield* Effect.flip(completePackagedNodeDependencies(fixture.unit));
    expect(error.message).toContain('the traced package carries a file its declared install does not contain');
    return yield* Effect.void;
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('still rejects a missing ESM target that the declared install cannot supply', () =>
  Effect.gen(function* absentMissingTarget() {
    const root = yield* temporaryRoot;
    const fixture = yield* Effect.promise(() => writeFixture(root, { apps: ['core'] }));
    yield* Effect.promise(() => rm(path.join(fixture.sourceInstall, DEPENDENCY, 'index.js')));
    const error = yield* Effect.flip(completePackagedNodeDependencies(fixture.unit));
    expect(error.message).toContain('its declared install has no such file');
    return yield* Effect.void;
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
