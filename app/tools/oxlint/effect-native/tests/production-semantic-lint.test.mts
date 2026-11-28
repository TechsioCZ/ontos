import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'effect-rstest';

import { appRoot } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

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
    const app = path.join(root, 'app');
    mkdirSync(app);
    symlinkSync(path.join(appRoot, 'node_modules'), path.join(app, 'node_modules'), 'dir');
    copyFileSync(path.join(appRoot, '..', 'lefthook.yml'), path.join(root, 'lefthook.yml'));
    writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'semantic-lint-control', private: true }));
    writeFileSync(
      path.join(app, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { noImplicitReturns: true, strict: true, target: 'ES2022' } }),
    );
    expect(spawnSync('/usr/bin/git', ['init', '--quiet'], { cwd: root }).status).toBe(0);
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
    const clean = runHook(root, files, 'semantic-lint');
    expect(clean.output).toContain('Semantic lint checked 5 files');
    expect(clean.status).toBe(0);
    put('apps/demo/src/option.ts', 'export interface Example { value?: string | undefined }');
    put('verticals/demo/src/returns.ts', 'export function choose(flag: boolean): number { if (flag) return 1; }');
    put(
      'packages/demo/src/membership.ts',
      'export const select = (keys: readonly string[], rows: string[]) => rows.filter(row => keys.includes(row));',
    );
    const invalid = runHook(root, files, 'semantic-lint');
    expect(invalid.status).toBe(1);
    for (const rule of ['redundant-optional-undefined', 'missing-return-value', 'repeated-array-membership']) {
      expect(invalid.output).toContain(rule);
    }
  }, tmpdir());
});

it('the production Oxlint hook blocks repeated flatMap and find lookups but accepts a Set', () => {
  withTemporaryWorkspace((root) => {
    const app = path.join(root, 'app');
    const source = 'packages/demo/src/select.ts';
    const target = path.join(app, source);
    mkdirSync(path.dirname(target), { recursive: true });
    for (const directory of ['tools', 'node_modules', 'apps']) {
      symlinkSync(path.join(appRoot, directory), path.join(app, directory), 'dir');
    }
    copyFileSync(path.join(appRoot, 'oxlint.config.ts'), path.join(app, 'oxlint.config.ts'));
    copyFileSync(path.join(appRoot, '..', 'lefthook.yml'), path.join(root, 'lefthook.yml'));
    writeFileSync(
      path.join(app, 'package.json'),
      JSON.stringify({ name: 'lookup-control', private: true, type: 'module' }),
    );
    writeFileSync(
      path.join(app, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022' }, include: [source] }),
    );
    expect(spawnSync('/usr/bin/git', ['init', '--quiet'], { cwd: root }).status).toBe(0);
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
