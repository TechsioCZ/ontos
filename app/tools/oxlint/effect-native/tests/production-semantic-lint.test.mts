import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'effect-rstest';

import { appRoot } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

it('the production hook selects each authored root and enforces the three semantic replacements', () => {
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
    const run = () => {
      const child = spawnSync(
        path.join(appRoot, 'node_modules/.bin/lefthook'),
        [
          'run',
          'pre-commit',
          '--job',
          'semantic-lint',
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
    for (const file of files) {
      put(file, 'export const control = 1;');
    }
    const clean = run();
    expect(clean.output).toContain('Semantic lint checked 5 files');
    expect(clean.status).toBe(0);
    put('apps/demo/src/option.ts', 'export interface Example { value?: string | undefined }');
    put('verticals/demo/src/returns.ts', 'export function choose(flag: boolean): number { if (flag) return 1; }');
    put(
      'packages/demo/src/membership.ts',
      'export const select = (keys: readonly string[], rows: string[]) => rows.filter(row => keys.includes(row));',
    );
    const invalid = run();
    expect(invalid.status).toBe(1);
    for (const rule of ['redundant-optional-undefined', 'missing-return-value', 'repeated-array-membership']) {
      expect(invalid.output).toContain(rule);
    }
  }, tmpdir());
});
