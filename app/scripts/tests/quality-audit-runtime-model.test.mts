import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { buildKnipModel } from '../../quality-audit/knip-model.mts';
import { buildKnipRuntimeEvidence } from '../../quality-audit/knip-runtime-model.mts';
import { runQualityAudit } from '../quality-audit.mts';
import { runPinnedKnip } from './quality-audit-test-support.mts';

const packageJson = 'package.json';
const nativeResolver = 'native-resolver';
const badVersion = '  "version": "wrong-';

const shellPackage = '@fixture/shell';
const shellRoot = 'apps/shell';
const layoutFile = `${shellRoot}/src/routes/layout.tsx`;
const vendorRoot = 'node_modules/@modern-js/ultramodern-create/templates/workspace-scripts';
const resetFile = 'scripts/reset.mjs';
const readinessConfig = 'scripts/readiness.config.mjs';
const launchedFile = 'scripts/launched.mts';
const cssUsed = '@fixture/css-used';
const emptyLayout = 'export default function Layout() { return null; }';
const compilerConfig = 'tsconfig.base.json';
const pluginName = '@effect/language-service';
const compilerOptionKind = 'compiler-option';
const tsgoName = '@effect/tsgo';
const tsgoReadme = 'node_modules/@effect/tsgo/README.md';
const tsgoPackage = 'node_modules/@effect/tsgo/package.json';
const compilerDocumentation =
  'A wrapper around [TypeScript-Go]\nAdding the `@effect/tsgo` dependency to your project.\nConfiguring your `tsconfig.json` to use the Effect Language Service plugin.\n"name": "@effect/language-service"';
const write = (root: string, file: string, source: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), source);
};
const stringify = (value: Schema.Json) =>
  Effect.gen(function* testEffect1() {
    return yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value);
  });
const facts = (root: string) =>
  Effect.gen(function* testEffect2() {
    return yield* buildKnipRuntimeEvidence(root).pipe(Effect.provide(NodeServices.layer));
  });
const fixture = () =>
  Effect.gen(function* testEffect3() {
    // The app workspace sits in app/ below the repository root, as in the real repository.
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(path.join(tmpdir(), 'ontos-knip-runtime-'))),
      (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
    ).pipe(Effect.map((directory) => path.join(realpathSync(directory), 'app')));
    write(
      root,
      packageJson,
      '{"name":"runtime-controls","private":true,"type":"module","devDependencies":{"@effect/tsgo":"0.19.0"},"scripts":{"typecheck":"ultramodern-create ultramodern typecheck --build tsconfig.json","performance:readiness":"ultramodern-create ultramodern performance-readiness"}}',
    );
    write(root, tsgoPackage, '{"name":"@effect/tsgo","version":"0.19.0"}');
    write(
      root,
      `${shellRoot}/package.json`,
      yield* stringify({
        dependencies: {
          '@fixture/css-comment': '1',
          '@fixture/css-dead': '1',
          [cssUsed]: '1',
        },
        name: shellPackage,
        scripts: { bootstrap: 'sh scripts/launch.sh' },
        type: 'module',
      }),
    );
    write(root, layoutFile, "import './index.css'; export default function Layout() { return null; }");
    write(
      root,
      `${shellRoot}/src/routes/index.css`,
      '@import "@fixture/css-used/tokens.css";\n/* @import "@fixture/css-comment"; */',
    );
    write(root, `${shellRoot}/src/routes/dead.css`, '@import "@fixture/css-dead";');
    write(
      root,
      `${shellRoot}/scripts/launch.sh`,
      `#!/bin/sh\nscript_directory="$(dirname -- "$0")"\ncd "\${script_directory}/.."\nnode scripts/launched.mts\n# node scripts/dead.mts\n`,
    );
    write(root, `${shellRoot}/scripts/launched.mts`, 'export const unusedLauncherExport = 1;');
    write(root, `${shellRoot}/scripts/dead.mts`, 'export const unusedFile = 1;');
    write(root, resetFile, 'export const unusedResetExport = 1;');
    write(
      root,
      'zerops.yaml',
      'zerops:\n  buildCommands:\n    - cd app && PATH="local/bin:$PATH" node scripts/reset.mjs\n',
    );
    write(
      root,
      `${vendorRoot}/ultramodern-typecheck.mjs`,
      "resolveEffectTsgoCompiler({ from: pathToFileURL(join(workspaceRoot, 'package.json')) });",
    );
    write(root, tsgoReadme, compilerDocumentation);
    write(root, compilerConfig, yield* stringify({ compilerOptions: { plugins: [{ name: pluginName }] } }));
    write(
      root,
      `${vendorRoot}/ultramodern-performance-readiness.mjs`,
      `const configPath = '${readinessConfig}'; const moduleUrl = pathToFileURL(path.join(root, configPath)).href; const module = await import(moduleUrl); normalizeConfig(module.default ?? {});`,
    );
    write(root, readinessConfig, 'export default {}; export const unusedConfigExport = 1;');
    return root;
  });

const hostProducer = '@modern-js/app-tools-extensions';
const nativeHostProducer = '@modern-js/plugin-tanstack';
const generatorPackage = '@modern-js/ultramodern-create';
const supportHost = 'rsbuild-plugin-dts';
const nativeHost = '@tanstack/router-core';
const unusedHost = 'ioredis-mock';
const compareBindings = (left: readonly string[], right: readonly string[]): number =>
  left.join('\0').localeCompare(right.join('\0'));
const producerFixture = Effect.fn(function* pinnedHostFixture() {
  const root = yield* fixture();
  write(root, layoutFile, emptyLayout);
  const appRoot = path.resolve(import.meta.dirname, '../..');
  const producer = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        name: Schema.String,
        ultramodern: Schema.Struct({
          nativeArtifacts: Schema.Json,
          sourceName: Schema.String,
          supportArtifacts: Schema.Json,
        }),
        version: Schema.String,
      }),
    ),
  )(readFileSync(path.join(appRoot, 'node_modules', generatorPackage, packageJson), 'utf-8'));
  const entries = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        packages: Schema.Array(
          Schema.Struct({ sourceName: Schema.String, targetName: Schema.String, version: Schema.String }),
        ),
      }),
    ),
  )(readFileSync(path.join(appRoot, 'node_modules', generatorPackage, 'release-cohort.json'), 'utf-8')).packages.filter(
    ({ sourceName }) => [generatorPackage, hostProducer, nativeHostProducer].includes(sourceName),
  );
  const pins = Schema.Struct({
    packages: Schema.Record(Schema.String, Schema.Struct({ request: Schema.String, version: Schema.String })),
  });
  const support = Schema.decodeUnknownSync(pins)(producer.ultramodern.supportArtifacts).packages;
  const native = Schema.decodeUnknownSync(pins)(producer.ultramodern.nativeArtifacts).packages;
  const requiredSupport = support[supportHost];
  const requiredNative = native[nativeHost];
  const unusedSupport = support[unusedHost];
  expect(requiredSupport).toBeDefined();
  expect(requiredNative).toBeDefined();
  expect(unusedSupport).toBeDefined();
  if (requiredSupport === undefined || requiredNative === undefined || unusedSupport === undefined) {
    throw new Error('The pinned producer fixture must contain its real host authorities');
  }
  const aliases = Object.fromEntries(
    entries.map(({ sourceName, targetName, version }) => [sourceName, `npm:${targetName}@${version}`]),
  );
  const metadata = {
    nativeArtifacts: producer.ultramodern.nativeArtifacts,
    supportArtifacts: producer.ultramodern.supportArtifacts,
  };
  for (const directory of ['', shellRoot]) {
    write(
      root,
      path.join(directory, packageJson),
      JSON.stringify(
        {
          devDependencies: {
            [generatorPackage]: aliases[generatorPackage],
            [nativeHost]: requiredNative.request,
            [supportHost]: requiredSupport.request,
            [unusedHost]: unusedSupport.request,
          },
          name: directory === '' ? 'host-controls' : shellPackage,
          private: true,
          type: 'module',
          ultramodern: metadata,
          workspaces: directory === '' ? ['apps/*'] : undefined,
        },
        null,
        2,
      ),
    );
    write(root, path.join(directory, 'src/index.ts'), 'export {};');
  }
  for (const entry of entries) {
    const supportPeers = entry.sourceName === hostProducer ? { [supportHost]: requiredSupport.version } : {};
    const nativePeers = entry.sourceName === nativeHostProducer ? { [nativeHost]: requiredNative.version } : {};
    write(
      root,
      `node_modules/${entry.sourceName}/package.json`,
      JSON.stringify(
        {
          dependencies:
            entry.sourceName === generatorPackage
              ? {
                  [hostProducer]: aliases[hostProducer],
                  [nativeHostProducer]: aliases[nativeHostProducer],
                }
              : {},
          name: entry.targetName,
          peerDependencies: { ...nativePeers, ...supportPeers },
          ultramodern: { ...metadata, sourceName: entry.sourceName },
          version: entry.version,
        },
        null,
        2,
      ),
    );
  }
  write(
    root,
    `node_modules/${generatorPackage}/release-cohort.json`,
    JSON.stringify({
      packages: entries,
      release: { version: producer.version },
    }),
  );
  for (const [name, pin] of [
    [supportHost, requiredSupport],
    [nativeHost, requiredNative],
    [unusedHost, unusedSupport],
  ] as const) {
    write(root, `node_modules/${name}/package.json`, JSON.stringify({ name, version: pin.version }, null, 2));
  }
  return { requiredNative, requiredSupport, root };
});

it.live(
  'pinned producer peer edges prove only exact owner-local support and native hosts',
  Effect.fn(function* exactProducerHosts() {
    const { root } = yield* producerFixture();
    const evidence = (yield* facts(root)).filter(({ kind }) => kind === nativeResolver);
    expect(evidence.map(({ target, workspace }) => [workspace, target]).toSorted(compareBindings)).toEqual(
      [
        ['.', nativeHost],
        ['.', supportHost],
        [shellRoot, nativeHost],
        [shellRoot, supportHost],
      ].toSorted(compareBindings),
    );
    for (const fact of evidence) {
      expect(fact).toMatchObject({
        anchor: path.join(root, fact.workspace, packageJson),
        declarationSource: fact.workspace === '.' ? packageJson : `${shellRoot}/package.json`,
        dependencyCategory: 'devDependencies',
        owningManifest: path.join(root, fact.workspace, packageJson),
        resolved: path.join(root, 'node_modules', fact.target, packageJson),
        specifier: `${fact.target}/package.json`,
      });
      expect(fact.producerResolved).toBe(fact.resolved);
      expect(fact.declarationLine).toBeGreaterThan(0);
      expect(fact.declarationColumn).toBe(6);
    }
  }),
);

it.live(
  'producer host proof resolves catalog aliases without accepting a neighboring release identity',
  Effect.fn(function* exactHostCatalog() {
    const { root } = yield* producerFixture();
    const file = packageJson;
    const original = readFileSync(path.join(root, file), 'utf-8');
    const alias = /npm:@bleedingdev\/[^"]+/u.exec(original)?.[0];
    expect(alias).toBeDefined();
    if (alias === undefined) {
      throw new Error('The fixture generator must pin its authenticated release alias');
    }
    write(root, file, original.replace(alias, 'catalog:ultramodern'));
    write(root, 'pnpm-workspace.yaml', `catalogs:\n  ultramodern:\n    '${generatorPackage}': '${alias}'\n`);
    expect((yield* facts(root)).filter((fact) => fact.kind === nativeResolver && fact.workspace === '.')).toHaveLength(
      2,
    );
    write(
      root,
      'pnpm-workspace.yaml',
      `catalogs:\n  ultramodern:\n    '${generatorPackage}': '${alias}-wrong-release'\n`,
    );
    expect((yield* facts(root)).filter(({ kind }) => kind === nativeResolver)).toEqual([]);
  }),
);

it.live(
  'producer hosts bind dependency categories independently when a package is declared in both groups',
  Effect.fn(function* exactHostCategories() {
    const { requiredSupport, root } = yield* producerFixture();
    const file = packageJson;
    const original = readFileSync(path.join(root, file), 'utf-8');
    write(
      root,
      file,
      original.replace(
        '"devDependencies": {',
        `"dependencies": { "${supportHost}": "${requiredSupport.request}" }, "devDependencies": {`,
      ),
    );
    const declared = (yield* facts(root)).filter(
      (fact) => fact.kind === nativeResolver && fact.workspace === '.' && fact.target === supportHost,
    );
    expect(declared.map(({ dependencyCategory }) => dependencyCategory)).toEqual(['dependencies', 'devDependencies']);
    expect(new Set(declared.map(({ declarationLine }) => declarationLine)).size).toBe(2);
    write(
      root,
      file,
      original.replace(
        '"devDependencies": {',
        `"dependencies": { "${supportHost}": "wrong-request" }, "devDependencies": {`,
      ),
    );
    expect(
      (yield* facts(root))
        .filter((fact) => fact.kind === nativeResolver && fact.workspace === '.' && fact.target === supportHost)
        .map(({ dependencyCategory }) => dependencyCategory),
    ).toEqual(['devDependencies']);
  }),
);

it.live(
  'producer host proof rejects nearby pin, identity, descriptor, edge and installed-host mismatches',
  Effect.fn(function* invalidProducerHosts() {
    const { requiredSupport, root } = yield* producerFixture();
    const rootFile = packageJson;
    const producerFile = `node_modules/${hostProducer}/package.json`;
    const hostFile = `node_modules/${supportHost}/package.json`;
    const generatorFile = `node_modules/${generatorPackage}/package.json`;
    const controls = [
      [rootFile, (text: string) => text.replace(requiredSupport.request, `${requiredSupport.request}?untrusted`)],
      [rootFile, (text: string) => text.replace('"supportArtifacts":', '"unrelatedArtifacts":')],
      [rootFile, (text: string) => text.replace('"supportArtifacts": {', '"supportArtifacts": {"unexpected": true,')],
      [rootFile, (text: string) => text.replace(/npm:@bleedingdev\/[^"]+/u, 'npm:@bleedingdev/wrong@0.0.0')],
      [generatorFile, (text: string) => text.replace(/^ {2}"version": "/mu, badVersion)],
      [producerFile, (text: string) => text.replace(`"sourceName": "${hostProducer}"`, '"sourceName": "wrong"')],
      [producerFile, (text: string) => text.replace('"name": "', '"name": "wrong-')],
      [producerFile, (text: string) => text.replace(/^ {2}"version": "/mu, badVersion)],
      [
        producerFile,
        (text: string) => text.replace(`"${supportHost}": "${requiredSupport.version}"`, `"${supportHost}": "0.0.0"`),
      ],
      [producerFile, (text: string) => text.replace('"peerDependencies":', '"unusedPeerDependencies":')],
      [generatorFile, (text: string) => text.replace(`"${hostProducer}":`, '"@fixture/unrelated-owner":')],
      [hostFile, (text: string) => text.replace(/^ {2}"version": "/mu, badVersion)],
      [hostFile, (text: string) => text.replace(`"name": "${supportHost}"`, '"name": "wrong"')],
    ] as const;
    for (const [file, mutate] of controls) {
      const original = readFileSync(path.join(root, file), 'utf-8');
      const modified = mutate(original);
      expect(modified, file).not.toBe(original);
      write(root, file, modified);
      const evidence = yield* facts(root);
      expect(
        evidence.filter(
          (fact) => fact.kind === nativeResolver && fact.workspace === '.' && fact.target === supportHost,
        ),
        file,
      ).toEqual([]);
      write(root, file, original);
    }
    // A peer resolving a different installation cannot prove the declared owner's host.
    write(
      root,
      `node_modules/${hostProducer}/node_modules/${supportHost}/package.json`,
      readFileSync(path.join(root, hostFile), 'utf-8'),
    );
    expect((yield* facts(root)).filter((fact) => fact.kind === nativeResolver && fact.target === supportHost)).toEqual(
      [],
    );
  }),
);

it.live(
  'tiny native Knip run calibrates exact producer hosts and retains unused neighboring declarations',
  Effect.fn(function* producerHostCalibration() {
    const { root } = yield* producerFixture();
    const appRoot = path.resolve(import.meta.dirname, '../..');
    for (const name of ['knip', 'effect']) {
      symlinkSync(path.join(appRoot, 'node_modules', name), path.join(root, 'node_modules', name), 'dir');
    }
    const config = {
      workspaces: Object.fromEntries(
        ['.', 'apps/*'].map((owner) => [
          owner,
          {
            entry: ['src/index.ts'],
            lefthook: false,
            node: false,
            project: ['src/**/*.ts'],
          },
        ]),
      ),
    };
    write(root, 'quality-audit/knip.json', JSON.stringify(config));
    write(
      root,
      'quality-audit/scope.json',
      JSON.stringify({
        exclude: ['**/node_modules/**'],
        patterns: ['src/**/*.ts', 'apps/**/*.ts'],
      }),
    );
    write(
      root,
      'quality-audit/knip-reporter.mts',
      readFileSync(path.join(appRoot, 'quality-audit/knip-reporter.mts'), 'utf-8'),
    );
    const output = path.join(root, '.reports');
    yield* runQualityAudit(root, output, 'knip').pipe(Effect.provide(NodeServices.layer));
    const summary = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          results: Schema.Array(
            Schema.Struct({
              coverage: Schema.Struct({
                findingCounts: Schema.Record(Schema.String, Schema.Number),
                modeledFindingCounts: Schema.Record(Schema.String, Schema.Number),
                nativeFindingCounts: Schema.Record(Schema.String, Schema.Number),
              }),
              directory: Schema.String,
              name: Schema.String,
            }),
          ),
        }),
      ),
    )(readFileSync(path.join(output, 'summary.json'), 'utf-8'));
    const knip = summary.results.find(({ name }) => name === 'knip');
    expect(knip?.coverage.modeledFindingCounts).toEqual({ devDependencies: 4 });
    expect(knip?.coverage.nativeFindingCounts['devDependencies']).toBe(8);
    expect(knip?.coverage.findingCounts['devDependencies']).toBe(4);
    expect(knip).toBeDefined();
    if (knip === undefined) {
      throw new Error('The native fixture audit must report Knip coverage');
    }
    const usages = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Array(
          Schema.Struct({
            file: Schema.String,
            issue: Schema.Struct({ name: Schema.String }),
          }),
        ),
      ),
    )(readFileSync(path.join(knip.directory, 'modeled-usages.json'), 'utf-8'));
    expect(usages.map(({ file, issue }) => [file, issue.name]).toSorted(compareBindings)).toEqual(
      [
        [packageJson, supportHost],
        [packageJson, nativeHost],
        [`${shellRoot}/package.json`, supportHost],
        [`${shellRoot}/package.json`, nativeHost],
      ].toSorted(compareBindings),
    );
    const model = yield* buildKnipModel(root, config).pipe(Effect.provide(NodeServices.layer));
    for (const workspace of ['.', shellRoot]) {
      expect(model.config.workspaces[workspace]?.ignoreDependencies ?? []).toEqual([]);
      expect(
        model.evidence.some(
          (fact) => fact.kind === nativeResolver && fact.workspace === workspace && fact.target === unusedHost,
        ),
      ).toBe(false);
    }
  }),
);

it.live(
  'literal Rstest config commands consume only their contained file and default export',
  Effect.fn(function* literalRstestConfigPositive() {
    const root = yield* fixture();
    const configFile = 'tests/support/reconciliation.rstest.config.ts';
    write(root, `${shellRoot}/${configFile}`, 'export default {}; export const unusedNeighbor = 1;');
    for (const command of [
      `rstest run --config ${configFile} --project integration`,
      `rstest --config="${configFile}"`,
      `rstest --config '${configFile}'`,
    ]) {
      write(
        root,
        `${shellRoot}/package.json`,
        yield* stringify({
          name: shellPackage,
          scripts: { 'test:integration:reconciliation': command },
        }),
      );
      const evidence = (yield* facts(root)).filter((fact) => fact.target.includes(configFile));
      expect(evidence.map((fact) => [fact.kind, fact.target])).toEqual([
        ['file', configFile],
        ['export', `${shellRoot}/${configFile}#default`],
      ]);
      expect(
        evidence.every((fact) => fact.source === `${shellRoot}/package.json` && fact.workspace === shellRoot),
      ).toBe(true);
    }
  }),
);

it.live(
  'literal Rstest config commands reject dynamic missing escaping and unrelated controls',
  Effect.fn(function* literalRstestConfigInvalid() {
    const root = yield* fixture();
    const configFile = 'tests/support/reconciliation.rstest.config.ts';
    write(root, `${shellRoot}/${configFile}`, 'export default {};');
    write(root, 'outside.config.ts', 'export default {};');
    const commands = [
      `echo rstest --config ${configFile}`,
      `rstest --config ${configFile} && other-command`,
      `rstest --config ${configFile}; other-command`,
      'rstest --config "$CONFIG"',
      'rstest --config $(choose-config)',
      'rstest --config tests/*.config.ts',
      'rstest --config tests/missing.config.ts',
      'rstest --config ../../outside.config.ts',
      'rstest --config /tmp/outside.config.ts',
      'rstest --config tests/../outside.config.ts',
      `rstest --config ${configFile} --config other.config.ts`,
      `other-runner --config ${configFile}`,
    ];
    for (const command of commands) {
      write(
        root,
        `${shellRoot}/package.json`,
        yield* stringify({
          name: shellPackage,
          scripts: { test: command },
        }),
      );
      const evidence = yield* facts(root);
      expect(
        evidence.filter((fact) => fact.reason.includes('literal workspace configuration')),
        command,
      ).toEqual([]);
    }
    const linkedConfig = 'tests/support/linked.config.ts';
    symlinkSync(path.join(root, 'outside.config.ts'), path.join(root, shellRoot, linkedConfig));
    write(
      root,
      `${shellRoot}/package.json`,
      yield* stringify({
        name: shellPackage,
        scripts: { test: `rstest --config ${linkedConfig}` },
      }),
    );
    expect((yield* facts(root)).filter((fact) => fact.reason.includes('literal workspace configuration'))).toEqual([]);
  }),
);

it.live(
  'runtime consumers require the exact CSS, shell, deployment and compiler contracts',
  Effect.fn(function* testEffect4() {
    const root = yield* fixture();
    const initial = yield* facts(root);
    for (const target of [cssUsed, launchedFile, resetFile, tsgoName, pluginName, readinessConfig]) {
      expect(
        initial.some((fact) => fact.target === target),
        target,
      ).toBe(true);
    }
    for (const target of ['@fixture/css-dead', '@fixture/css-comment', 'scripts/dead.mts']) {
      expect(!initial.some((fact) => fact.target === target), target).toBe(true);
    }
    expect(initial.find((fact) => fact.target === pluginName)?.kind).toBe(compilerOptionKind);
    expect(initial.some((fact) => fact.target === `${readinessConfig}#default` && fact.kind === 'export')).toBe(true);
    write(root, layoutFile, emptyLayout);
    write(root, `${shellRoot}/package.json`, '{"name":"@fixture/shell"}');
    write(root, 'zerops.yaml', '# - cd app && node scripts/reset.mjs');
    write(
      root,
      compilerConfig,
      yield* stringify({
        compilerOptions: {
          plugins: [{ name: pluginName }],
          types: [pluginName],
        },
      }),
    );
    write(
      root,
      `${vendorRoot}/ultramodern-performance-readiness.mjs`,
      `const configPath = '${readinessConfig}'; void configPath;`,
    );
    const changed = yield* facts(root);
    for (const target of [cssUsed, launchedFile, resetFile, pluginName, readinessConfig]) {
      expect(!changed.some((fact) => fact.target === target), target).toBe(true);
    }
  }),
);

it.live(
  'compiler-option proof requires the installed pinned compiler and built-in plugin documentation',
  Effect.fn(function* testEffect5() {
    const root = yield* fixture();
    write(root, tsgoReadme, '"name": "@effect/language-service"');
    const nameOnly = yield* facts(root);
    expect(!nameOnly.some((fact) => fact.kind === compilerOptionKind)).toBe(true);
    write(root, tsgoReadme, compilerDocumentation);
    write(root, tsgoPackage, '{"name":"@effect/tsgo","version":"0.20.0"}');
    const wrongVersion = yield* facts(root);
    expect(!wrongVersion.some((fact) => fact.kind === compilerOptionKind)).toBe(true);
    write(root, tsgoPackage, '{"name":"@effect/tsgo","version":"0.19.0"}');
    write(
      root,
      compilerConfig,
      yield* stringify({
        compilerOptions: {
          plugins: [{ name: pluginName }],
          types: [`${pluginName}/types`],
        },
      }),
    );
    const typeImport = yield* facts(root);
    expect(!typeImport.some((fact) => fact.kind === compilerOptionKind)).toBe(true);
  }),
);

it.live(
  'compiler configuration accepts JSONC but rejects malformed and schema-invalid input',
  Effect.fn(function* testEffect6() {
    const root = yield* fixture();
    write(
      root,
      compilerConfig,
      `{
    // TypeScript permits comments and trailing commas.
    "compilerOptions": { "plugins": [{ "name": "${pluginName}", }], },
    }`,
    );
    const modeled = yield* facts(root);
    expect(modeled.some((fact) => fact.kind === compilerOptionKind)).toBe(true);
    write(root, compilerConfig, '{ "compilerOptions": {');
    yield* facts(root).pipe(
      Effect.flip,
      Effect.map((error) => expect(String(error)).toMatch(/InvalidTsconfig/u)),
    );
    write(root, compilerConfig, '{ "compilerOptions": { "plugins": false } }');
    yield* facts(root).pipe(
      Effect.flip,
      Effect.map((error) => expect(String(error)).toMatch(/plugins/u)),
    );
  }),
);

it.live(
  'DTS compiler resolution belongs to the invoking workspace and excludes commented lookalikes',
  Effect.fn(function* testEffect7() {
    const root = yield* fixture();
    const configFile = `${shellRoot}/module-federation.config.ts`;
    const source =
      "import { resolveEffectTsrsCompiler } from '@modern-js/app-tools-extensions/config';\nconst compiler = resolveEffectTsrsCompiler({\n from: import.meta.url,\n });\nvoid compiler;";
    write(root, configFile, source);
    write(root, `${shellRoot}/${tsgoReadme}`, 'tries `typescript`, then `@typescript/native`');
    const initial = yield* facts(root);
    expect(initial.some((fact) => fact.target === tsgoName && fact.workspace === shellRoot)).toBe(true);
    expect(initial.some((fact) => fact.target === '@typescript/native' && fact.workspace === shellRoot)).toBe(false);
    write(root, configFile, source.replace('import.meta.url,', 'import.meta.url'));
    expect((yield* facts(root)).some((fact) => fact.target === tsgoName && fact.source === configFile)).toBe(true);
    write(root, configFile, `/* ${source} */\nexport default {};`);
    const commented = yield* facts(root);
    expect(!commented.some((fact) => fact.source === configFile)).toBe(true);
  }),
);

it.live(
  'Zephyr host evidence requires a native preset call with real owner options, not textual lookalikes',
  Effect.fn(function* workspacePresetOwnerControls() {
    const root = yield* fixture();
    const zephyr = 'zephyr-rspack-plugin';
    const configFile = `${shellRoot}/modern.config.ts`;
    const nativeImport = "import { presetUltramodernWorkspace } from '@modern-js/ultramodern-app-tools';";
    const call = 'presetUltramodernWorkspace({}, { appId, from: import.meta.url })';
    write(root, `${shellRoot}/package.json`, yield* stringify({ devDependencies: { [zephyr]: '1' } }));
    write(
      root,
      `${shellRoot}/node_modules/@modern-js/ultramodern-app-tools/dist/esm-node/native-composition/workspace-preset.mjs`,
      `const require = createRequire(from); require('${zephyr}');`,
    );
    write(root, configFile, `${nativeImport}\nconst appId = 'shell'; export default ${call};`);
    expect((yield* facts(root)).some((fact) => fact.target === zephyr)).toBe(true);
    for (const lookalike of [
      `const dead = '${call}';`,
      `/* ${call} */`,
      'presetUltramodernWorkspace({}, { appId, from: other })',
      'presetUltramodernWorkspace({}, { from: import.meta.url })',
      'presetUltramodernWorkspace(configuration, { appId, from: import.meta.url })',
    ]) {
      write(root, configFile, `${nativeImport}\n${lookalike};`);
      expect(
        (yield* facts(root)).some((fact) => fact.target === zephyr),
        lookalike,
      ).toBe(false);
    }
  }),
);

it.live(
  'Lefthook configuration proves only intended tool usage and ignores commented hook text',
  Effect.fn(function* testEffect8() {
    const root = yield* fixture();
    const source =
      'pre-commit:\n  jobs:\n    - name: format\n      root: "app/"\n      run: pnpm exec oxfmt {staged_files}\n';
    write(root, 'lefthook.yml', source);
    const insideApp = yield* facts(root);
    expect(!insideApp.some((fact) => fact.target === 'lefthook')).toBe(true);
    write(root, '../lefthook.yml', source);
    const configured = yield* facts(root);
    const tool = configured.find((fact) => fact.target === 'lefthook');
    expect(tool?.kind).toBe('dependency');
    expect(tool?.reason ?? '').toMatch(/does not establish hook activation/u);
    write(
      root,
      '../lefthook.yml',
      source
        .split('\n')
        .map((line) => `# ${line}`)
        .join('\n'),
    );
    const commented = yield* facts(root);
    expect(!commented.some((fact) => fact.target === 'lefthook')).toBe(true);
  }),
);

it.live(
  'real Knip keeps unused neighboring files, dependency names and exports after runtime modeling',
  Effect.fn(function* testEffect9() {
    const root = yield* fixture();
    const consumerPath = path.join(root, '.audit/consumers.mts');
    const model = yield* buildKnipModel(
      root,
      {
        workspaces: {
          '.': { entry: [], node: false, project: ['scripts/**/*.mjs'] },
          'apps/*': {
            entry: ['src/routes/layout.tsx'],
            node: false,
            project: ['scripts/**/*.mts', 'src/**/*.tsx'],
          },
        },
      },
      consumerPath,
    ).pipe(Effect.provide(NodeServices.layer));
    const run = yield* runPinnedKnip(root, consumerPath, model).pipe(Effect.provide(NodeServices.layer));
    expect(run.error).toBe(undefined);
    expect(run.status === 0 || run.status === 1, run.stderr).toBe(true);
    const report = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({
          issues: Schema.Array(
            Schema.Struct({
              dependencies: Schema.Array(Schema.Struct({ name: Schema.String })),
              exports: Schema.Array(Schema.Struct({ name: Schema.String })),
              file: Schema.String,
              files: Schema.Array(Schema.Struct({ name: Schema.String })),
            }),
          ),
        }),
      ),
    )(run.stdout);
    const unusedFiles = report.issues.flatMap((issue) => issue.files.map((item) => item.name));
    expect(unusedFiles.some((file) => file.endsWith('/scripts/dead.mts'))).toBe(true);
    expect(
      !unusedFiles.some(
        (file) => file.endsWith('/scripts/launched.mts') || file === resetFile || file === readinessConfig,
      ),
    ).toBe(true);
    const dependencies = new Set(report.issues.flatMap((issue) => issue.dependencies.map((item) => item.name)));
    expect(dependencies.has('@fixture/css-dead')).toBe(true);
    expect(dependencies.has('@fixture/css-comment')).toBe(true);
    expect(!dependencies.has(cssUsed)).toBe(true);
    const exports = new Set(report.issues.flatMap((issue) => issue.exports.map((item) => item.name)));
    expect(
      !report.issues.some(
        (issue) => issue.file === readinessConfig && issue.exports.some((item) => item.name === 'default'),
      ),
    ).toBe(true);
    for (const name of ['unusedLauncherExport', 'unusedResetExport', 'unusedConfigExport']) {
      expect(exports.has(name), name).toBe(true);
    }
  }),
);

it.live(
  'direct framework commands retain compiler and readiness evidence only while invoked',
  Effect.fn(function* directFrameworkCommands() {
    const root = yield* fixture();
    const packageFile = packageJson;
    const original = readFileSync(path.join(root, packageFile), 'utf-8');
    try {
      const modeled = yield* facts(root);
      for (const target of [tsgoName, pluginName, readinessConfig, `${readinessConfig}#default`]) {
        expect(
          modeled.some((fact) => fact.target === target),
          target,
        ).toBeTruthy();
      }
      write(root, packageFile, original.replace('ultramodern-create ultramodern typecheck', 'unrelated typecheck'));
      const disconnectedTypecheck = yield* facts(root);
      expect(disconnectedTypecheck.some((fact) => fact.target === tsgoName)).toBe(false);
      write(
        root,
        packageFile,
        original.replace('ultramodern-create ultramodern performance-readiness', 'unrelated performance-readiness'),
      );
      const disconnectedReadiness = yield* facts(root);
      expect(disconnectedReadiness.some((fact) => fact.target === readinessConfig)).toBe(false);
      write(
        root,
        packageFile,
        original
          .replace('ultramodern-create ultramodern typecheck', 'unrelated typecheck')
          .replace(
            '"ultramodern-create ultramodern performance-readiness"',
            '"echo ultramodern-create ultramodern performance-readiness"',
          )
          .replace('"scripts":{', '"description":"ultramodern-create ultramodern typecheck","scripts":{'),
      );
      const describedOnly = yield* facts(root);
      expect(describedOnly.some((fact) => fact.target === tsgoName)).toBe(false);
      expect(describedOnly.some((fact) => fact.target === readinessConfig)).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }),
);
