import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'effect-rstest';

import { appRoot, pluginDirectory, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const ruleName = 'no-effect-run-in-tests';
const runner = '@rstest/core';
const packageFile = 'package.json';
const configFile = 'rstest.config.ts';
const setupFile = 'tests/integration/authority.ts';
const nativeImport = `import { defineConfig } from '${runner}';`;
const effectImport = "import { Effect, Layer } from 'effect';";
const build = 'Effect.scoped(Layer.build(Layer.empty))';
const run = `Effect.runPromise(${build})`;
const awaitedRun = `await ${run};`;
const source = `${effectImport}\n${awaitedRun}`;
interface RstestOwnerFixture {
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly scripts: Readonly<Record<string, string>>;
}
const manifest = {
  devDependencies: { [runner]: '0.11.12' },
  scripts: { 'test:integration': 'rstest --project integration' },
};
const projectNameField = "name: 'integration'";
const project = (entries: string) => `{ ${projectNameField}, setupFiles: ${entries} }`;
const configuration = (entries: string) =>
  `${nativeImport} export default defineConfig({ projects: [${project(entries)}] });`;
const nativeSetupEntries = JSON.stringify([`./${setupFile}`]);
const nativeConfig = configuration(nativeSetupEntries);
const write = (root: string, file: string, text: string): void => {
  const filename = path.join(root, file);
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, text);
};

it('admits only registered native Rstest setup roots and retains owner, config and runtime-shape diagnostics', () => {
  withTemporaryWorkspace((directory) => {
    const valid: string[] = [];
    const invalid: string[] = [];
    const add = (
      name: string,
      code = source,
      config = nativeConfig,
      owner: RstestOwnerFixture = manifest,
      accepted = false,
    ): string => {
      const workspace = `verticals/${name}`;
      const filename = `${workspace}/${setupFile}`;
      write(directory, `${workspace}/${packageFile}`, JSON.stringify(owner));
      write(directory, `${workspace}/${configFile}`, config);
      write(directory, filename, code);
      (accepted ? valid : invalid).push(filename);
      return filename;
    };
    add('native', source, nativeConfig, manifest, true);
    add(
      'renamed-imports',
      "import { Effect as E, Layer as L } from 'effect'; await E.runPromise(E.scoped(L.build(L.empty)));",
      `import { defineConfig as nativeConfig } from '${runner}'; export default nativeConfig({ projects: [${project(nativeSetupEntries)}] });`,
      manifest,
      true,
    );
    const party = 'verticals/party-registry';
    const actualSetup = 'tests/integration/application-composition.setup.ts';
    for (const file of [packageFile, configFile, actualSetup]) {
      write(directory, `${party}/${file}`, readFileSync(path.join(appRoot, party, file), 'utf-8'));
    }
    valid.push(`${party}/${actualSetup}`);
    for (const [name, code] of Object.entries({
      aliased: `${effectImport} const launch = Effect.runPromise; await launch(${build});`,
      assigned: `${effectImport} const result = await ${run};`,
      callback: `${effectImport} async function start() { ${awaitedRun} }`,
      computed: `${effectImport} await Effect['runPromise'](${build});`,
      computedScoped: `${effectImport} await Effect.runPromise(Effect['scoped'](Layer.build(Layer.empty)));`,
      conditional: `${effectImport} if (enabled) { ${awaitedRun} }`,
      counterfeitLayer: `import { Effect } from 'effect'; const Layer = { build: (value) => value, empty: Effect.void }; ${awaitedRun}`,
      destructuredMutation: `${effectImport} ({ build: Layer.build } = replacement); ${awaitedRun}`,
      erasedLayer: `import { Effect } from 'effect'; import type { Layer } from 'effect'; ${awaitedRun}`,
      escapedEffect: `${effectImport} const E = Effect; E.scoped = counterfeit; ${awaitedRun}`,
      escapedLayer: `${effectImport} mutate(Layer); ${awaitedRun}`,
      exit: `${effectImport} await Effect.runPromiseExit(${build});`,
      forInMutation: `${effectImport} for (Layer.build in replacement) {} ${awaitedRun}`,
      fork: `${effectImport} await Effect.runFork(${build});`,
      forOfMutation: `${effectImport} for (Effect.scoped of [counterfeit]) {} ${awaitedRun}`,
      loop: `${effectImport} for (const item of items) { ${awaitedRun} }`,
      multiple: `${effectImport} ${awaitedRun} ${awaitedRun}`,
      mutableEffect: `${effectImport} Effect.scoped = counterfeit; ${awaitedRun}`,
      mutableLayer: `${effectImport} Layer.build = counterfeit; ${awaitedRun}`,
      nested: `${effectImport} await Effect.runPromise(Effect.scoped(Layer.build(Layer.effectDiscard(Effect.promise(() => ${run})))));`,
      nestedMutation: `${effectImport} ([{ scoped: Effect.scoped = counterfeit }] = replacement); ${awaitedRun}`,
      nonLayer: `${effectImport} await Effect.runPromise(Effect.scoped(Effect.void));`,
      optional: `${effectImport} await Effect.runPromise?.(${build});`,
      optionalBuild: `${effectImport} await Effect.runPromise(Effect.scoped(Layer.build?.(Layer.empty)));`,
      sync: `${effectImport} await Effect.runSync(${build});`,
      unawaited: `${effectImport} ${run};`,
      unscoped: `${effectImport} await Effect.runPromise(Layer.build(Layer.empty));`,
    })) {
      add(name, code);
    }
    for (const [name, config] of Object.entries({
      aliasedEntries: `${nativeImport} const files = ['${setupFile}']; export default defineConfig({ projects: [${project('files')}] });`,
      aliasedFactory: `${nativeImport} const alias = defineConfig; export default alias({ projects: [${project(nativeSetupEntries)}] });`,
      aliasProject: nativeConfig.replace(
        projectNameField,
        "resolve: { alias: { effect: './counterfeit.ts' } }, name: 'integration'",
      ),
      aliasRoot: nativeConfig.replace('projects:', "resolve: { alias: { effect: './counterfeit.ts' } }, projects:"),
      computedRegistration: nativeConfig.replace('setupFiles:', "['setupFiles']:"),
      counterfeit: `const defineConfig = (value) => value; export default defineConfig({ projects: [${project(nativeSetupEntries)}] });`,
      duplicatedRegistration: nativeConfig.replace('setupFiles:', 'setupFiles: [], setupFiles:'),
      escapedFactory: `${nativeImport} mutate(defineConfig); export default defineConfig({ projects: [${project(nativeSetupEntries)}] });`,
      extendedProject: nativeConfig.replace(projectNameField, "extends: unknown, name: 'integration'"),
      foreignImport: nativeConfig.replace(runner, './counterfeit.ts'),
      foreignProject: nativeConfig.replace(projectNameField, "name: 'other'"),
      mutatedFactory: `${nativeImport} defineConfig = counterfeit; export default defineConfig({ projects: [${project(nativeSetupEntries)}] });`,
      pluginProject: nativeConfig.replace(projectNameField, "plugins: [unknown], name: 'integration'"),
      projectSpread: nativeConfig.replace(projectNameField, "...unknown, name: 'integration'"),
      redirectedProject: nativeConfig.replace(projectNameField, "root: '../other', name: 'integration'"),
      redirectedRoot: nativeConfig.replace('projects:', "root: '../other', projects:"),
      rootSpread: nativeConfig.replace('projects:', '...unknown, projects:'),
      toolsProject: nativeConfig.replace(projectNameField, "tools: unknown, name: 'integration'"),
      typeImport: nativeConfig.replace('import {', 'import type {'),
      unregistered: configuration("['./tests/integration/other.ts']"),
    })) {
      add(name, source, config);
    }
    add('undeclared-runner', source, nativeConfig, { ...manifest, devDependencies: {} });
    add('foreign-command', source, nativeConfig, { ...manifest, scripts: { 'test:integration': 'node tests/run.ts' } });
    add('foreign-config', source, nativeConfig, {
      ...manifest,
      scripts: { 'test:integration': 'rstest --project integration --config elsewhere.ts' },
    });
    add('redirected-command', source, nativeConfig, {
      ...manifest,
      scripts: { 'test:integration': 'rstest --root elsewhere --project integration' },
    });
    add('newline-command', source, nativeConfig, {
      ...manifest,
      scripts: { 'test:integration': 'rstest\n--project integration' },
    });
    add('shadowed-config');
    write(directory, 'verticals/shadowed-config/rstest.config.mts', 'export default {};');
    const ordinary = 'verticals/native/tests/integration/ordinary.test.ts';
    write(directory, ordinary, source);
    invalid.push(ordinary);
    const foreign = add('physical-owner');
    const target = 'outside/tests/authority.ts';
    write(directory, target, source);
    const link = 'verticals/physical-owner/tests/integration/symlink.ts';
    symlinkSync(path.join(directory, target), path.join(directory, link));
    write(directory, 'verticals/physical-owner/rstest.config.ts', configuration("['./tests/integration/symlink.ts']"));
    invalid.push(link);
    expect(foreign).not.toBe(link);
    const config = path.join(directory, 'policy.json');
    writeFileSync(
      config,
      JSON.stringify({
        categories: { correctness: 'off' },
        jsPlugins: [{ name: 'effect-native', specifier: path.join(pluginDirectory, 'tests/fixture-plugin.ts') }],
        rules: { [`effect-native/${ruleName}`]: 'error' },
      }),
    );
    const result = runOxlint(config, [...valid, ...invalid], directory, ruleName);
    expect(result.exitCode).toBe(1);
    expect(result.numberOfFiles).toBe(valid.length + invalid.length);
    expect(result.diagnostics.every((diagnostic) => diagnostic.code === `effect-native(${ruleName})`)).toBe(true);
    const reported = new Set(result.diagnostics.map((diagnostic) => diagnostic.filename));
    for (const file of valid) {
      expect(reported.has(file), `native setup root must admit ${file}`).toBe(false);
    }
    for (const file of invalid) {
      expect(reported.has(file), `unproven setup root must reject ${file}`).toBe(true);
    }
  });
});
