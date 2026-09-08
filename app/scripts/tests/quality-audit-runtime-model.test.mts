import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';

import { runEffectTestPromise } from '../../packages/core-runtime/src/testing/effect-runtime.ts';
import { buildKnipModel } from '../../quality-audit/knip-model.mts';
import { buildKnipRuntimeEvidence } from '../../quality-audit/knip-runtime-model.mts';
import { runPinnedKnip } from './quality-audit-test-support.mts';

const shellRoot = 'apps/shell';
const layoutFile = `${shellRoot}/src/routes/layout.tsx`;
const vendorRoot = 'node_modules/@modern-js/create/templates/workspace-scripts';
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
const stringify = async (value: Schema.Json) =>
  await runEffectTestPromise(Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value));
const facts = async (root: string) =>
  await runEffectTestPromise(
    buildKnipRuntimeEvidence(root).pipe(Effect.provide(NodeServices.layer)),
  );
const fixture = async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ontos-knip-runtime-')));
  write(
    root,
    'package.json',
    '{"name":"runtime-controls","private":true,"type":"module","devDependencies":{"@effect/tsgo":"0.19.0"}}',
  );
  write(root, tsgoPackage, '{"name":"@effect/tsgo","version":"0.19.0"}');
  write(
    root,
    `${shellRoot}/package.json`,
    await stringify({
      dependencies: {
        '@fixture/css-comment': '1',
        '@fixture/css-dead': '1',
        [cssUsed]: '1',
      },
      name: '@fixture/shell',
      scripts: { bootstrap: 'sh scripts/launch.sh' },
      type: 'module',
    }),
  );
  write(
    root,
    layoutFile,
    "import './index.css'; export default function Layout() { return null; }",
  );
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
    'scripts/ultramodern-typecheck.mts',
    "const forwardedArgs = []; const args = ['ultramodern', 'typecheck', ...forwardedArgs]; void args;",
  );
  write(
    root,
    `${vendorRoot}/ultramodern-typecheck.mjs`,
    "resolveEffectTsgoCompiler({ from: pathToFileURL(join(workspaceRoot, 'package.json')) });",
  );
  write(root, tsgoReadme, compilerDocumentation);
  write(
    root,
    compilerConfig,
    await stringify({ compilerOptions: { plugins: [{ name: pluginName }] } }),
  );
  write(
    root,
    'scripts/ultramodern-performance-readiness.mts',
    "const forwardedArgs=[]; const args=['ultramodern', 'performance-readiness', ...forwardedArgs]; void args;",
  );
  write(
    root,
    `${vendorRoot}/ultramodern-performance-readiness.mjs`,
    `const configPath = '${readinessConfig}'; const moduleUrl = pathToFileURL(path.join(root, configPath)).href; const module = await import(moduleUrl); normalizeConfig(module.default ?? {});`,
  );
  write(root, readinessConfig, 'export default {}; export const unusedConfigExport = 1;');
  return root;
};

await test('runtime consumers require the exact CSS, shell, deployment and compiler contracts', async () => {
  const root = await fixture();
  try {
    const initial = await facts(root);
    for (const target of [
      cssUsed,
      launchedFile,
      resetFile,
      tsgoName,
      pluginName,
      readinessConfig,
    ]) {
      assert.ok(
        initial.some((fact) => fact.target === target),
        target,
      );
    }
    for (const target of ['@fixture/css-dead', '@fixture/css-comment', 'scripts/dead.mts']) {
      assert.ok(!initial.some((fact) => fact.target === target), target);
    }
    assert.equal(initial.find((fact) => fact.target === pluginName)?.kind, compilerOptionKind);
    assert.ok(
      initial.some(
        (fact) => fact.target === `${readinessConfig}#default` && fact.kind === 'export',
      ),
    );
    write(root, layoutFile, emptyLayout);
    write(root, `${shellRoot}/package.json`, '{"name":"@fixture/shell"}');
    write(root, 'zerops.yaml', '# - cd app && node scripts/reset.mjs');
    write(
      root,
      compilerConfig,
      await stringify({
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
    const changed = await facts(root);
    for (const target of [cssUsed, launchedFile, resetFile, pluginName, readinessConfig]) {
      assert.ok(!changed.some((fact) => fact.target === target), target);
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

await test('compiler-option proof requires the installed pinned compiler and built-in plugin documentation', async () => {
  const root = await fixture();
  try {
    write(root, tsgoReadme, '"name": "@effect/language-service"');
    const nameOnly = await facts(root);
    assert.ok(!nameOnly.some((fact) => fact.kind === compilerOptionKind));
    write(root, tsgoReadme, compilerDocumentation);
    write(root, tsgoPackage, '{"name":"@effect/tsgo","version":"0.20.0"}');
    const wrongVersion = await facts(root);
    assert.ok(!wrongVersion.some((fact) => fact.kind === compilerOptionKind));
    write(root, tsgoPackage, '{"name":"@effect/tsgo","version":"0.19.0"}');
    write(
      root,
      compilerConfig,
      await stringify({
        compilerOptions: {
          plugins: [{ name: pluginName }],
          types: [`${pluginName}/types`],
        },
      }),
    );
    const typeImport = await facts(root);
    assert.ok(!typeImport.some((fact) => fact.kind === compilerOptionKind));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

await test('compiler configuration accepts JSONC but rejects malformed and schema-invalid input', async () => {
  const root = await fixture();
  try {
    write(
      root,
      compilerConfig,
      `{
      // TypeScript permits comments and trailing commas.
      "compilerOptions": { "plugins": [{ "name": "${pluginName}", }], },
    }`,
    );
    const modeled = await facts(root);
    assert.ok(modeled.some((fact) => fact.kind === compilerOptionKind));
    write(root, compilerConfig, '{ "compilerOptions": {');
    await assert.rejects(facts(root), /InvalidTsconfig/u);
    write(root, compilerConfig, '{ "compilerOptions": { "plugins": false } }');
    await assert.rejects(facts(root), /plugins/u);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

await test('DTS compiler resolution belongs to the invoking workspace and excludes commented lookalikes', async () => {
  const root = await fixture();
  try {
    const configFile = `${shellRoot}/module-federation.config.ts`;
    const source =
      "import { resolveEffectTsgoCompiler } from '@modern-js/app-tools/config';\nconst compiler = resolveEffectTsgoCompiler({ from: import.meta.url });\nvoid compiler;";
    write(root, configFile, source);
    write(root, `${shellRoot}/${tsgoReadme}`, 'tries `typescript`, then `@typescript/native`');
    const initial = await facts(root);
    for (const target of [tsgoName, '@typescript/native']) {
      assert.ok(initial.some((fact) => fact.target === target && fact.workspace === shellRoot));
    }
    write(root, configFile, `/* ${source} */\nexport default {};`);
    const commented = await facts(root);
    assert.ok(!commented.some((fact) => fact.source === configFile));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

await test('Lefthook configuration proves only intended tool usage and ignores commented hook text', async () => {
  const root = await fixture();
  try {
    const source = 'pre-commit:\n  commands:\n    format:\n      run: pnpm format\n';
    write(root, 'lefthook.yml', source);
    const configured = await facts(root);
    const tool = configured.find((fact) => fact.target === 'lefthook');
    assert.equal(tool?.kind, 'dependency');
    assert.match(tool?.reason ?? '', /does not establish hook activation/u);
    write(
      root,
      'lefthook.yml',
      source
        .split('\n')
        .map((line) => `# ${line}`)
        .join('\n'),
    );
    const commented = await facts(root);
    assert.ok(!commented.some((fact) => fact.target === 'lefthook'));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

await test('real Knip keeps unused neighboring files, dependency names and exports after runtime modeling', async () => {
  const root = await fixture();
  try {
    const consumerPath = path.join(root, '.audit/consumers.mts');
    const model = await runEffectTestPromise(
      buildKnipModel(
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
      ).pipe(Effect.provide(NodeServices.layer)),
    );
    const run = await runPinnedKnip(root, consumerPath, model);
    assert.equal(run.error, undefined);
    assert.ok(run.status === 0 || run.status === 1, run.stderr);
    const report = await runEffectTestPromise(
      Schema.decodeUnknownEffect(
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
      )(run.stdout),
    );
    const unusedFiles = report.issues.flatMap((issue) => issue.files.map((item) => item.name));
    assert.ok(unusedFiles.some((file) => file.endsWith('/scripts/dead.mts')));
    assert.ok(
      !unusedFiles.some(
        (file) =>
          file.endsWith('/scripts/launched.mts') || file === resetFile || file === readinessConfig,
      ),
    );
    const dependencies = new Set(
      report.issues.flatMap((issue) => issue.dependencies.map((item) => item.name)),
    );
    assert.ok(dependencies.has('@fixture/css-dead'));
    assert.ok(dependencies.has('@fixture/css-comment'));
    assert.ok(!dependencies.has(cssUsed));
    const exports = new Set(
      report.issues.flatMap((issue) => issue.exports.map((item) => item.name)),
    );
    assert.ok(
      !report.issues.some(
        (issue) =>
          issue.file === readinessConfig && issue.exports.some((item) => item.name === 'default'),
      ),
    );
    for (const name of ['unusedLauncherExport', 'unusedResetExport', 'unusedConfigExport']) {
      assert.ok(exports.has(name), name);
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

await test('shared framework runner retains compiler/readiness evidence without accepting unused neighbors', async () => {
  const root = await fixture();
  const runnerFile = 'scripts/shared/ultramodern-command.mts';
  try {
    const runner = readFileSync(
      new URL('../shared/ultramodern-command.mts', import.meta.url),
      'utf-8',
    );
    write(root, runnerFile, runner);
    for (const command of ['typecheck', 'performance-readiness']) {
      write(
        root,
        `scripts/ultramodern-${command}.mts`,
        readFileSync(new URL(`../ultramodern-${command}.mts`, import.meta.url), 'utf-8'),
      );
    }
    const modeled = await facts(root);
    for (const target of [tsgoName, pluginName, readinessConfig, `${readinessConfig}#default`]) {
      assert.ok(
        modeled.some((fact) => fact.target === target),
        target,
      );
    }
    write(
      root,
      runnerFile,
      runner.replace(
        'ChildProcess.make(launch.executable, launch.args,',
        'ChildProcess.make("unrelated", [],',
      ),
    );
    const disconnected = await facts(root);
    assert.ok(!disconnected.some((fact) => fact.target === tsgoName));
    assert.ok(!disconnected.some((fact) => fact.target === readinessConfig));
    write(root, runnerFile, runner);
    write(
      root,
      'scripts/ultramodern-typecheck.mts',
      "import { runUltramodernScript } from './shared/unrelated.mts'; runUltramodernScript({ command: 'typecheck' });",
    );
    write(
      root,
      'scripts/ultramodern-performance-readiness.mts',
      "import { runUltramodernScript } from './shared/ultramodern-command.mts'; runUltramodernScript({ command: 'unrelated' });",
    );
    const neighbors = await facts(root);
    assert.ok(!neighbors.some((fact) => fact.target === tsgoName));
    assert.ok(!neighbors.some((fact) => fact.target === readinessConfig));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
