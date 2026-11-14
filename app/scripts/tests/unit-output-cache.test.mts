import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, Exit, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CacheReceiptSchema,
  firstOutputMismatch,
  gatesInputDigest,
  inventory,
  planOutputCache,
  requiredOutputs,
  requiredOutputMismatch,
  typeBundleMismatch,
} from '../ci/unit-output-cache.mts';
import type { CacheIdentity, CacheProfile, CacheReceipt, OutputFile } from '../ci/unit-output-cache.mts';
import type { GitEntry } from '../zerops/delivery-plan.mts';

const STAGE_ORIGIN = 'https://stage.example.test';

const UNIT = 'catalog';
const DIRECTORY = `app/verticals/${UNIT}`;
const DEPENDENCY = 'app/packages/catalog-contracts';
const UNRELATED = 'app/verticals/another';
const SOURCE = `${DIRECTORY}/src/service.ts`;
const COMMON = 'app/pnpm-lock.yaml';
const SHARED = `${UNRELATED}/shared/api.ts`;
const OLD_REVISION = 'a'.repeat(40);
const CURRENT_REVISION = 'b'.repeat(40);
const HASH = 'c'.repeat(64);
const OTHER_HASH = 'd'.repeat(64);
const BUILD = 'e'.repeat(64);
const FILE = 'dist/api/index.js';
const OUTPUT_ENTRY = '.output/index.js';
const ORIGIN = 'http://localhost:8080';
const profile: CacheProfile = {
  architecture: 'x64',
  command: 'pnpm run build',
  environment: [['MODERN_PUBLIC_SITE_URL', ORIGIN]],
  mode: 'production',
  node: 'v26.13.0',
  platform: 'linux',
  pnpm: '12.16.1',
  policy: 'full maps and type bundles',
  target: 'node',
  versions: { v8: 'example-v8' },
};
const inputs = {
  directory: DIRECTORY,
  entries: [
    { identity: '100644 blob first', path: SOURCE },
    { identity: '100644 blob dependency', path: `${DEPENDENCY}/index.ts` },
    { identity: '100644 blob lock', path: COMMON },
    { identity: '100644 blob tooling', path: 'app/scripts/build.mts' },
    { identity: '100644 blob shared', path: SHARED },
    { identity: '100644 blob isolated', path: `${UNRELATED}/src/service.ts` },
  ],
  origins: [ORIGIN, 'http://localhost:3001', 'http://localhost:3002'],
  packages: [
    { directory: DIRECTORY, name: '@app/catalog', workspaceDependencies: ['@app/catalog-contracts'] },
    { directory: DEPENDENCY, name: '@app/catalog-contracts', workspaceDependencies: [] },
    { directory: UNRELATED, name: '@app/another', workspaceDependencies: [] },
  ],
  profile,
  units: [
    { directory: DIRECTORY, id: UNIT },
    { directory: UNRELATED, id: 'another' },
  ],
};
const changeEntry = (filepath: string): readonly GitEntry[] =>
  inputs.entries.map((entry) =>
    entry.path === filepath ? { ...entry, identity: `${entry.identity}-changed` } : entry,
  );
const identity: CacheIdentity = { appId: UNIT, build: BUILD, buildMarker: BUILD, sourceRevision: OLD_REVISION };
const files: readonly OutputFile[] = [
  { mode: 0o644, path: FILE, sha256: HASH, size: 42 },
  { mode: 0o644, path: 'dist/source.js.map', sha256: OTHER_HASH, size: 120 },
];
const receipt: CacheReceipt = { digest: HASH, files, identity, schemaVersion: 1, unit: UNIT };
const check = (overrides: Partial<Parameters<typeof firstOutputMismatch>[0]> = {}) =>
  firstOutputMismatch({ digest: HASH, files, identity, receipt, unit: UNIT, ...overrides });

it.effect('is stable for identical inputs, documentation, and unrelated private unit changes', () =>
  Effect.gen(function* stableInputs() {
    const expected = yield* gatesInputDigest(inputs);
    expect(yield* gatesInputDigest(inputs)).toBe(expected);
    expect(yield* gatesInputDigest({ ...inputs, entries: changeEntry(`${UNRELATED}/src/service.ts`) })).toBe(expected);
    expect(
      yield* gatesInputDigest({
        ...inputs,
        entries: [...inputs.entries, { identity: '100644 blob docs', path: 'docs/guide.md' }],
      }),
    ).toBe(expected);
    return yield* Effect.void;
  }),
);

it.effect('changes for each committed input class, including Git modes and closure membership', () =>
  Effect.gen(function* committedInputs() {
    const expected = yield* gatesInputDigest(inputs);
    const paths = [SOURCE, `${DEPENDENCY}/index.ts`, COMMON, 'app/scripts/build.mts', SHARED];
    for (const filepath of paths) {
      expect(yield* gatesInputDigest({ ...inputs, entries: changeEntry(filepath) })).not.toBe(expected);
    }
    const modeChanged = inputs.entries.map((entry) =>
      entry.path === SOURCE ? { ...entry, identity: '100755 blob first' } : entry,
    );
    expect(yield* gatesInputDigest({ ...inputs, entries: modeChanged })).not.toBe(expected);
    expect(
      yield* gatesInputDigest({ ...inputs, entries: inputs.entries.filter((entry) => entry.path !== SOURCE) }),
    ).not.toBe(expected);
    const packages = inputs.packages.map((entry) =>
      entry.directory === DIRECTORY ? { ...entry, workspaceDependencies: [] } : entry,
    );
    expect(yield* gatesInputDigest({ ...inputs, packages })).not.toBe(expected);
    return yield* Effect.void;
  }),
);

it.effect('separates targets, modes, flags, origins, commands, policies and actual toolchain versions', () =>
  Effect.gen(function* buildInputs() {
    const expected = yield* gatesInputDigest(inputs);
    const changes: readonly Partial<CacheProfile>[] = [
      { target: 'cloudflare' },
      { mode: 'development' },
      { command: 'modern build --no-types' },
      { environment: [['ULTRAMODERN_DISABLE_BUILD_TS_CHECKER', '1']] },
      { environment: [['MODERN_PUBLIC_SITE_URL', STAGE_ORIGIN]] },
      { policy: 'no maps' },
      { node: 'v27.0.0' },
      { pnpm: '13.0.0' },
      { platform: 'darwin' },
      { architecture: 'arm64' },
      { versions: { v8: 'new-v8' } },
    ];
    for (const change of changes) {
      expect(yield* gatesInputDigest({ ...inputs, profile: { ...profile, ...change } })).not.toBe(expected);
    }
    for (const index of [0, 1, 2]) {
      const origins = inputs.origins.map((origin, position) => (position === index ? STAGE_ORIGIN : origin));
      expect(yield* gatesInputDigest({ ...inputs, origins })).not.toBe(expected);
    }
    return yield* Effect.void;
  }),
);

it('keeps only exact matches; missing, truncated, changed-mode and foreign outputs rebuild', () => {
  const missing = check({ files: [] });
  const truncated = check({ files: files.map((file) => ({ ...file, size: 1 })) });
  const mutated = check({ files: files.map((file) => ({ ...file, sha256: BUILD })) });
  const chmod = check({ files: files.map((file) => ({ ...file, mode: 0o755 })) });
  const foreign = check({ receipt: { ...receipt, unit: 'inventory' } });
  const renamed = check({ files: files.map((file) => ({ ...file, path: `${file.path}.old` })) });
  const plan = planOutputCache([
    { mismatch: check(), unit: UNIT },
    { mismatch: missing, unit: 'missing' },
    { mismatch: truncated, unit: 'truncated' },
    { mismatch: mutated, unit: 'mutated' },
    { mismatch: chmod, unit: 'chmod' },
    { mismatch: foreign, unit: 'foreign' },
    { mismatch: renamed, unit: 'renamed' },
  ]);
  expect(plan.keep).toEqual([UNIT]);
  expect(plan.build).toEqual(['missing', 'truncated', 'mutated', 'chmod', 'foreign', 'renamed']);
});

it('requires nonempty entrypoints independently of a matching receipt', () => {
  expect(requiredOutputMismatch(files, FILE)).toBeUndefined();
  expect(requiredOutputMismatch([], FILE)).toContain(FILE);
  expect(
    requiredOutputMismatch(
      files.map((file) => ({ ...file, size: 0 })),
      FILE,
    ),
  ).toContain(FILE);
  expect(requiredOutputMismatch(files, OUTPUT_ENTRY)).toContain(OUTPUT_ENTRY);
});

it('rejects empty and truncated type bundles', () => {
  expect(typeBundleMismatch(new Uint8Array())).toContain('header');
  const truncated = Buffer.alloc(40);
  truncated.writeUInt32LE(0x04_03_4b_50, 0);
  expect(typeBundleMismatch(truncated)).toContain('truncated');
  const complete = Buffer.alloc(98);
  complete.writeUInt32LE(0x04_03_4b_50, 0);
  complete.writeUInt32LE(0x02_01_4b_50, 30);
  complete.writeUInt32LE(0x06_05_4b_50, 76);
  complete.writeUInt32LE(46, 88);
  complete.writeUInt32LE(30, 92);
  expect(typeBundleMismatch(complete)).toBeUndefined();
});

it.effect('rejects a receipt from another target or origin even when the output bytes match', () =>
  Effect.gen(function* foreignBuild() {
    const original = yield* gatesInputDigest(inputs);
    const cached = { ...receipt, digest: original };
    const target = yield* gatesInputDigest({ ...inputs, profile: { ...profile, target: 'cloudflare' } });
    const origin = yield* gatesInputDigest({ ...inputs, origins: [STAGE_ORIGIN] });
    expect(check({ digest: target, receipt: cached })).toContain('input digest');
    expect(check({ digest: origin, receipt: cached })).toContain('input digest');
    return yield* Effect.void;
  }),
);

it('preserves an old build identity across a newer checkout and rejects identity rewriting', () => {
  expect(check()).toBeUndefined();
  expect(receipt.identity.sourceRevision).toBe(OLD_REVISION);
  expect(check({ identity: { ...identity, sourceRevision: CURRENT_REVISION } })).toContain('identity');
  expect(check({ identity: { ...identity, buildMarker: OTHER_HASH } })).toContain('identity');
});

it('decodes receipts with Schema and rejects missing, truncated or invalid JSON receipts', () => {
  const codec = Schema.fromJsonString(CacheReceiptSchema);
  const encoded = Schema.encodeSync(codec)(receipt);
  expect(Schema.decodeUnknownSync(codec)(encoded)).toEqual(receipt);
  for (const corrupt of ['', encoded.slice(0, -2), '{}', '{"schemaVersion":2}']) {
    expect(() => Schema.decodeUnknownSync(codec)(corrupt)).toThrow();
  }
});

/** A unit output whose .output/node_modules links an npm alias to the package it names, as Modern.js deploy does. */
const ALIAS = '@modern-js/contracts';
const ALIAS_LINK = `.output/node_modules/${ALIAS}`;
const linkedOutput = Effect.gen(function* linkedOutputFixture() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  const modules = path.join(root, '.output/node_modules');
  yield* fs.makeDirectory(path.join(root, 'dist'), { recursive: true });
  yield* fs.makeDirectory(path.join(modules, '@bleedingdev/contracts'), { recursive: true });
  yield* fs.makeDirectory(path.join(modules, '@modern-js'), { recursive: true });
  yield* fs.writeFileString(path.join(modules, '@bleedingdev/contracts/package.json'), '{"name":"contracts"}');
  yield* fs.symlink('../@bleedingdev/contracts', path.join(modules, ALIAS));
  return { fs, modules, root };
});

it.effect('keeps an in-output symlink as a link, and its target change rebuilds the unit', () =>
  Effect.gen(function* inOutputLink() {
    const { fs, modules, root } = yield* linkedOutput;
    const linked = yield* inventory(root);
    const link = linked.find((file) => file.path === ALIAS_LINK);
    expect(link?.link).toBe('../@bleedingdev/contracts');
    // The linked package is inventoried once, at its own path, not again through the link.
    expect(linked.filter((file) => file.path.endsWith('contracts/package.json')).map((file) => file.path)).toEqual([
      '.output/node_modules/@bleedingdev/contracts/package.json',
    ]);
    const cached = { ...receipt, files: linked };
    yield* fs.makeDirectory(path.join(modules, '@bleedingdev/other'));
    yield* fs.remove(path.join(modules, ALIAS));
    yield* fs.symlink('../@bleedingdev/other', path.join(modules, ALIAS));
    const changed = yield* inventory(root);
    expect(
      firstOutputMismatch({ digest: receipt.digest, files: changed, identity, receipt: cached, unit: UNIT }),
    ).toContain(ALIAS_LINK);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const [name, target] of [
  ['absolute', '/etc'],
  ['escaping', '../../../../outside'],
  ['dangling', '../@bleedingdev/missing'],
] as const) {
  it.effect(`rejects an ${name} symlink in a unit output`, () =>
    Effect.gen(function* rejectedLink() {
      const { fs, modules, root } = yield* linkedOutput;
      yield* fs.symlink(target, path.join(modules, '@modern-js/rejected'));
      expect(Exit.isFailure(yield* Effect.exit(inventory(root)))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it('requires the backend federation remote of every module, and none of the Shell that hosts them', () => {
  expect(requiredOutputs(UNIT)).toContain('dist/backend-mf-manifest.json');
  expect(requiredOutputs(UNIT)).toContain('dist/backendRemoteEntry.cjs');
  expect(requiredOutputs('shell-super-app')).toEqual([OUTPUT_ENTRY, '.output/package.json', FILE]);
});
