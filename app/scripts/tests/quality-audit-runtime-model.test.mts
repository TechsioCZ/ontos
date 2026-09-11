import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { buildKnipModel } from '../../quality-audit/knip-model.mts';
import { buildKnipRuntimeEvidence } from '../../quality-audit/knip-runtime-model.mts';
import { runPinnedKnip } from './quality-audit-test-support.mts';

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
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(path.join(tmpdir(), 'ontos-knip-runtime-'))),
      (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
    ).pipe(Effect.map((directory) => realpathSync(directory)));
    write(
      root,
      'package.json',
      '{"name":"runtime-controls","private":true,"type":"module","devDependencies":{"@effect/tsgo":"0.19.0"}}',
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
        name: '@fixture/shell',
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
      'scripts/ultramodern-typecheck.mts',
      "const forwardedArgs = []; const args = ['ultramodern', 'typecheck', ...forwardedArgs]; void args;",
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
  });

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
      "import { resolveEffectTsgoCompiler } from '@modern-js/app-tools-extensions/config';\nconst compiler = resolveEffectTsgoCompiler({\n from: import.meta.url,\n });\nvoid compiler;";
    write(root, configFile, source);
    write(root, `${shellRoot}/${tsgoReadme}`, 'tries `typescript`, then `@typescript/native`');
    const initial = yield* facts(root);
    for (const target of ['@effect/tsgo', '@typescript/native']) {
      expect(initial.some((fact) => fact.target === target && fact.workspace === shellRoot)).toBe(true);
    }
    write(root, configFile, `/* ${source} */\nexport default {};`);
    const commented = yield* facts(root);
    expect(!commented.some((fact) => fact.source === configFile)).toBe(true);
  }),
);

it.live(
  'Lefthook configuration proves only intended tool usage and ignores commented hook text',
  Effect.fn(function* testEffect8() {
    const root = yield* fixture();
    const source = 'pre-commit:\n  commands:\n    format:\n      run: pnpm format\n';
    write(root, 'lefthook.yml', source);
    const configured = yield* facts(root);
    const tool = configured.find((fact) => fact.target === 'lefthook');
    expect(tool?.kind).toBe('dependency');
    expect(tool?.reason ?? '').toMatch(/does not establish hook activation/u);
    write(
      root,
      'lefthook.yml',
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
  'shared framework runner retains compiler/readiness evidence without accepting unused neighbors',
  Effect.fn(function* mergedScenario1() {
    const root = yield* fixture();
    const runnerFile = 'scripts/shared/ultramodern-command.mts';
    try {
      const runner = readFileSync(new URL('../shared/ultramodern-command.mts', import.meta.url), 'utf-8');
      write(root, runnerFile, runner);
      for (const command of ['typecheck', 'performance-readiness']) {
        write(
          root,
          `scripts/ultramodern-${command}.mts`,
          readFileSync(new URL(`../ultramodern-${command}.mts`, import.meta.url), 'utf-8'),
        );
      }
      const modeled = yield* facts(root);
      for (const target of [tsgoName, pluginName, readinessConfig, `${readinessConfig}#default`]) {
        expect(
          modeled.some((fact) => fact.target === target),
          target,
        ).toBeTruthy();
      }
      write(
        root,
        runnerFile,
        runner.replace('ChildProcess.make(launch.executable, launch.args,', 'ChildProcess.make("unrelated", [],'),
      );
      const disconnected = yield* facts(root);
      expect(!disconnected.some((fact) => fact.target === tsgoName)).toBeTruthy();
      expect(!disconnected.some((fact) => fact.target === readinessConfig)).toBeTruthy();
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
      const neighbors = yield* facts(root);
      expect(!neighbors.some((fact) => fact.target === tsgoName)).toBeTruthy();
      expect(!neighbors.some((fact) => fact.target === readinessConfig)).toBeTruthy();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }),
);
