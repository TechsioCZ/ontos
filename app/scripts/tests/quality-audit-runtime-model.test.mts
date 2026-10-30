import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Array as EffectArray, Effect, Order, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { buildKnipModel } from '../../quality-audit/knip-model.mts';
import { buildKnipRuntimeEvidence, workspaceDirectories } from '../../quality-audit/knip-runtime-model.mts';
import { runPinnedKnip } from './quality-audit-test-support.mts';

const nativeReadinessReason = 'Native invoked performance-readiness';
const nativeScriptPattern = 'scripts/**/*.mjs';
const reactSourcePattern = 'src/**/*.tsx';
const storefrontWorkspace = 'akros-storefront';
const inertNodeCommand = 'node scripts/unused-neighbor.mjs';
const appWorkingDirectoryLine = 'cd "$APP"\n';
const nativeNextCssReason = 'Native Next layout CSS';
const shellRoot = 'apps/shell';
const sourcePattern = 'src/**/*.ts';
const packageManifest = 'package.json';
const consumerFile = 'consumers.mts';
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
      packageManifest,
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
          '.': { entry: [], node: false, project: [nativeScriptPattern] },
          'apps/*': {
            entry: ['src/routes/layout.tsx'],
            node: false,
            project: ['scripts/**/*.mts', reactSourcePattern],
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
    const packageFile = packageManifest;
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

it.live(
  'Modern server discovery consumes only the invoked documented default and retains neighboring exports',
  Effect.fn(function* modernServerConsumers() {
    const root = yield* fixture();
    const server = `${shellRoot}/server/modern.server.ts`;
    const documentation = `${shellRoot}/node_modules/@modern-js/app-tools/docs/configure/app/usage.md`;
    const manifest = {
      devDependencies: { '@modern-js/app-tools': '1' },
      name: '@fixture/shell',
      scripts: { build: 'modern build' },
      type: 'module',
    };
    write(root, `${shellRoot}/${packageManifest}`, yield* stringify(manifest));
    write(root, documentation, 'Server Runtime configuration uses `server/modern.server.(ts|js|mjs)`.');
    write(root, server, 'export default {}; export const unusedServerExport = 1;');
    const dead = `${shellRoot}/server/dead.ts`;
    write(root, dead, 'export const unusedServerFile = 1;');
    const consumer = path.join(root, consumerFile);
    const config = {
      workspaces: {
        '.': { entry: [], node: false, project: [nativeScriptPattern] },
        'apps/*': { entry: [], node: false, project: ['server/**/*.ts'] },
      },
    };
    const model = yield* buildKnipModel(root, config, consumer).pipe(Effect.provide(NodeServices.layer));
    const native = yield* runPinnedKnip(root, consumer, model).pipe(Effect.provide(NodeServices.layer));
    expect(native.stdout).toContain('unusedServerExport');
    expect(native.stdout).toContain(dead);
    expect(native.stdout).not.toContain('"name":"default"');
    expect(model.evidence.some((fact) => fact.target === `${server}#default`)).toBe(true);

    write(
      root,
      `${shellRoot}/${packageManifest}`,
      yield* stringify({ ...manifest, scripts: { build: 'echo modern build' } }),
    );
    const disconnected = yield* buildKnipModel(root, config, consumer).pipe(Effect.provide(NodeServices.layer));
    expect(disconnected.evidence.some((fact) => fact.target === `${server}#default`)).toBe(false);
    const control = yield* runPinnedKnip(root, consumer, disconnected).pipe(Effect.provide(NodeServices.layer));
    expect(control.stdout).toContain(`"name":"${server}"`);
    write(root, `${shellRoot}/${packageManifest}`, yield* stringify(manifest));
    write(root, documentation, 'Unrelated configuration contract.');
    expect((yield* facts(root)).some((fact) => fact.target === `${server}#default`)).toBe(false);
  }),
);

it.live(
  'native workflow commands consume only source at the configured cwd and retain inert neighboring paths',
  Effect.fn(function* workflowSourceConsumers() {
    const root = yield* fixture();
    const workflow = '../.github/workflows/proof.yml';
    const invoked = 'scripts/workflow-invoked.mts';
    const adjacent = 'scripts/workflow-adjacent.mts';
    const heredoc = 'scripts/workflow-heredoc.mts';
    const wrongCwd = 'scripts/workflow-wrong-cwd.mts';
    write(
      root,
      invoked,
      "import { used } from './workflow-values.mts'; void used; export const unusedEntryExport = 1;",
    );
    write(root, 'scripts/workflow-values.mts', 'export const used = 1; export const unusedWorkflowExport = 2;');
    for (const file of [adjacent, heredoc, wrongCwd]) {
      write(root, file, 'export const unusedNeighbor = 1;');
    }
    write(
      root,
      workflow,
      `defaults:
  run:
    working-directory: app
jobs:
  proof:
    steps:
      - run: |
          LOOKUP="$(cd temporary && node -p '1')"
          export LOOKUP
          mise exec -- node ${invoked}
      - run: echo "node ${adjacent}"
      - run: |
          cat <<'DOCUMENT'
          node ${heredoc}
          DOCUMENT
      - working-directory: elsewhere
        run: node ${wrongCwd}
`,
    );
    const config = {
      workspaces: {
        '.': { entry: [], node: false, project: ['scripts/**/*.mts'] },
        'apps/*': { entry: [], node: false, project: [] },
      },
    };
    const consumer = path.join(root, consumerFile);
    const model = yield* buildKnipModel(root, config, consumer).pipe(Effect.provide(NodeServices.layer));
    expect(model.evidence.some((fact) => fact.source === workflow && fact.target === invoked)).toBe(true);
    for (const file of [adjacent, heredoc, wrongCwd]) {
      expect(
        model.evidence.some((fact) => fact.source === workflow && fact.target === file),
        file,
      ).toBe(false);
    }
    const native = yield* runPinnedKnip(root, consumer, model).pipe(Effect.provide(NodeServices.layer));
    expect(native.stdout).toContain('unusedEntryExport');
    expect(native.stdout).toContain('unusedWorkflowExport');
    for (const file of [adjacent, heredoc, wrongCwd]) {
      expect(native.stdout, file).toContain(`"name":"${file}"`);
    }
    expect(native.stdout).not.toContain(`"name":"${invoked}"`);
    write(root, workflow, `jobs:\n  proof:\n    steps:\n      - run: echo "node app/${invoked}"\n`);
    expect((yield* facts(root)).some((fact) => fact.source === workflow)).toBe(false);
    write(root, workflow, 'jobs: [');
    expect(String(yield* Effect.flip(facts(root)))).toMatch(/InvalidWorkflow/u);
    write(root, workflow, 'jobs:\n  proof:\n    steps: not-an-array\n');
    expect(String(yield* Effect.flip(facts(root)))).toMatch(/steps/u);
  }),
);

it.live(
  'native repository workflow consumes an exact storefront Node file without admitting opaque or outside-project paths',
  Effect.fn(function* workflowStorefrontControls() {
    const root = yield* fixture();
    const workflow = '../.github/workflows/stage-demo-deploy.yml';
    const target = `${storefrontWorkspace}/tests/browser/newsletter-consent.mjs`;
    const neighboring = `${storefrontWorkspace}/tests/browser/email-verification.mjs`;
    const outside = '../outside.mjs';
    const linked = `${storefrontWorkspace}/tests/browser/outside-link.mjs`;
    const command = `mise exec -- node ${target}`;
    const source = readFileSync(path.resolve(import.meta.dirname, '../..', workflow), 'utf-8');
    expect(source).toContain(command);
    write(root, workflow, source);
    write(root, `${storefrontWorkspace}/package.json`, '{"name":"storefront","private":true,"type":"module"}');
    write(root, target, "import { used } from './values.mjs'; void used; export const unusedBrowserExport = 1;");
    write(
      root,
      `${storefrontWorkspace}/tests/browser/values.mjs`,
      'export const used = 1; export const unusedValue = 2;',
    );
    write(root, neighboring, 'export const unusedLocalProof = 1;');
    write(root, outside, 'export const outsideProject = 1;');
    symlinkSync(path.resolve(root, outside), path.join(root, linked));
    const initial = yield* facts(root);
    expect(initial.some((fact) => fact.source === workflow && fact.kind === 'file' && fact.target === target)).toBe(
      true,
    );
    const consumer = path.join(root, consumerFile);
    const model = yield* buildKnipModel(
      root,
      {
        workspaces: {
          '.': { entry: [], node: false, project: [] },
          [storefrontWorkspace]: { entry: [], node: false, project: ['tests/browser/*.mjs'] },
        },
      },
      consumer,
    ).pipe(Effect.provide(NodeServices.layer));
    const native = yield* runPinnedKnip(root, consumer, model).pipe(Effect.provide(NodeServices.layer));
    expect(native.status, `${native.stdout}\n${native.stderr}`).toBe(1);
    expect(model.consumerSource).toContain(path.join(root, target));
    expect(native.stdout).not.toContain(`"name":"${target}"`);
    expect(native.stdout).toContain(`"name":"${neighboring}"`);
    expect(native.stdout).toContain('unusedBrowserExport');
    expect(native.stdout).toContain('unusedValue');
    for (const [directory, run] of [
      ['app', `# ${command}`],
      ['app', `echo "${command}"`],
      ['elsewhere', command],
      ['.', command],
      ['app', `TARGET="${target}"\nnode "$TARGET"`],
      ['app', `bash -c '${command}'`],
      ['app', `node ${outside}`],
      ['app', `node ${path.resolve(root, outside)}`],
      ['app', `node ${linked}`],
      ['app', `node() {\n  echo ignored\n}\n${command}`],
    ]) {
      write(
        root,
        workflow,
        yield* stringify({ jobs: { proof: { steps: [{ run, 'working-directory': directory }] } } }),
      );
      expect(
        (yield* facts(root)).filter((fact) => fact.source === workflow),
        `${directory}: ${run}`,
      ).toEqual([]);
    }
  }),
);

it.live(
  'manifest workspace declarations include standalone and nested packages without adjacent directories',
  Effect.fn(function* declaredWorkspaceDirectories() {
    const root = yield* fixture();
    const packageFile = path.join(root, packageManifest);
    const original = readFileSync(packageFile, 'utf-8');
    writeFileSync(
      packageFile,
      original.replace('"private":true', '"private":true,"workspaces":["akros-storefront","extensions/*"]'),
    );
    write(root, 'akros-storefront/package.json', '{"name":"storefront","private":true}');
    write(root, 'extensions/declared/package.json', '{"name":"declared","private":true}');
    write(root, 'unowned/package.json', '{"name":"unowned","private":true}');
    write(root, 'extensions/no-package/source.ts', 'export const source = 1;');
    const directories = yield* workspaceDirectories(root).pipe(Effect.provide(NodeServices.layer));
    expect(directories).toContain(storefrontWorkspace);
    expect(directories).toContain('extensions/declared');
    expect(directories).not.toContain('unowned');
    expect(directories).not.toContain('extensions/no-package');
    expect(directories.filter((directory) => directory === shellRoot)).toHaveLength(1);
  }),
);

it.live(
  'tool package workspaces are audited without promoting adjacent unowned directories or unused exports',
  Effect.fn(function* toolWorkspaceConsumers() {
    const root = yield* fixture();
    const tool = 'tools/agent';
    write(
      root,
      `${tool}/package.json`,
      '{"name":"@fixture/agent","type":"module","scripts":{"start":"node src/server.ts"}}',
    );
    write(root, `${tool}/src/server.ts`, "import { live } from './live.ts'; void live;");
    write(root, `${tool}/src/live.ts`, 'export const live = 1; export const unusedToolExport = 2;');
    write(root, `${tool}/src/dead.ts`, 'export const unusedToolFile = 1;');
    write(root, 'tools/no-package/src/server.ts', 'export const noPackageFile = 1;');
    const directories = yield* workspaceDirectories(root).pipe(Effect.provide(NodeServices.layer));
    expect(directories).toContain(tool);
    expect(directories).not.toContain('tools/no-package');
    const consumerPath = path.join(root, 'consumers.mts');
    const model = yield* buildKnipModel(
      root,
      {
        workspaces: {
          '.': { entry: [], node: false, project: [] },
          'tools/*': { entry: ['src/server.ts'], node: false, project: [sourcePattern] },
        },
      },
      consumerPath,
    ).pipe(Effect.provide(NodeServices.layer));
    expect(Object.hasOwn(model.config.workspaces ?? {}, tool)).toBe(true);
    expect(Object.hasOwn(model.config.workspaces ?? {}, 'tools/no-package')).toBe(false);
    const run = yield* runPinnedKnip(root, consumerPath, model).pipe(Effect.provide(NodeServices.layer));
    expect(run.stdout).toContain('unusedToolExport');
    expect(run.stdout).toContain(`${tool}/src/dead.ts`);
  }),
);

it.effect(
  'root-level storefront workspace discovery retains its explicit Knip configuration',
  Effect.fn(function* storefrontWorkspaceDiscovery() {
    const root = yield* fixture();
    write(root, 'akros-storefront/package.json', '{"name":"akros-storefront","private":true,"type":"module"}');
    write(root, 'akros-storefront/src/index.ts', 'export const storefront = 1;');
    write(root, 'akros-storefront-backup/package.json', '{"name":"not-a-workspace","private":true}');
    const directories = yield* workspaceDirectories(root).pipe(Effect.provide(NodeServices.layer));
    expect(directories).toContain(storefrontWorkspace);
    expect(directories).not.toContain('akros-storefront-backup');
    const model = yield* buildKnipModel(root, {
      workspaces: {
        '.': { entry: [], node: false, project: [] },
        [storefrontWorkspace]: { entry: ['src/index.ts'], node: false, project: [sourcePattern] },
      },
    }).pipe(Effect.provide(NodeServices.layer));
    expect(model.config.workspaces?.[storefrontWorkspace]?.project).toEqual([sourcePattern]);
    expect(model.config.workspaces?.[storefrontWorkspace]?.entry).toContain('src/index.ts');
  }),
);

it.live(
  'storefront demo launcher consumes exact Node files only after its native workspace cd',
  Effect.fn(function* storefrontLauncherControls() {
    const root = yield* fixture();
    const owner = storefrontWorkspace;
    const launcher = `${owner}/scripts/demo-restart.sh`;
    const target = 'scripts/with-demo-env.mjs';
    write(root, `${owner}/package.json`, '{"name":"@fixture/storefront","type":"module"}');
    write(root, `${owner}/${target}`, 'export const unusedLauncherNeighbor = 1;');
    write(root, `${owner}/scripts/unused-neighbor.mjs`, 'export const unused = 1;');
    const source = [
      '#!/bin/bash',
      `APP="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"`,
      'cd "$APP"',
      'mise exec -- node scripts/with-demo-env.mjs build --webpack > build.log 2>&1 || { exit 1; }',
      'nohup mise exec -- node scripts/with-demo-env.mjs start > start.log 2>&1 &',
      '# node scripts/unused-neighbor.mjs',
      "cat <<'INERT'",
      inertNodeCommand,
      'INERT',
      "note='",
      inertNodeCommand,
      "'",
      'unused() {',
      inertNodeCommand,
      '}',
    ].join('\n');
    write(root, launcher, source);
    const initial = yield* facts(root);
    expect(initial.filter((fact) => fact.source === launcher).map((fact) => [fact.kind, fact.target])).toEqual([
      ['file', target],
      ['file', target],
    ]);
    const consumerPath = path.join(root, consumerFile);
    const model = yield* buildKnipModel(
      root,
      { workspaces: { '.': { entry: [], project: [] }, [owner]: { entry: [], project: [nativeScriptPattern] } } },
      consumerPath,
    ).pipe(Effect.provide(NodeServices.layer));
    const run = yield* runPinnedKnip(root, consumerPath, model).pipe(Effect.provide(NodeServices.layer));
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(1);
    const report = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({
          issues: Schema.Array(
            Schema.Struct({
              exports: Schema.Array(Schema.Struct({ name: Schema.String })),
              file: Schema.String,
              files: Schema.Array(Schema.Unknown),
            }),
          ),
        }),
      ),
    )(run.stdout);
    expect(
      report.issues.find((issue) => issue.file === `${owner}/${target}`)?.exports.map((item) => item.name),
    ).toContain('unusedLauncherNeighbor');
    expect(report.issues.find((issue) => issue.file === `${owner}/scripts/unused-neighbor.mjs`)?.files.length).toBe(1);
    for (const invalid of [
      source.replace(appWorkingDirectoryLine, 'cd "$ROOT"\n'),
      source.replace('/.." && pwd)', '/../.." && pwd)'),
      source.replace(appWorkingDirectoryLine, 'cd "$APP"\ncd /wrong\n'),
      source.replace(appWorkingDirectoryLine, 'APP=/wrong\ncd "$APP"\n'),
      `node() {\n printf fake;\n}\n${source}`,
      source
        .replaceAll(
          'mise exec -- node scripts/with-demo-env.mjs build --webpack > build.log 2>&1 || { exit 1; }',
          '# inert build',
        )
        .replaceAll('nohup mise exec -- node scripts/with-demo-env.mjs start > start.log 2>&1 &', '# inert start'),
    ]) {
      write(root, launcher, invalid);
      expect((yield* facts(root)).some((fact) => fact.source === launcher)).toBe(false);
    }
  }),
);

it.live(
  'native Next CSS follows only imported local and package CSS and Tailwind plugin directives',
  Effect.fn(function* nextCssControls() {
    const root = yield* fixture();
    const owner = storefrontWorkspace;
    const manifest = `${owner}/package.json`;
    const configuration = `${owner}/postcss.config.mjs`;
    const layout = `${owner}/src/app/layout.tsx`;
    const css = `${owner}/src/app/globals.css`;
    const tokenPackage = '@fixture/css-tokens';
    const iconPlugin = '@fixture/icons';
    const tailwind = 'tailwindcss';
    const writeManifest = (scripts: Schema.Json) =>
      stringify({
        dependencies: {
          '@fixture/comment-css': '1',
          '@fixture/dead-css': '1',
          '@fixture/string-css': '1',
          [iconPlugin]: '1',
          next: '16.0.0',
          [tailwind]: '4',
          [tokenPackage]: '1',
        },
        name: '@fixture/next-css',
        scripts,
        type: 'module',
      });
    write(root, manifest, yield* writeManifest({ build: 'next build' }));
    write(root, configuration, 'export default { plugins: { "@tailwindcss/postcss": {} } };');
    write(root, layout, "import './globals.css'; export default function Layout() { return null; }");
    write(
      root,
      css,
      `@import "${tokenPackage}/tokens";\n@import "../tokens/icons.css";\n/* @import "@fixture/comment-css"; */\np::before { content: '@import "@fixture/string-css"'; }`,
    );
    write(
      root,
      `${owner}/src/tokens/icons.css`,
      `@plugin "${iconPlugin}" { prefix: 'icon'; }\n@import "../app/globals.css";`,
    );
    write(root, `${owner}/src/tokens/dead.css`, '@import "@fixture/dead-css";');
    write(
      root,
      `${owner}/node_modules/${tokenPackage}/package.json`,
      '{"name":"@fixture/css-tokens","exports":{"./tokens":{"default":"./tokens.css"}}}',
    );
    write(root, `${owner}/node_modules/${tokenPackage}/tokens.css`, '@import "tailwindcss";');
    const initial = yield* facts(root);
    const modeled = initial.filter((fact) => fact.reason.startsWith(nativeNextCssReason));
    expect(
      EffectArray.sort(
        modeled.map((fact) => fact.target),
        Order.String,
      ),
    ).toEqual(EffectArray.sort([tokenPackage, iconPlugin, tailwind], Order.String));
    expect(modeled.find((fact) => fact.target === tailwind)?.source).toBe(
      `${owner}/node_modules/${tokenPackage}/tokens.css`,
    );
    write(root, configuration, 'export default { plugins: { "@fixture/fake-postcss": {} } };');
    expect((yield* facts(root)).some((fact) => fact.target === iconPlugin)).toBe(false);
    write(root, layout, "const inert = './globals.css'; export default function Layout() { return null; }");
    expect((yield* facts(root)).some((fact) => fact.reason.startsWith(nativeNextCssReason))).toBe(false);
    write(root, layout, "import './globals.css'; export default function Layout() { return null; }");
    write(root, manifest, yield* writeManifest({ build: 'printf "next build"' }));
    expect((yield* facts(root)).some((fact) => fact.reason.startsWith(nativeNextCssReason))).toBe(false);
  }),
);

it.live(
  'native performance-readiness reads only selected topology route-head files without consuming their exports',
  Effect.fn(function* readinessSourceControls() {
    const root = yield* fixture();
    const vendor = `${vendorRoot}/ultramodern-performance-readiness.mjs`;
    const catalog =
      'node_modules/@modern-js/ultramodern-create/dist/esm/ultramodern-workspace/tooling-command-catalog.js';
    const topology = 'topology/reference-topology.json';
    const owner = 'verticals/crm';
    const target = 'src/routes/ultramodern-route-head.tsx';
    const realRoot = path.resolve(import.meta.dirname, '../..');
    const source = readFileSync(path.join(realRoot, vendor), 'utf-8');
    const commands = readFileSync(path.join(realRoot, catalog), 'utf-8');
    write(root, vendor, source);
    write(root, catalog, commands);
    write(
      root,
      topology,
      yield* stringify({
        schemaVersion: 1,
        shell: { id: 'shell', path: shellRoot },
        verticals: [{ id: 'crm', path: owner }],
      }),
    );
    write(root, `${owner}/package.json`, '{"name":"@fixture/crm","type":"module"}');
    write(root, `${owner}/${target}`, 'export const unusedRouteHeadNeighbor = 1;');
    write(root, `${shellRoot}/${target}`, 'export const unusedShellHeadNeighbor = 1;');
    write(root, `${owner}/src/routes/unselected-head.tsx`, 'export const unused = 1;');
    const initial = yield* facts(root);
    expect(
      initial
        .filter((fact) => fact.workspace === owner && fact.reason.startsWith(nativeReadinessReason))
        .map((fact) => [fact.kind, fact.target]),
    ).toEqual([['file', target]]);
    const consumerPath = path.join(root, consumerFile);
    const model = yield* buildKnipModel(
      root,
      {
        workspaces: {
          '.': { entry: [], project: [] },
          'apps/*': { entry: [], project: [reactSourcePattern] },
          'verticals/*': { entry: [], project: [reactSourcePattern] },
        },
      },
      consumerPath,
    ).pipe(Effect.provide(NodeServices.layer));
    const run = yield* runPinnedKnip(root, consumerPath, model).pipe(Effect.provide(NodeServices.layer));
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(1);
    expect(model.consumerSource).toContain(path.join(root, owner, target));
    expect(model.consumerSource).toContain(path.join(root, shellRoot, target));
    expect(run.stdout).toContain('unusedRouteHeadNeighbor');
    expect(run.stdout).toContain(`${owner}/src/routes/unselected-head.tsx`);
    for (const invalid of [
      source.replace('files.map(readText)', 'files.map(fakeRead)'),
      source.replace('await main();', 'void main;'),
      source.replace('/src/routes/ultramodern-route-head.tsx', '/src/routes/other.tsx'),
      source.replace("from 'node:fs'", "from './counterfeit.mjs'"),
      `const inert = ${JSON.stringify(source)};`,
    ]) {
      write(root, vendor, invalid);
      expect((yield* facts(root)).some((fact) => fact.reason.startsWith(nativeReadinessReason))).toBe(false);
    }
    write(root, vendor, source);
    write(
      root,
      catalog,
      commands.replace(
        'templates/workspace-scripts/ultramodern-performance-readiness.mjs',
        'templates/workspace-scripts/other.mjs',
      ),
    );
    expect((yield* facts(root)).some((fact) => fact.reason.startsWith(nativeReadinessReason))).toBe(false);
  }),
);
