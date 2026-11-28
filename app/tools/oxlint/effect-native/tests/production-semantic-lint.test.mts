import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'effect-rstest';

import { appRoot } from './oxlint.mts';
import { runProductionOxlint } from './production-oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const hookFilename = 'lefthook.yml';
const modulesDirectory = 'node_modules';

const semanticJob = 'semantic-lint';
const fixtureApp = (root: string, name: string) => {
  const app = path.join(root, 'app');
  mkdirSync(app);
  symlinkSync(path.join(appRoot, modulesDirectory), path.join(app, modulesDirectory), 'dir');
  copyFileSync(path.join(appRoot, '..', hookFilename), path.join(root, hookFilename));
  writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name, private: true, type: 'module' }));
  expect(spawnSync('/usr/bin/git', ['init', '--quiet'], { cwd: root }).status).toBe(0);
  return app;
};

const project = (exactOptionalPropertyTypes: boolean) =>
  JSON.stringify({
    compilerOptions: { exactOptionalPropertyTypes, noImplicitReturns: true, strict: true, target: 'ES2022' },
    include: ['*.ts'],
  });

const runHook = (root: string, files: readonly string[], job: 'lint' | 'semantic-lint') => {
  const child = spawnSync(
    path.join(appRoot, 'node_modules/.bin/lefthook'),
    [
      'run',
      'pre-commit',
      '--job',
      job,
      '--files-from-stdin',
      '--no-auto-install',
      '--no-stage-fixed',
      '--colors',
      'off',
    ],
    {
      cwd: root,
      encoding: 'utf-8',
      input: files.map((name) => `app/${name}\0`).join(''),
    },
  );
  return { output: child.stdout + child.stderr, status: child.status };
};

it('the production hook selects each authored root and enforces the native semantic diagnostics', () => {
  withTemporaryWorkspace((root) => {
    const app = fixtureApp(root, 'semantic-lint-control');
    writeFileSync(
      path.join(app, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { noImplicitReturns: true, strict: true, target: 'ES2022' } }),
    );
    const files = [
      'apps/demo/src/option.ts',
      'verticals/demo/src/returns.ts',
      'packages/demo/src/membership.ts',
      'scripts/control.mts',
      'tools/oxlint/effect-native/tests/control.test.mts',
    ];
    const put = (file: string, source: string) => {
      const target = path.join(app, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, source);
    };
    for (const file of files) {
      put(file, 'export const control = 1;');
    }
    const clean = runHook(root, files, semanticJob);
    expect(clean.output).toContain('Semantic lint checked 5 files');
    expect(clean.status).toBe(0);
    put('apps/demo/src/option.ts', 'export interface Example { value?: string | undefined }');
    put('verticals/demo/src/returns.ts', 'export function choose(flag: boolean): number { if (flag) return 1; }');
    put(
      'packages/demo/src/membership.ts',
      'export const select = (keys: readonly string[], rows: string[]) => rows.filter(row => keys.includes(row));',
    );
    const invalid = runHook(root, files, semanticJob);
    expect(invalid.status).toBe(1);
    for (const rule of ['redundant-optional-undefined', 'missing-return-value', 'repeated-array-membership']) {
      expect(invalid.output).toContain(rule);
    }
  }, tmpdir());
});

it('the production Oxlint hook blocks repeated flatMap and find lookups but accepts a Set', () => {
  withTemporaryWorkspace((root) => {
    const app = fixtureApp(root, 'lookup-control');
    const source = 'packages/demo/src/select.ts';
    const target = path.join(app, source);
    mkdirSync(path.dirname(target), { recursive: true });
    for (const directory of ['tools', 'apps']) {
      symlinkSync(path.join(appRoot, directory), path.join(app, directory), 'dir');
    }
    copyFileSync(path.join(appRoot, 'oxlint.config.ts'), path.join(app, 'oxlint.config.ts'));
    writeFileSync(
      path.join(app, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022' }, include: [source] }),
    );
    for (const method of ['flatMap', 'find']) {
      writeFileSync(
        target,
        `export const select = (keys: readonly string[], rows: readonly string[]) => rows.${method}((row) => keys.includes(row));`,
      );
      const invalid = runHook(root, [source], 'lint');
      expect(invalid.output).toContain('js-set-map-lookups');
      expect(invalid.status).toBe(1);
    }
    writeFileSync(
      target,
      'export const select = (keys: ReadonlySet<string>, rows: readonly string[]) => rows.find((row) => keys.has(row));',
    );
    const clean = runHook(root, [source], 'lint');
    expect(clean.output).not.toContain('js-set-map-lookups');
    expect(clean.status, clean.output).toBe(0);
  }, tmpdir());
});

it('compares the typed Sonar preset with the shipped tsrs rules on aliases, exact properties and mixed returns', () => {
  withTemporaryWorkspace((root) => {
    const app = fixtureApp(root, 'policy-control');
    const alias = 'packages/legacy/alias.ts';
    const exact = 'packages/exact/optional.ts';
    const mixed = 'packages/legacy/mixed.ts';
    const files = {
      [alias]: 'type Local = string | undefined; export interface Row { readonly value?: Local }',
      [exact]:
        'type Local = string | undefined; export interface Row { readonly alias?: Local; readonly explicit?: string | undefined }',
      [mixed]: 'export const choose = (flag: boolean) => { if (flag) return 1; return; };',
    };
    const projects = { 'packages/exact/tsconfig.json': project(true), 'packages/legacy/tsconfig.json': project(false) };
    for (const [name, source] of Object.entries({ ...files, ...projects })) {
      const target = path.join(app, name);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, source);
    }
    const reference = execFileSync(
      process.execPath,
      [
        path.join(appRoot, 'tools/oxlint/effect-native/tests/reference-sonar.mjs'),
        path.join(app, 'packages'),
        'legacy/*.ts',
        'exact/*.ts',
      ],
      { encoding: 'utf-8' },
    );
    expect(reference.trim().split('\n').toSorted()).toEqual([
      'legacy/alias.ts sonarjs/no-redundant-optional',
      'legacy/mixed.ts sonarjs/no-inconsistent-returns',
    ]);
    // Neither an alias-provided undefined nor this compiler-valid mixed return is a .17 semantic diagnostic.
    const native = runHook(root, Object.keys(files), semanticJob);
    expect(native.output).toContain('Semantic lint checked 3 files');
    expect(native.status, native.output).toBe(0);
    // Check whether the *production* tsrs Oxlint backend independently closes either gap.
    const typed = runProductionOxlint(files, projects);
    expect(typed.diagnostics.filter(({ filename }) => filename === alias || filename === exact)).toEqual([]);
    expect(typed.diagnostics.filter(({ filename }) => filename === mixed).map(({ code }) => code)).toContain(
      'typescript(consistent-return)',
    );
  }, tmpdir());
});
