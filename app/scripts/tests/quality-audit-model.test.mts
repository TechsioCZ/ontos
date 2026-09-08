import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';

import { runEffectTestPromise } from '../../packages/core-runtime/src/testing/effect-runtime.ts';
import { buildKnipModel, KnipConfigSchema } from '../../quality-audit/knip-model.mts';
import { runQualityAudit } from '../quality-audit.mts';
import { runPinnedKnip } from './quality-audit-test-support.mts';

const rspackPackageName = '@rspack/core';
const fixtureModuleSource = 'module.exports = {};';
const packageFile = 'package.json';
const requirePrelude = [
  "import { createRequire } from 'node:module';",
  'const require = createRequire(import.meta.url);',
];
const resolverFile = 'src/resolver.ts';
const directFile = 'src/direct.ts';
const configurationFiles = '*.config.ts';
const sourcePattern = 'src/**/*.{ts,mts}';
const knipManifestFile = 'node_modules/knip/package.json';
const indexFile = 'src/index.ts';
const appRoot = path.resolve(import.meta.dirname, '../..');
const Names = Schema.Array(Schema.Struct({ name: Schema.String }));
const ReportSchema = Schema.Struct({
  issues: Schema.Array(
    Schema.Struct({
      dependencies: Names,
      exports: Names,
      file: Schema.String,
      files: Names,
      unlisted: Names,
    }),
  ),
});
const stringify = async (value: Schema.Json) =>
  await runEffectTestPromise(Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value));
const write = (root: string, file: string, source: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), source);
};

const fixture = async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ontos-knip-model-')));
  symlinkSync(path.join(appRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  write(
    root,
    packageFile,
    await stringify({
      dependencies: {
        'drizzle-orm': '1.0.0-rc.4',
        effect: '4.0.0-beta.107',
        jose: '6.2.5',
      },
      name: 'knip-consumer-controls',
      private: true,
      type: 'module',
      workspaces: ['verticals/*', 'packages/*'],
    }),
  );
  write(
    root,
    indexFile,
    [
      "import { used } from './helper.ts';",
      "console.log(used, new URL('./worker.mts', import.meta.url));",
      "void import('declaredRemote/Public');",
      "void import('misspelledRemote/Public');",
      "void import('shadowedRemote/Public');",
      "void import('./resolver.ts'); void import('./direct.ts'); void import('./own-resolver.ts');",
    ].join('\n'),
  );
  const resolverOwner = '.resolver-fixture/node_modules/owner';
  const resolverTarget = `${resolverOwner}/node_modules/@rspack/core`;
  write(
    root,
    `${resolverOwner}/package.json`,
    await stringify({
      dependencies: { [rspackPackageName]: '1.0.0' },
      main: 'index.js',
      name: 'fixture-owner',
    }),
  );
  write(root, `${resolverOwner}/index.js`, fixtureModuleSource);
  write(
    root,
    `${resolverTarget}/package.json`,
    await stringify({ main: 'index.js', name: rspackPackageName }),
  );
  write(root, `${resolverTarget}/index.js`, fixtureModuleSource);
  const resolverAnchor = path.join(root, resolverOwner, 'index.js');
  write(
    root,
    resolverFile,
    [
      ...requirePrelude,
      `require.resolve('@rspack/core', { paths: [${JSON.stringify(resolverAnchor)}] });`,
    ].join('\n'),
  );
  write(
    root,
    'src/own-resolver.ts',
    [
      ...requirePrelude,
      `require.resolve('oxc-parser', { paths: [${JSON.stringify(root)}] });`,
    ].join('\n'),
  );
  write(
    root,
    'verticals/remote/package.json',
    await stringify({
      dependencies: { 'drizzle-orm': '1.0.0-rc.4', effect: '4.0.0-beta.107' },
      name: 'remote-controls',
      private: true,
      type: 'module',
      'zephyr:dependencies': { composed: 'drizzle-orm@workspace:*' },
    }),
  );
  write(
    root,
    'verticals/remote/src/index.ts',
    "void import('childRemote/Public'); void import('misspelledChild/Public'); void import('declaredRemote/Public');",
  );
  write(
    root,
    'verticals/remote/module-federation.config.ts',
    "export default {remotes: {childRemote:'child@https://example.test/remote.js'}};",
  );
  write(root, 'src/validated.ts', 'export const unusedValidatedExport = 1;');
  write(
    root,
    'scripts/validate-ultramodern-workspace.mts',
    [
      "const requiredPaths = ['src/validated.ts']; for (const file of requiredPaths) console.log(file);",
      "const workspaceValidationContractDefinition = {topology: {compactConfig: {apps: [{path:'verticals/remote'}]}}};",
      'for (const expectedApp of workspaceValidationContractDefinition.topology.compactConfig.apps) {',
      'const appPath = expectedApp.path;',
      `const buildModuleSource = readText(\`\${appPath}/shared/ultramodern-build.ts\`);`,
      "console.log(buildModuleSource.includes('export const declaredBuildIdentity')); }",
    ].join('\n'),
  );
  write(
    root,
    'verticals/remote/shared/ultramodern-build.ts',
    'export const declaredBuildIdentity = 1; export const unusedBuildNeighbor = 2;',
  );
  write(
    root,
    'tools/oxlint/effect-native/report.mts',
    "runOxlint(join(pluginDirectory, 'report.config.ts'), []);",
  );
  write(
    root,
    'tools/oxlint/effect-native/report.config.ts',
    'export default {}; export const unusedConfigNeighbor = 3;',
  );
  write(root, directFile, "import '@rspack/core';");
  write(root, 'src/helper.ts', 'export const used = 1; export const unusedNeighbor = 2;');
  write(root, 'src/worker.mts', 'console.log("worker"); export const unusedWorkerExport = 3;');
  write(root, 'src/dead.ts', 'export const genuinelyDead = 1;');
  write(root, 'src/public.ts', 'export const externallyConsumed = 1;');
  write(
    root,
    'src/schema.ts',
    [
      "import { pgSchema } from 'drizzle-orm/pg-core';",
      "export const registeredSchema = pgSchema('registered');",
      'export const unregisteredHelper = () => 7;',
    ].join('\n'),
  );
  write(
    root,
    'module-federation.config.ts',
    [
      "throw new Error('configuration must never execute');",
      "const remotes = { declaredRemote: 'remote@https://example.test/remote.js' };",
      "function shadow() { const remotes = { shadowedRemote: 'wrong' }; return remotes; }",
      'export default {',
      'remotes,',
      "shared: { effect: { singleton: true } }, exposes: { './Public': './src/public.ts' } };",
    ].join('\n'),
  );
  write(
    root,
    'drizzle.config.ts',
    "throw new Error('configuration must never execute'); export default { schema: './src/schema.ts' };",
  );
  return root;
};

await test('real pinned Knip models exact consumers and preserves neighboring findings', async () => {
  const root = await fixture();
  try {
    const base = await runEffectTestPromise(
      Schema.decodeUnknownEffect(KnipConfigSchema)({
        workspaces: {
          '.': {
            drizzle: { config: [] },
            entry: [indexFile, configurationFiles],
            lefthook: false,
            node: false,
            project: [sourcePattern, configurationFiles, 'tools/**/*.{ts,mts}'],
          },
          'verticals/*': {
            entry: [indexFile, configurationFiles],
            project: ['**/*.{ts,mts}'],
          },
        },
      }),
    );
    const consumerPath = path.join(root, '.codex/knip-model/consumers.mts');
    const model = await runEffectTestPromise(
      buildKnipModel(root, base, consumerPath).pipe(Effect.provide(NodeServices.layer)),
    );
    const run = await runPinnedKnip(root, consumerPath, model);
    assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
    assert.equal(run.stderr, '');
    const report = await runEffectTestPromise(
      Schema.decodeUnknownEffect(Schema.fromJsonString(ReportSchema))(run.stdout),
    );
    const findings = (kind: 'files' | 'exports' | 'dependencies' | 'unlisted') =>
      report.issues.flatMap((issue) =>
        issue[kind].map((finding) => `${issue.file}#${finding.name}`),
      );
    assert.ok(findings('files').includes('src/dead.ts#src/dead.ts'));
    assert.ok(!findings('files').some((finding) => finding.startsWith('src/worker.mts#')));
    assert.ok(!findings('files').some((finding) => finding.startsWith('src/public.ts#')));
    assert.ok(findings('exports').includes('src/helper.ts#unusedNeighbor'));
    assert.ok(findings('exports').includes('src/validated.ts#unusedValidatedExport'));
    assert.ok(
      !findings('exports').includes(
        'verticals/remote/shared/ultramodern-build.ts#declaredBuildIdentity',
      ),
    );
    assert.ok(
      findings('exports').includes(
        'verticals/remote/shared/ultramodern-build.ts#unusedBuildNeighbor',
      ),
    );
    assert.ok(!findings('exports').includes('tools/oxlint/effect-native/report.config.ts#default'));
    assert.ok(
      findings('exports').includes(
        'tools/oxlint/effect-native/report.config.ts#unusedConfigNeighbor',
      ),
    );
    assert.ok(!findings('files').some((finding) => finding.startsWith('src/validated.ts#')));
    assert.ok(findings('exports').includes('src/schema.ts#unregisteredHelper'));
    assert.ok(!findings('exports').includes('src/schema.ts#registeredSchema'));
    assert.ok(!findings('exports').includes('src/public.ts#externallyConsumed'));
    assert.ok(findings('dependencies').includes('package.json#jose'));
    assert.ok(!findings('dependencies').includes('package.json#effect'));
    assert.ok(findings('unlisted').includes('src/index.ts#misspelledRemote'));
    assert.ok(findings('unlisted').includes('src/index.ts#declaredRemote'));
    assert.ok(!findings('unlisted').includes('verticals/remote/src/index.ts#childRemote'));
    assert.ok(findings('unlisted').includes('verticals/remote/src/index.ts#misspelledChild'));
    assert.ok(findings('unlisted').includes('verticals/remote/src/index.ts#declaredRemote'));
    assert.ok(findings('dependencies').includes('verticals/remote/package.json#effect'));
    assert.ok(
      !findings('dependencies').includes('verticals/remote/package.json#drizzle-orm'),
      'a zephyr:dependencies composition reference must count as a dependency consumer',
    );
    assert.deepEqual(model.config.workspaces['.']?.ignoreDependencies, []);
    assert.ok(findings('unlisted').includes('src/index.ts#shadowedRemote'));
    assert.ok(findings('unlisted').includes('src/direct.ts#@rspack/core'));
    assert.ok(findings('unlisted').includes('src/own-resolver.ts#oxc-parser'));
    assert.ok(
      !model.evidence.some(
        (item) => item.kind === 'resolver' && item.source === 'src/own-resolver.ts',
      ),
    );
    assert.ok(
      model.evidence.some(
        (item) =>
          item.kind === 'resolver' &&
          item.source === resolverFile &&
          item.target === rspackPackageName &&
          item.line === 3 &&
          item.column === 17 &&
          item.resolved !== undefined,
      ),
    );
    assert.ok(
      !model.evidence.some((item) => item.kind === 'resolver' && item.source === directFile),
    );
    assert.ok(
      model.evidence.some(
        (item) => item.target === 'src/schema.ts#registeredSchema' && item.kind === 'export',
      ),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

await test('modeling fails on invalid source instead of silently losing consumer evidence', async () => {
  const root = await fixture();
  try {
    write(root, 'module-federation.config.ts', 'export default { broken: ;');
    await assert.rejects(
      runEffectTestPromise(
        buildKnipModel(root, { entry: [indexFile] }).pipe(Effect.provide(NodeServices.layer)),
      ),
      { reason: /Invalid quality model source/u },
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

await test('the model regression harness uses the repository-pinned Knip version', async () => {
  const manifest = await runEffectTestPromise(
    Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Struct({ version: Schema.Literal('6.34.0') })),
    )(readFileSync(path.join(appRoot, knipManifestFile), 'utf-8')),
  );
  assert.equal(manifest.version, '6.34.0');
});

await test('runner calibrates only the proven resolver record and retains the direct import', async () => {
  const root = await fixture();
  const installedManifest = readFileSync(path.join(appRoot, knipManifestFile));
  const installedBinary = readFileSync(path.join(appRoot, 'node_modules/.bin/knip'));
  const output = realpathSync(mkdtempSync(path.join(tmpdir(), 'ontos-knip-model-output-')));
  try {
    write(
      root,
      'quality-audit/scope.json',
      await stringify({
        exclude: [],
        patterns: [sourcePattern, configurationFiles, 'verticals/**/*.{ts,mts}'],
      }),
    );
    write(
      root,
      'quality-audit/knip.json',
      await stringify({
        workspaces: {
          '.': {
            drizzle: { config: [] },
            entry: [indexFile, configurationFiles],
            lefthook: false,
            node: false,
            project: [sourcePattern, configurationFiles, 'tools/**/*.{ts,mts}'],
          },
          'verticals/*': {
            entry: [indexFile, configurationFiles],
            project: ['**/*.{ts,mts}'],
          },
        },
      }),
    );
    write(
      root,
      'quality-audit/knip-reporter.mts',
      readFileSync(path.join(appRoot, 'quality-audit/knip-reporter.mts'), 'utf-8'),
    );
    await runEffectTestPromise(
      runQualityAudit(root, output, 'knip').pipe(Effect.provide(NodeServices.layer)),
    );
    assert.deepEqual(readFileSync(path.join(appRoot, knipManifestFile)), installedManifest);
    assert.deepEqual(readFileSync(path.join(appRoot, 'node_modules/.bin/knip')), installedBinary);
    const summary = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          results: Schema.Array(
            Schema.Struct({
              coverage: Schema.Struct({
                findingCounts: Schema.Record(Schema.String, Schema.Number),
                modeledUsages: Schema.Number,
                nativeFindingCounts: Schema.Record(Schema.String, Schema.Number),
              }),
              name: Schema.String,
            }),
          ),
          runDirectory: Schema.String,
          status: Schema.Literal('reported'),
        }),
      ),
    )(readFileSync(path.join(output, 'summary.json'), 'utf-8'));
    const result = summary.results.find((entry) => entry.name === 'knip');
    assert.ok(result !== undefined);
    assert.equal(result.coverage.modeledUsages, 1);
    assert.equal(
      result.coverage.nativeFindingCounts.unlisted,
      (result.coverage.findingCounts.unlisted ?? 0) + 1,
    );
    const modeled = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Array(Schema.Struct({ file: Schema.String }))),
    )(readFileSync(path.join(summary.runDirectory, 'knip/modeled-usages.json'), 'utf-8'));
    assert.deepEqual(modeled, [{ file: resolverFile }]);
    const raw = Schema.decodeUnknownSync(Schema.fromJsonString(ReportSchema))(
      readFileSync(path.join(summary.runDirectory, 'knip/report.ndjson'), 'utf-8')
        .trim()
        .split('\n')[0],
    );
    assert.ok(
      raw.issues.some(
        (issue) =>
          issue.file === directFile &&
          issue.unlisted.some((entry) => entry.name === rspackPackageName),
      ),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(output, { force: true, recursive: true });
  }
});

await test('vendor ownership rejects a different installed copy and accepts the same canonical target', async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ontos-knip-copy-controls-')));
  try {
    write(root, packageFile, await stringify({ name: 'copy-controls', private: true }));
    const owner = 'node_modules/owner';
    const producer = `${owner}/node_modules/producer`;
    const ownerTarget = `${owner}/node_modules/target`;
    const producerTarget = `${producer}/node_modules/target`;
    await Promise.all(
      (
        [
          [owner, 'owner', { producer: '1.0.0' }],
          [producer, 'producer', { target: '1.0.0' }],
          [ownerTarget, 'target', {}],
          [producerTarget, 'target', {}],
        ] as const
      ).map(async ([directory, name, dependencies]) => {
        write(
          root,
          `${directory}/package.json`,
          await stringify({ dependencies, main: 'index.js', name }),
        );
        write(root, `${directory}/index.js`, fixtureModuleSource);
      }),
    );
    write(
      root,
      indexFile,
      [
        ...requirePrelude,
        `require.resolve('target', { paths: [${JSON.stringify(path.join(root, owner, 'index.js'))}] });`,
      ].join('\n'),
    );
    const consumerPath = path.join(root, '.audit/consumers.mts');
    const build = async () =>
      await runEffectTestPromise(
        buildKnipModel(
          root,
          { entry: [indexFile], node: false, project: [sourcePattern] },
          consumerPath,
        ).pipe(Effect.provide(NodeServices.layer)),
      );
    const differentCopies = await build();
    assert.ok(
      !differentCopies.evidence.some(
        (item) => item.kind === 'resolver' && item.target === 'target',
      ),
    );
    const mismatch = differentCopies.evidence.find(
      (item) => item.kind === 'resolver-unproven' && item.target === 'target',
    );
    assert.ok(mismatch !== undefined);
    assert.equal(mismatch.producerManifest, path.join(root, producer, packageFile));
    assert.equal(
      mismatch.producerResolved,
      realpathSync(path.join(root, producerTarget, 'index.js')),
    );
    assert.equal(mismatch.resolved, realpathSync(path.join(root, ownerTarget, 'index.js')));
    assert.match(mismatch.reason, /different canonical target/u);
    const run = await runPinnedKnip(root, consumerPath, differentCopies);
    assert.equal(run.status, 1, run.stderr);
    const report = Schema.decodeUnknownSync(Schema.fromJsonString(ReportSchema))(run.stdout);
    assert.ok(
      report.issues.some(
        (issue) =>
          issue.file === indexFile && issue.unlisted.some((item) => item.name === 'target'),
      ),
    );
    rmSync(path.join(root, producerTarget), { force: true, recursive: true });
    symlinkSync(path.join(root, ownerTarget), path.join(root, producerTarget), 'dir');
    const sameCopy = await build();
    assert.ok(
      sameCopy.evidence.some(
        (item) =>
          item.kind === 'resolver' &&
          item.target === 'target' &&
          item.owningManifest === path.join(root, producer, packageFile),
      ),
    );
    write(
      root,
      indexFile,
      [
        ...requirePrelude,
        `require.resolve('target', { paths: [${await stringify(path.join(root, owner, 'missing'))}] });`,
      ].join('\n'),
    );
    const missingAnchor = await build();
    assert.ok(
      !missingAnchor.evidence.some((item) => item.kind === 'resolver' && item.target === 'target'),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
