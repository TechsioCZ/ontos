import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'effect-rstest';

import { appRoot, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

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
    const modern = readFileSync(path.join(appRoot, owner, 'modern.config.ts'), 'utf-8');
    for (const file of ['package.json', 'modern.config.ts']) {
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

for (const suffix of ['vue', 'svelte', 'astro', 'md']) {
  it(`a ${suffix} edit ${suffix === 'md' ? 'does not enter' : 'changes'} the untouched importer's cycle graph`, () =>
    fixture((root) => {
      const target = 'entry.ts';
      const source = `import { panel } from './docs/Panel.${suffix}';\nexport const entry = panel;\n`;
      write(root, target, source);
      const wrap = (script: string) =>
        suffix === 'astro' ? `---\n${script}\n---\n` : `<script>\n${script}\n</script>\n`;
      write(root, `docs/Panel.${suffix}`, wrap('export const panel = 1;'));
      const configuration = path.join(root, 'import-config.json');
      writeFileSync(configuration, JSON.stringify({ plugins: ['import'], rules: { 'import/no-cycle': 'error' } }));
      expect(runOxlint(configuration, [target], root).exitCode).toBe(0);
      write(root, `docs/Panel.${suffix}`, wrap("import { entry } from '../entry';\nexport const panel = entry;"));
      const after = runOxlint(configuration, [target], root);
      expect(after.exitCode).toBe(suffix === 'md' ? 0 : 1);
      expect(after.diagnostics.map(({ code }) => code)).toEqual(suffix === 'md' ? [] : ['import(no-cycle)']);
      expect(readFileSync(path.join(root, target), 'utf-8')).toBe(source);
    }));
}

it('a package README symlink invalidates an untouched registered tooling command', () =>
  fixture((root) => {
    const owner = 'packages/tooling';
    const target = `${owner}/commands/audit.mts`;
    const source = `import { NodeServices } from '@effect/platform-node';
import { Effect, Exit, ManagedRuntime } from 'effect';
import { makeParser } from './parser.mts';
export const inspect = (source: string) => { const parser = makeParser(source); return parser.parse(); };
const main = Effect.gen(function* () { inspect('const value = 1'); });
const [, invokedPath] = process.argv;
if (invokedPath === import.meta.filename) {
  const runtime = ManagedRuntime.make(NodeServices.layer);
  const exit = await runtime.runPromiseExit(main);
  process.exitCode = Exit.isSuccess(exit) ? 0 : 1;
}`;
    write(root, target, source);
    write(
      root,
      `${owner}/package.json`,
      JSON.stringify({ name: 'tooling-owner', scripts: { audit: 'node ./commands/audit.mts' } }),
    );
    write(
      root,
      `${owner}/commands/parser.mts`,
      `import { parseSync } from 'oxc-parser';
export const makeParser = (source: string) => {
  const cache = new Map();
  return { parse: () => { cache.set(source, parseSync('input.ts', source)); return cache.get(source); } };
};`,
    );
    const configuration = path.join(root, 'tooling-config.json');
    writeFileSync(
      configuration,
      JSON.stringify({
        categories: { correctness: 'off' },
        jsPlugins: [{ name: 'anti-slop-effect', specifier: './tools/oxlint/anti-slop/effect/index.ts' }],
        rules: { 'anti-slop-effect/no-service-constructor-imports': 'error' },
      }),
    );
    const before = runOxlint(configuration, [target], root);
    expect(before.exitCode, JSON.stringify(before.diagnostics)).toBe(0);
    write(root, 'README.md', '# Repository\n');
    symlinkSync('../../README.md', path.join(root, owner, 'README.md'));
    const after = runOxlint(configuration, [target], root);
    expect(after.exitCode).toBe(1);
    expect(after.diagnostics.map(({ code }) => code)).toEqual(['anti-slop-effect(no-service-constructor-imports)']);
    expect(readFileSync(path.join(root, target), 'utf-8')).toBe(source);
  }));

it('a regular docs Markdown import can change an untouched service-constructor finding', () =>
  fixture((root) => {
    const target = 'packages/document-reader/src/runtime.ts';
    const source =
      "import { makeParser } from '../../../docs/parser.md';\nexport const parser = makeParser('value');\n";
    write(root, target, source);
    write(root, 'docs/parser.md', 'export const makeParser = (source) => ({ source });\n');
    const configuration = path.join(root, 'markdown-config.json');
    writeFileSync(
      configuration,
      JSON.stringify({
        categories: { correctness: 'off' },
        jsPlugins: [{ name: 'anti-slop-effect', specifier: './tools/oxlint/anti-slop/effect/index.ts' }],
        rules: { 'anti-slop-effect/no-service-constructor-imports': 'error' },
      }),
    );
    const before = runOxlint(configuration, [target], root);
    expect(before.exitCode, JSON.stringify(before.diagnostics)).toBe(0);
    write(
      root,
      'docs/parser.md',
      "import { Effect } from 'effect';\nexport const makeParser = () => Effect.succeed(1);\n",
    );
    const after = runOxlint(configuration, [target], root);
    expect(after.exitCode).toBe(1);
    expect(after.diagnostics.map(({ code }) => code)).toEqual(['anti-slop-effect(no-service-constructor-imports)']);
    expect(readFileSync(path.join(root, target), 'utf-8')).toBe(source);
  }));
