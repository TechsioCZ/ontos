import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ASIDE,
  entryImportFindings,
  EXCLUSION_LIST,
  excludedStoreDirectories,
  importerLinkViolations,
  packageOf,
  parseExclusions,
  storeDirectoryPattern,
  storeLinkViolations,
  withLeftOutAside,
  workspaceImportViolations,
} from './prove-app-runtime.mts';

const PLATFORM_BUILDS = '@effect/tsgo-*';
const LEFT_OUT = ['oxlint', 'oxfmt', PLATFORM_BUILDS];
const STORE = 'node_modules/.pnpm';
const OXLINT_STORE = 'oxlint@1.0.0_oxlint-tsgolint@7.0.0';
const HOST = 'scripts/zerops/app-host.mts';
const MIGRATOR = 'scripts/run-zerops-migrator.mjs';

it('reads one package name per line and maps each to its pnpm store directories', () => {
  expect(parseExclusions('# tools\n\noxlint\n  @effect/tsgo-*  \n')).toEqual(['oxlint', PLATFORM_BUILDS]);
  const platform = storeDirectoryPattern(PLATFORM_BUILDS);
  expect(platform.test('@effect+tsgo-linux-x64@0.69.0')).toBe(true);
  expect(platform.test('@effect+tsgo@0.69.0')).toBe(false);
  expect(platform.test('@effectXtsgo-linux@1')).toBe(false);
  const tool = storeDirectoryPattern('oxlint');
  expect(tool.test(OXLINT_STORE)).toBe(true);
  expect(tool.test('oxlint-tsgolint@7.0.0')).toBe(false);
  expect(packageOf('@scope/name/sub')).toEqual(Option.some('@scope/name'));
  expect(packageOf('oxlint/plugins')).toEqual(Option.some('oxlint'));
  expect(packageOf('./local.mts')).toEqual(Option.none());
  expect(packageOf('node:path')).toEqual(Option.none());
});

/**
 * An installed workspace: the root links oxlint as a devDependency (allowed), `@app/a` links it as a dependency (not),
 * the kept package `uses-oxlint` depends on it (not), `plain` depends on nothing left out. The host reaches a helper
 * that imports oxlint and names the migrator by path; a type-only import of oxfmt does not count.
 */
const workspace = Effect.gen(function* makeWorkspace() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'prove-app-runtime-' });
  const write = (relative: string, text: string) =>
    Effect.gen(function* writeFile() {
      yield* fs.makeDirectory(path.dirname(path.join(root, relative)), { recursive: true });
      yield* fs.writeFileString(path.join(root, relative), text);
    });
  const link = (target: string, at: string) =>
    Effect.gen(function* makeLink() {
      yield* fs.makeDirectory(path.dirname(path.join(root, at)), { recursive: true });
      yield* fs.symlink(target, path.join(root, at));
    });
  const module = '{"type":"module","main":"index.js"}';
  yield* write(EXCLUSION_LIST, `${LEFT_OUT.join('\n')}\n`);
  yield* write(`${STORE}/${OXLINT_STORE}/node_modules/oxlint/package.json`, module);
  yield* write(`${STORE}/${OXLINT_STORE}/node_modules/oxlint/index.js`, 'export const lint = 1;\n');
  yield* write(`${STORE}/plain@1.0.0/node_modules/plain/package.json`, module);
  yield* write(`${STORE}/plain@1.0.0/node_modules/plain/index.js`, 'export const plain = 1;\n');
  yield* write(`${STORE}/uses-oxlint@1.0.0/node_modules/uses-oxlint/package.json`, module);
  yield* link(`../../${OXLINT_STORE}/node_modules/oxlint`, `${STORE}/uses-oxlint@1.0.0/node_modules/oxlint`);
  yield* write(`${STORE}/lock.yaml`, 'lockfileVersion: 9\n');
  yield* write('package.json', '{"name":"app","devDependencies":{"oxlint":"1.0.0"}}');
  yield* link(`.pnpm/${OXLINT_STORE}/node_modules/oxlint`, 'node_modules/oxlint');
  yield* link('.pnpm/plain@1.0.0/node_modules/plain', 'node_modules/plain');
  yield* write(
    'verticals/a/package.json',
    '{"name":"@app/a","exports":{".":"./src/index.ts"},"dependencies":{"oxlint":"1"}}',
  );
  yield* link(`../../../${STORE}/${OXLINT_STORE}/node_modules/oxlint`, 'verticals/a/node_modules/oxlint');
  yield* write('verticals/a/src/index.ts', "export { plain } from 'plain';\nimport type { Format } from 'oxfmt';\n");
  yield* write(
    HOST,
    `import { helper } from '../lib/helper.mts';\nimport '@app/a';\nconst migrator = '${MIGRATOR}';\n`,
  );
  yield* write('scripts/lib/helper.mts', "import { lint } from 'oxlint';\nexport const helper = lint;\n");
  yield* write(MIGRATOR, "import { plain } from 'plain';\n");
  yield* write('scripts/unreached.mts', "import 'oxfmt';\n");
  yield* write('verticals/a/dist/zerops-entry.mjs', "import { plain } from 'plain';\nexport const start = plain;\n");
  yield* write('verticals/b/dist/zerops-entry.mjs', "import { lint } from 'oxlint';\nexport const start = lint;\n");
  yield* write('verticals/c/dist/zerops-entry.mjs', "throw new Error('needs DATABASE_URL');\n");
  return root;
});

it.live('finds kept packages and workspace packages that need a left-out package, and nothing else', () =>
  Effect.gen(function* linkChecks() {
    const root = yield* workspace;
    const excluded = yield* excludedStoreDirectories(root, LEFT_OUT);
    expect([...excluded]).toEqual([OXLINT_STORE]);
    expect(yield* storeLinkViolations(root, excluded)).toEqual([
      `uses-oxlint@1.0.0 depends on oxlint (${OXLINT_STORE})`,
    ]);
    expect(yield* importerLinkViolations(root, excluded)).toEqual([
      `verticals/a links oxlint (${OXLINT_STORE}) and it is not a devDependency`,
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live('follows the host into helpers, started scripts and workspace packages, and finds value imports only', () =>
  Effect.gen(function* closureCheck() {
    const root = yield* workspace;
    const { reached, violations } = yield* workspaceImportViolations(root, [HOST], LEFT_OUT);
    expect(violations).toEqual(['scripts/lib/helper.mts:1 imports oxlint']);
    // The host, its helper, the migrator it names and @app/a's public entry; never scripts/unreached.mts.
    expect(reached).toBe(4);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live('counts an entry that needs a left-out package or is missing, reports others, and restores the store', () =>
  Effect.gen(function* entryCheck() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* workspace;
    const excluded = yield* excludedStoreDirectories(root, LEFT_OUT);
    const entries = ['a', 'b', 'c', 'd'].map((unit) => path.join(root, `verticals/${unit}/dist/zerops-entry.mjs`));
    const { failures, notes } = yield* withLeftOutAside(root, excluded, entryImportFindings(root, entries));
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain('verticals/b/dist/zerops-entry.mjs: ');
    expect(failures[0]).toContain("Cannot find package 'oxlint'");
    expect(failures[1]).toBe('verticals/d/dist/zerops-entry.mjs is missing');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('verticals/c/dist/zerops-entry.mjs (not counted): ');
    expect(notes[0]).toContain('needs DATABASE_URL');
    // The full install is back as it was, and nothing is left aside.
    expect(yield* fs.exists(path.join(root, STORE, OXLINT_STORE, 'node_modules/oxlint/index.js'))).toBe(true);
    expect(yield* fs.exists(path.join(root, ASIDE))).toBe(false);
    // With the store complete, the same entry imports.
    expect((yield* entryImportFindings(root, entries.slice(1, 2))).failures).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live('restores the left-out store directories when the proof inside fails', () =>
  Effect.gen(function* restoreOnFailure() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* workspace;
    const excluded = yield* excludedStoreDirectories(root, LEFT_OUT);
    const failed = yield* withLeftOutAside(root, excluded, Effect.fail('inner failure')).pipe(Effect.flip);
    expect(failed).toBe('inner failure');
    expect(yield* fs.exists(path.join(root, STORE, OXLINT_STORE))).toBe(true);
    expect(yield* fs.exists(path.join(root, ASIDE))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
