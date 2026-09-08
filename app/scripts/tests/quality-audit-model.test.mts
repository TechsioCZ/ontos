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

import { NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  buildKnipModel,
  KnipConfigSchema,
} from '../../quality-audit/knip-model.mts';
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
const toolsPattern = 'tools/**/*.{ts,mts}';
const sourcePattern = 'src/**/*.{ts,mts}';
const knipManifestFile = 'node_modules/knip/package.json';
const indexFile = 'src/index.ts';
const rstestConfigFile = 'rstest.config.ts';
const auditConsumersFile = '.audit/consumers.mts';
const rstestEnvironmentReason = 'Rstest testEnvironment consumer';
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
    })
  ),
});
const stringify = (value: Schema.Json) =>
  Effect.gen(function* testEffect1() {
    return yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
      value
    );
  });
const write = (root: string, file: string, source: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), source);
};

const fixture = () =>
  Effect.gen(function* testEffect2() {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(path.join(tmpdir(), 'ontos-knip-model-'))),
      (directory) =>
        Effect.sync(() => rmSync(directory, { force: true, recursive: true }))
    ).pipe(Effect.map((directory) => realpathSync(directory)));
    symlinkSync(
      path.join(appRoot, 'node_modules'),
      path.join(root, 'node_modules'),
      'dir'
    );
    write(
      root,
      packageFile,
      yield* stringify({
        dependencies: {
          'drizzle-orm': '1.0.0-rc.4',
          effect: '4.0.0-beta.107',
          jose: '6.2.5',
        },
        name: 'knip-consumer-controls',
        private: true,
        type: 'module',
        workspaces: ['verticals/*', 'packages/*'],
      })
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
      ].join('\n')
    );
    const resolverOwner = '.resolver-fixture/node_modules/owner';
    const resolverTarget = `${resolverOwner}/node_modules/@rspack/core`;
    write(
      root,
      `${resolverOwner}/package.json`,
      yield* stringify({
        dependencies: { [rspackPackageName]: '1.0.0' },
        main: 'index.js',
        name: 'fixture-owner',
      })
    );
    write(root, `${resolverOwner}/index.js`, fixtureModuleSource);
    write(
      root,
      `${resolverTarget}/package.json`,
      yield* stringify({ main: 'index.js', name: rspackPackageName })
    );
    write(root, `${resolverTarget}/index.js`, fixtureModuleSource);
    const resolverAnchor = path.join(root, resolverOwner, 'index.js');
    write(
      root,
      resolverFile,
      [
        ...requirePrelude,
        `require.resolve('@rspack/core', { paths: [${JSON.stringify(resolverAnchor)}] });`,
      ].join('\n')
    );
    write(
      root,
      'src/own-resolver.ts',
      [
        ...requirePrelude,
        `require.resolve('oxc-parser', { paths: [${JSON.stringify(root)}] });`,
      ].join('\n')
    );
    write(
      root,
      'verticals/remote/package.json',
      yield* stringify({
        dependencies: { 'drizzle-orm': '1.0.0-rc.4', effect: '4.0.0-beta.107' },
        name: 'remote-controls',
        private: true,
        type: 'module',
        'zephyr:dependencies': { composed: 'drizzle-orm@workspace:*' },
      })
    );
    write(
      root,
      'verticals/remote/src/index.ts',
      "void import('childRemote/Public'); void import('misspelledChild/Public'); void import('declaredRemote/Public');"
    );
    write(
      root,
      'verticals/remote/module-federation.config.ts',
      "export default {remotes: {childRemote:'child@https://example.test/remote.js'}};"
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
      ].join('\n')
    );
    write(
      root,
      'verticals/remote/shared/ultramodern-build.ts',
      'export const declaredBuildIdentity = 1; export const unusedBuildNeighbor = 2;'
    );
    write(
      root,
      'tools/oxlint/effect-native/report.mts',
      "runOxlint(join(pluginDirectory, 'report.config.ts'), []);"
    );
    write(
      root,
      'tools/oxlint/effect-native/report.config.ts',
      'export default {}; export const unusedConfigNeighbor = 3;'
    );
    write(root, directFile, "import '@rspack/core';");
    write(
      root,
      'src/helper.ts',
      'export const used = 1; export const unusedNeighbor = 2;'
    );
    write(
      root,
      'src/worker.mts',
      'console.log("worker"); export const unusedWorkerExport = 3;'
    );
    write(root, 'src/dead.ts', 'export const genuinelyDead = 1;');
    write(root, 'src/public.ts', 'export const externallyConsumed = 1;');
    write(
      root,
      'src/schema.ts',
      [
        "import { pgSchema } from 'drizzle-orm/pg-core';",
        "export const registeredSchema = pgSchema('registered');",
        'export const unregisteredHelper = () => 7;',
      ].join('\n')
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
      ].join('\n')
    );
    write(
      root,
      'drizzle.config.ts',
      "throw new Error('configuration must never execute'); export default { schema: './src/schema.ts' };"
    );
    return root;
  });

it.live(
  'real pinned Knip models exact consumers and preserves neighboring findings',
  Effect.fn(function* testEffect3() {
    const root = yield* fixture();
    const base = yield* Schema.decodeUnknownEffect(KnipConfigSchema)({
      workspaces: {
        '.': {
          drizzle: { config: [] },
          entry: [indexFile, configurationFiles],
          lefthook: false,
          node: false,
          project: [sourcePattern, configurationFiles, toolsPattern],
        },
        'verticals/*': {
          entry: [indexFile, configurationFiles],
          project: ['**/*.{ts,mts}'],
        },
      },
    });
    const consumerPath = path.join(root, '.codex/knip-model/consumers.mts');
    const model = yield* buildKnipModel(root, base, consumerPath).pipe(
      Effect.provide(NodeServices.layer)
    );
    const run = yield* runPinnedKnip(root, consumerPath, model).pipe(
      Effect.provide(NodeServices.layer)
    );
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(1);
    expect(run.stderr).toBe('');
    const report = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(ReportSchema)
    )(run.stdout);
    const findings = (
      kind: 'files' | 'exports' | 'dependencies' | 'unlisted'
    ) =>
      report.issues.flatMap((issue) =>
        issue[kind].map((finding) => `${issue.file}#${finding.name}`)
      );
    expect(findings('files').includes('src/dead.ts#src/dead.ts')).toBe(true);
    expect(
      !findings('files').some((finding) =>
        finding.startsWith('src/worker.mts#')
      )
    ).toBe(true);
    expect(
      !findings('files').some((finding) => finding.startsWith('src/public.ts#'))
    ).toBe(true);
    expect(findings('exports').includes('src/helper.ts#unusedNeighbor')).toBe(
      true
    );
    expect(
      findings('exports').includes('src/validated.ts#unusedValidatedExport')
    ).toBe(true);
    expect(
      !findings('exports').includes(
        'verticals/remote/shared/ultramodern-build.ts#declaredBuildIdentity'
      )
    ).toBe(true);
    expect(
      findings('exports').includes(
        'verticals/remote/shared/ultramodern-build.ts#unusedBuildNeighbor'
      )
    ).toBe(true);
    expect(
      !findings('exports').includes(
        'tools/oxlint/effect-native/report.config.ts#default'
      )
    ).toBe(true);
    expect(
      findings('exports').includes(
        'tools/oxlint/effect-native/report.config.ts#unusedConfigNeighbor'
      )
    ).toBe(true);
    expect(
      !findings('files').some((finding) =>
        finding.startsWith('src/validated.ts#')
      )
    ).toBe(true);
    expect(
      findings('exports').includes('src/schema.ts#unregisteredHelper')
    ).toBe(true);
    expect(
      !findings('exports').includes('src/schema.ts#registeredSchema')
    ).toBe(true);
    expect(
      !findings('exports').includes('src/public.ts#externallyConsumed')
    ).toBe(true);
    expect(findings('dependencies').includes('package.json#jose')).toBe(true);
    expect(!findings('dependencies').includes('package.json#effect')).toBe(
      true
    );
    expect(findings('unlisted').includes('src/index.ts#misspelledRemote')).toBe(
      true
    );
    expect(findings('unlisted').includes('src/index.ts#declaredRemote')).toBe(
      true
    );
    expect(
      !findings('unlisted').includes(
        'verticals/remote/src/index.ts#childRemote'
      )
    ).toBe(true);
    expect(
      findings('unlisted').includes(
        'verticals/remote/src/index.ts#misspelledChild'
      )
    ).toBe(true);
    expect(
      findings('unlisted').includes(
        'verticals/remote/src/index.ts#declaredRemote'
      )
    ).toBe(true);
    expect(
      findings('dependencies').includes('verticals/remote/package.json#effect')
    ).toBe(true);
    expect(
      findings('dependencies').includes(
        'verticals/remote/package.json#drizzle-orm'
      ),
      'a zephyr:dependencies composition reference must count as a dependency consumer'
    ).toBe(false);
    expect(model.config.workspaces['.']?.ignoreDependencies).toEqual([]);
    expect(findings('unlisted').includes('src/index.ts#shadowedRemote')).toBe(
      true
    );
    expect(findings('unlisted').includes('src/direct.ts#@rspack/core')).toBe(
      true
    );
    expect(
      findings('unlisted').includes('src/own-resolver.ts#oxc-parser')
    ).toBe(true);
    expect(
      !model.evidence.some(
        (item) =>
          item.kind === 'resolver' && item.source === 'src/own-resolver.ts'
      )
    ).toBe(true);
    expect(
      model.evidence.some(
        (item) =>
          item.kind === 'resolver' &&
          item.source === resolverFile &&
          item.target === rspackPackageName &&
          item.line === 3 &&
          item.column === 17 &&
          item.resolved !== undefined
      )
    ).toBe(true);
    expect(
      !model.evidence.some(
        (item) => item.kind === 'resolver' && item.source === directFile
      )
    ).toBe(true);
    expect(
      model.evidence.some(
        (item) =>
          item.target === 'src/schema.ts#registeredSchema' &&
          item.kind === 'export'
      )
    ).toBe(true);
  })
);

it.live(
  'modeling fails on invalid source instead of silently losing consumer evidence',
  Effect.fn(function* testEffect4() {
    const root = yield* fixture();
    write(root, 'module-federation.config.ts', 'export default { broken: ;');
    yield* buildKnipModel(root, { entry: [indexFile] })
      .pipe(Effect.provide(NodeServices.layer))
      .pipe(
        Effect.flip,
        Effect.map((error) =>
          expect(
            Schema.decodeUnknownSync(Schema.Struct({ reason: Schema.String }))(
              error
            ).reason
          ).toMatch(/Invalid quality model source/u)
        )
      );
  })
);

it.live(
  'the model regression harness uses the repository-pinned Knip version',
  Effect.fn(function* testEffect5() {
    const manifest = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({ version: Schema.Literal('6.34.0') })
      )
    )(readFileSync(path.join(appRoot, knipManifestFile), 'utf-8'));
    expect(manifest.version).toBe('6.34.0');
  })
);

it.live(
  'runner calibrates only the proven resolver record and retains the direct import',
  Effect.fn(function* testEffect6() {
    const root = yield* fixture();
    const installedManifest = readFileSync(
      path.join(appRoot, knipManifestFile)
    );
    const installedBinary = readFileSync(
      path.join(appRoot, 'node_modules/.bin/knip')
    );
    const output = yield* Effect.acquireRelease(
      Effect.sync(() =>
        mkdtempSync(path.join(tmpdir(), 'ontos-knip-model-output-'))
      ),
      (directory) =>
        Effect.sync(() => rmSync(directory, { force: true, recursive: true }))
    ).pipe(Effect.map((directory) => realpathSync(directory)));
    write(
      root,
      'quality-audit/scope.json',
      yield* stringify({
        exclude: [],
        patterns: [
          sourcePattern,
          configurationFiles,
          'verticals/**/*.{ts,mts}',
        ],
      })
    );
    write(
      root,
      'quality-audit/knip.json',
      yield* stringify({
        workspaces: {
          '.': {
            drizzle: { config: [] },
            entry: [indexFile, configurationFiles],
            lefthook: false,
            node: false,
            project: [sourcePattern, configurationFiles, toolsPattern],
          },
          'verticals/*': {
            entry: [indexFile, configurationFiles],
            project: ['**/*.{ts,mts}'],
          },
        },
      })
    );
    write(
      root,
      'quality-audit/knip-reporter.mts',
      readFileSync(
        path.join(appRoot, 'quality-audit/knip-reporter.mts'),
        'utf-8'
      )
    );
    yield* runQualityAudit(root, output, 'knip').pipe(
      Effect.provide(NodeServices.layer)
    );
    expect(readFileSync(path.join(appRoot, knipManifestFile))).toEqual(
      installedManifest
    );
    expect(readFileSync(path.join(appRoot, 'node_modules/.bin/knip'))).toEqual(
      installedBinary
    );
    const summary = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          results: Schema.Array(
            Schema.Struct({
              coverage: Schema.Struct({
                findingCounts: Schema.Record(Schema.String, Schema.Number),
                modeledUsages: Schema.Number,
                nativeFindingCounts: Schema.Record(
                  Schema.String,
                  Schema.Number
                ),
              }),
              name: Schema.String,
            })
          ),
          runDirectory: Schema.String,
          status: Schema.Literal('reported'),
        })
      )
    )(readFileSync(path.join(output, 'summary.json'), 'utf-8'));
    const result = summary.results.find((entry) => entry.name === 'knip');
    expect(result !== undefined).toBe(true);
    if (result === undefined) {
      throw new Error('Expected result to be present');
    }
    expect(result.coverage.modeledUsages).toBe(1);
    expect(result.coverage.nativeFindingCounts.unlisted).toBe(
      (result.coverage.findingCounts.unlisted ?? 0) + 1
    );
    const modeled = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Array(Schema.Struct({ file: Schema.String }))
      )
    )(
      readFileSync(
        path.join(summary.runDirectory, 'knip/modeled-usages.json'),
        'utf-8'
      )
    );
    expect(modeled).toEqual([{ file: resolverFile }]);
    const raw = Schema.decodeUnknownSync(Schema.fromJsonString(ReportSchema))(
      readFileSync(
        path.join(summary.runDirectory, 'knip/report.ndjson'),
        'utf-8'
      )
        .trim()
        .split('\n')[0]
    );
    expect(
      raw.issues.some(
        (issue) =>
          issue.file === directFile &&
          issue.unlisted.some((entry) => entry.name === rspackPackageName)
      )
    ).toBe(true);
  })
);

it.live(
  'vendor ownership rejects a different installed copy and accepts the same canonical target',
  Effect.fn(function* testEffect7() {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() =>
        mkdtempSync(path.join(tmpdir(), 'ontos-knip-copy-controls-'))
      ),
      (directory) =>
        Effect.sync(() => rmSync(directory, { force: true, recursive: true }))
    ).pipe(Effect.map((directory) => realpathSync(directory)));
    write(
      root,
      packageFile,
      yield* stringify({ name: 'copy-controls', private: true })
    );
    const owner = 'node_modules/owner';
    const producer = `${owner}/node_modules/producer`;
    const ownerTarget = `${owner}/node_modules/target`;
    const producerTarget = `${producer}/node_modules/target`;
    yield* Effect.all(
      (
        [
          [owner, 'owner', { producer: '1.0.0' }],
          [producer, 'producer', { target: '1.0.0' }],
          [ownerTarget, 'target', {}],
          [producerTarget, 'target', {}],
        ] as const
      ).map(([directory, name, dependencies]) =>
        Effect.gen(function* testEffect8() {
          write(
            root,
            `${directory}/package.json`,
            yield* stringify({ dependencies, main: 'index.js', name })
          );
          write(root, `${directory}/index.js`, fixtureModuleSource);
        })
      ),
      { concurrency: 'unbounded' }
    );
    write(
      root,
      indexFile,
      [
        ...requirePrelude,
        `require.resolve('target', { paths: [${JSON.stringify(path.join(root, owner, 'index.js'))}] });`,
      ].join('\n')
    );
    const consumerPath = path.join(root, auditConsumersFile);
    const build = () =>
      Effect.gen(function* testEffect9() {
        return yield* buildKnipModel(
          root,
          { entry: [indexFile], node: false, project: [sourcePattern] },
          consumerPath
        ).pipe(Effect.provide(NodeServices.layer));
      });
    const differentCopies = yield* build();
    expect(
      !differentCopies.evidence.some(
        (item) => item.kind === 'resolver' && item.target === 'target'
      )
    ).toBe(true);
    const mismatch = differentCopies.evidence.find(
      (item) => item.kind === 'resolver-unproven' && item.target === 'target'
    );
    expect(mismatch !== undefined).toBe(true);
    if (mismatch === undefined) {
      throw new Error('Expected mismatch to be present');
    }
    expect(mismatch.producerManifest).toBe(
      path.join(root, producer, packageFile)
    );
    expect(mismatch.producerResolved).toBe(
      realpathSync(path.join(root, producerTarget, 'index.js'))
    );
    expect(mismatch.resolved).toBe(
      realpathSync(path.join(root, ownerTarget, 'index.js'))
    );
    expect(mismatch.reason).toMatch(/different canonical target/u);
    const run = yield* runPinnedKnip(root, consumerPath, differentCopies).pipe(
      Effect.provide(NodeServices.layer)
    );
    expect(run.status, run.stderr).toBe(1);
    const report = Schema.decodeUnknownSync(
      Schema.fromJsonString(ReportSchema)
    )(run.stdout);
    expect(
      report.issues.some(
        (issue) =>
          issue.file === indexFile &&
          issue.unlisted.some((item) => item.name === 'target')
      )
    ).toBe(true);
    rmSync(path.join(root, producerTarget), { force: true, recursive: true });
    symlinkSync(
      path.join(root, ownerTarget),
      path.join(root, producerTarget),
      'dir'
    );
    const sameCopy = yield* build();
    expect(
      sameCopy.evidence.some(
        (item) =>
          item.kind === 'resolver' &&
          item.target === 'target' &&
          item.owningManifest === path.join(root, producer, packageFile)
      )
    ).toBe(true);
    write(
      root,
      indexFile,
      [
        ...requirePrelude,
        `require.resolve('target', { paths: [${yield* stringify(path.join(root, owner, 'missing'))}] });`,
      ].join('\n')
    );
    const missingAnchor = yield* build();
    expect(
      !missingAnchor.evidence.some(
        (item) => item.kind === 'resolver' && item.target === 'target'
      )
    ).toBe(true);
  })
);

it.live(
  'Rstest, compiler type tests and Oxlint loaders consume files without hiding unused exports',
  Effect.fn(function* testConsumerExports() {
    const root = yield* fixture();
    const lintDirectory = 'tools/oxlint/effect-native';
    const policyTest = `${lintDirectory}/tests/repository-policy.test.mts`;
    const helperTest = `${lintDirectory}/tests/shared-helpers.test.mts`;
    const loadedFiles = [
      rstestConfigFile,
      `${lintDirectory}/repository-policy.config.ts`,
      `${lintDirectory}/tests/shared-helpers-probe.ts`,
    ];
    write(
      root,
      packageFile,
      '{"name":"consumer-controls","type":"module","scripts":{"test":"rstest --project unit"}}'
    );
    for (const file of loadedFiles) {
      write(root, file, 'export default {}; export const unusedNeighbor = 1;');
    }
    write(
      root,
      policyTest,
      "runOxlint(nodePath.join(pluginDirectory, 'repository-policy.config.ts'), []);"
    );
    write(
      root,
      helperTest,
      "void { name: 'shared-helpers-probe', specifier: path.join(testsDirectory, 'shared-helpers-probe.ts') };"
    );
    write(root, 'tsconfig.json', '{"include":["src"]}');
    const typeTest = 'src/contract.type-test.ts';
    write(root, typeTest, 'export const unusedTypeTestNeighbor = 1;');
    const consumerPath = path.join(root, auditConsumersFile);
    const base = {
      workspaces: {
        '.': {
          entry: [policyTest, helperTest],
          node: false,
          project: [rstestConfigFile, 'src/*.ts', toolsPattern],
          rstest: { config: [] },
        },
      },
    };
    const model = yield* buildKnipModel(root, base, consumerPath).pipe(
      Effect.provide(NodeServices.layer)
    );
    const run = yield* runPinnedKnip(root, consumerPath, model).pipe(
      Effect.provide(NodeServices.layer)
    );
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(1);
    const report = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(ReportSchema)
    )(run.stdout);
    const files = report.issues.flatMap((issue) =>
      issue.files.map((finding) => finding.name)
    );
    const exports = report.issues.flatMap((issue) =>
      issue.exports.map((finding) => `${issue.file}#${finding.name}`)
    );
    for (const file of loadedFiles) {
      expect(files).not.toContain(file);
      expect(exports).toContain(`${file}#unusedNeighbor`);
      expect(exports).not.toContain(`${file}#default`);
    }
    expect(files).not.toContain(typeTest);
    expect(exports).toContain(`${typeTest}#unusedTypeTestNeighbor`);
    expect(files).toContain('src/dead.ts');
    const probeFile = `${lintDirectory}/tests/shared-helpers-probe.ts`;
    expect(model.evidence.filter((fact) => fact.source === helperTest)).toEqual(
      [
        expect.objectContaining({
          column: 6,
          kind: 'file',
          line: 1,
          source: helperTest,
          target: probeFile,
          workspace: '.',
        }),
        expect.objectContaining({
          column: 6,
          kind: 'export',
          line: 1,
          source: helperTest,
          target: `${probeFile}#default`,
          workspace: '.',
        }),
      ]
    );
    for (const specifier of [
      'undefined',
      "'shared-helpers-probe.ts'",
      "join(testsDirectory, 'shared-helpers-probe.ts')",
      "path.resolve(testsDirectory, 'shared-helpers-probe.ts')",
      "path.join('testsDirectory', 'shared-helpers-probe.ts')",
      "path.join(otherDirectory, 'shared-helpers-probe.ts')",
      "path.join(testsDirectory, 'other-probe.ts')",
    ]) {
      write(
        root,
        helperTest,
        `void { name: 'shared-helpers-probe', specifier: ${specifier} };`
      );
      const unrecognized = yield* buildKnipModel(root, base, consumerPath).pipe(
        Effect.provide(NodeServices.layer)
      );
      expect(
        unrecognized.evidence.some((fact) => fact.source === helperTest)
      ).toBe(false);
    }
    write(
      root,
      packageFile,
      '{"name":"consumer-controls","type":"module","scripts":{"test":"rstest --config other.ts"}}'
    );
    write(
      root,
      'tsconfig.json',
      '{"include":["src"],"exclude":["src/*.type-test.ts"]}'
    );
    write(
      root,
      policyTest,
      "runOxlint(nodePath.join(pluginDirectory, 'other.config.ts'), []);"
    );
    write(
      root,
      helperTest,
      "void { name: 'other-plugin', specifier: path.join(testsDirectory, 'shared-helpers-probe.ts') };"
    );
    const unrelated = yield* buildKnipModel(root, base, consumerPath).pipe(
      Effect.provide(NodeServices.layer)
    );
    expect(
      unrelated.evidence.some(
        (fact) => loadedFiles.includes(fact.target) || fact.target === typeTest
      )
    ).toBe(false);
  })
);

it.live(
  'Rstest environments follow only exported static projects and retain source provenance',
  Effect.fn(function* testProjectEnvironments() {
    const root = yield* fixture();
    const configFile = rstestConfigFile;
    write(
      root,
      configFile,
      [
        "const environment = 'happy-dom' as const;",
        'const browser = { testEnvironment: environment };',
        'const alias = browser;',
        'const cycle = cycle;',
        "const unrelated = { testEnvironment: 'unrelated-environment' };",
        "function shadow() { const environment = 'shadow-environment'; return environment; }",
        'const projects = [alias, { testEnvironment: `jsdom` }, browser,',
        "  { testEnvironment: 'node' }, { testEnvironment: choose() }, cycle,",
        "  { metadata: unrelated }, 'external.config.ts', ...dynamicProjects];",
        "export default { testEnvironment: 'node', projects, metadata: unrelated };",
      ].join('\n')
    );
    const model = yield* buildKnipModel(root, { entry: [configFile] }).pipe(
      Effect.provide(NodeServices.layer)
    );
    const environments = model.evidence.filter(
      (fact) => fact.reason === rstestEnvironmentReason
    );
    expect(environments.map((fact) => fact.target)).toEqual([
      'happy-dom',
      'jsdom',
      'happy-dom',
    ]);
    expect(environments[0]).toEqual(
      expect.objectContaining({
        kind: 'dependency',
        line: 2,
        source: configFile,
        workspace: '.',
      })
    );
    expect(environments[1]?.line).toBe(7);
    for (const projects of ['choose()', 'cycle']) {
      write(
        root,
        configFile,
        `const cycle = cycle; export default { testEnvironment: 'happy-dom', projects: ${projects} };`
      );
      const dynamic = yield* buildKnipModel(root, { entry: [configFile] }).pipe(
        Effect.provide(NodeServices.layer)
      );
      expect(
        dynamic.evidence
          .filter((fact) => fact.reason === rstestEnvironmentReason)
          .map((fact) => fact.target)
      ).toEqual(['happy-dom']);
    }
  })
);

it.live(
  'pinned Knip consumes project environment evidence without hiding an unused dependency',
  Effect.fn(function* testPinnedProjectEnvironment() {
    const root = yield* fixture();
    write(
      root,
      packageFile,
      yield* stringify({
        dependencies: { 'happy-dom': '20.8.3', jose: '6.2.5' },
        name: 'project-environment-controls',
        private: true,
        type: 'module',
      })
    );
    write(
      root,
      rstestConfigFile,
      "export default { projects: [{ testEnvironment: 'happy-dom' }] };"
    );
    const consumerPath = path.join(root, auditConsumersFile);
    const model = yield* buildKnipModel(
      root,
      {
        entry: [rstestConfigFile],
        node: false,
        project: [rstestConfigFile],
        rstest: { config: [] },
      },
      consumerPath
    ).pipe(Effect.provide(NodeServices.layer));
    expect(
      model.evidence.some(
        (fact) =>
          fact.reason === rstestEnvironmentReason && fact.target === 'happy-dom'
      )
    ).toBe(true);
    for (const [consumerSource, expectedUnused] of [
      [model.consumerSource, false],
      ['', true],
    ] as const) {
      const run = yield* runPinnedKnip(root, consumerPath, {
        ...model,
        consumerSource,
      }).pipe(Effect.provide(NodeServices.layer));
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(1);
      expect(run.stderr).toBe('');
      const report = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ReportSchema)
      )(run.stdout);
      const dependencies = report.issues.flatMap((issue) =>
        issue.dependencies.map((item) => item.name)
      );
      expect(dependencies.includes('happy-dom')).toBe(expectedUnused);
      expect(dependencies).toContain('jose');
    }
  })
);
