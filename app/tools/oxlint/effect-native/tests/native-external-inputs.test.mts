import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'effect-rstest';

import { appRoot, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const PACKAGE_MANIFEST = 'package.json';
const MODERN_CONFIGURATION = 'modern.config.ts';

const write = (root: string, file: string, source: string) => {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, source);
};

// Copy policy code, not symlink it: nativeScriptAppRoot must bind its registration proof to this
// fixture checkout. No production file is mutated, and every Oxlint invocation is one named file.
const fixture = (exercise: (root: string) => void) =>
  withTemporaryWorkspace((directory) => {
    const root = path.join(directory, 'app');
    mkdirSync(root);
    cpSync(path.join(appRoot, 'tools/oxlint'), path.join(root, 'tools/oxlint'), {
      filter: (source) => !source.includes(`${path.sep}tests${path.sep}`) && !source.endsWith(`${path.sep}tests`),
      recursive: true,
    });
    symlinkSync(path.join(appRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    for (const file of [
      'scripts/ci/ci-matrices.mts',
      'scripts/ci/ci-matrices-rules.mts',
      'scripts/quality-cli-lifecycle.mts',
    ]) {
      write(root, file, readFileSync(path.join(appRoot, file), 'utf-8'));
    }
    exercise(root);
  });

const config = (root: string, rule: string) => {
  const filename = path.join(root, '.oxlintrc.json');
  writeFileSync(
    filename,
    JSON.stringify({
      categories: { correctness: 'off' },
      jsPlugins: [{ name: 'effect-native', specifier: './tools/oxlint/effect-native/index.ts' }],
      rules: { [`effect-native/${rule}`]: 'error' },
    }),
  );
  return filename;
};

it('a Modern default-export-only edit changes lint of an untouched Facility Ops preview', () =>
  fixture((root) => {
    const owner = 'verticals/facility-operations';
    const target = `${owner}/src/ui/pdf-preview.tsx`;
    const modern = readFileSync(path.join(appRoot, owner, MODERN_CONFIGURATION), 'utf-8');
    for (const file of [PACKAGE_MANIFEST, MODERN_CONFIGURATION]) {
      write(root, `${owner}/${file}`, readFileSync(path.join(appRoot, owner, file), 'utf-8'));
    }
    const source = readFileSync(path.join(appRoot, target), 'utf-8');
    write(root, target, source);
    const configuration = config(root, 'no-ambient-process-env');
    const before = runOxlint(configuration, [target], root);
    expect(before.exitCode, JSON.stringify(before.diagnostics)).toBe(0);
    expect(modern).toContain('export default defineConfig(');
    write(
      root,
      `${owner}/modern.config.ts`,
      `${modern.replace('export default defineConfig(', 'const configuration = defineConfig(')}\nexport default configuration;\n`,
    );
    const after = runOxlint(configuration, [target], root);
    expect(after.exitCode).toBe(1);
    expect(after.diagnostics.map(({ code }) => code)).toEqual(['effect-native(no-ambient-process-env)']);
    expect(readFileSync(path.join(root, target), 'utf-8')).toBe(source);
  }));

it('a nested workspace package manifest edit changes lint of an untouched Facility Ops preview', () =>
  fixture((root) => {
    const owner = 'verticals/facility-operations';
    const target = `${owner}/src/ui/pdf-preview.tsx`;
    const manifest = readFileSync(path.join(appRoot, owner, PACKAGE_MANIFEST), 'utf-8');
    for (const file of [PACKAGE_MANIFEST, MODERN_CONFIGURATION]) {
      write(root, `${owner}/${file}`, readFileSync(path.join(appRoot, owner, file), 'utf-8'));
    }
    const source = readFileSync(path.join(appRoot, target), 'utf-8');
    write(root, target, source);
    const configuration = config(root, 'no-ambient-process-env');
    const before = runOxlint(configuration, [target], root);
    expect(before.exitCode, JSON.stringify(before.diagnostics)).toBe(0);
    expect(manifest).toContain('"@modern-js/runtime":');
    write(root, `${owner}/package.json`, manifest.replace('"@modern-js/runtime":', '"removed-runtime":'));
    const after = runOxlint(configuration, [target], root);
    expect(after.exitCode).toBe(1);
    expect(after.diagnostics.map(({ code }) => code)).toEqual(['effect-native(no-ambient-process-env)']);
    expect(readFileSync(path.join(root, target), 'utf-8')).toBe(source);
  }));

it('removing only a native test matrix invocation invalidates its untouched native imports', () =>
  fixture((root) => {
    const target = 'scripts/demo/symmy-demo-source-policies.test.mts';
    for (const file of [
      'rstest.config.ts',
      'scripts/ci-matrices.json',
      'scripts/ci-matrices.demo.json',
      '../.github/workflows/ultramodern-workspace-gates.yml',
    ]) {
      write(root, file, readFileSync(path.join(appRoot, file), 'utf-8'));
    }
    // The registration checks every registered file's existence, not its contents.
    const native = "import { test } from 'node:test'; import assert from 'node:assert/strict';\n";
    const registration = readFileSync(path.join(root, 'rstest.config.ts'), 'utf-8');
    for (const match of registration.matchAll(/'scripts\/[^']+\.test\.[cm]?[jt]s'/gu)) {
      write(root, match[0].slice(1, -1), native);
    }
    const source = readFileSync(path.join(appRoot, target), 'utf-8');
    write(root, target, source);
    const configuration = config(root, 'no-unregistered-native-test-imports');
    const before = runOxlint(configuration, [target], root);
    expect(before.exitCode, JSON.stringify(before.diagnostics)).toBe(0);
    const overlay = 'scripts/ci-matrices.demo.json';
    const matrix = readFileSync(path.join(root, overlay), 'utf-8');
    expect(matrix).toContain(` ${target}`);
    write(root, overlay, matrix.replace(` ${target}`, ''));
    const after = runOxlint(configuration, [target], root);
    expect(after.exitCode).toBe(1);
    expect(after.diagnostics.map(({ code }) => code)).toEqual([
      'effect-native(no-unregistered-native-test-imports)',
      'effect-native(no-unregistered-native-test-imports)',
    ]);
    expect(readFileSync(path.join(root, target), 'utf-8')).toBe(source);
  }));
